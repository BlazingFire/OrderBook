/**
 * The HTTP surface an Office Panel's server uses to import products.
 *
 * Mirrors `panel-image-route.integration.test.ts`: what is worth pinning is the
 * authentication, because it is the part that looks finished when it is not.
 * A route that verified only the panel's pairing secret would run the import
 * as the panel's own fallback role — which never holds `products.bulk` — and
 * put the machine's name in the audit trail instead of the person's.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import bcrypt from 'bcryptjs';

import { MAX_PRODUCT_IMPORT_BYTES } from '@orderbook/shared';

import { createApp } from '../src/http/app.js';
import { IMPORT_HEADERS } from '../src/domain/product-import.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as catalog from '../src/services/catalog.service.js';
import * as panelService from '../src/services/panel.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';

let app: Express;
let admin: ActorContext;
let panelId: string;

const PANEL_SECRET = 'panel-secret';

/** A paired panel whose own role holds only `products.view`. */
async function createPanel(): Promise<string> {
  const tenantId = await testTenantId();
  const desk = await roleService.createRole(
    { name: 'Desk', tier: 'office', permissions: ['products.view'] },
    admin,
  );

  const id = randomUUID();
  await panelRepo.insertPanel({
    id,
    tenant_id: tenantId,
    name: 'Front Desk',
    device_code: 'K7M2QX',
    secret_hash: await bcrypt.hash(PANEL_SECRET, 4),
    lan_ip: '192.168.1.20',
    status: 'active',
    paired_at: new Date(),
  });
  await db()('office_panels').where({ id }).update({ role_id: desk.id });
  return id;
}

/** Somebody signed in on the panel who may run an import. */
async function importerToken(): Promise<string> {
  const role = await roleService.createRole(
    {
      name: 'Catalogue manager',
      tier: 'management',
      permissions: ['products.view', 'products.create', 'products.edit', 'products.bulk'],
    },
    admin,
  );
  await userService.createUser(
    { username: 'sunita', displayName: 'Sunita Shah', roleId: role.id, password: 'correct-horse' },
    admin,
  );
  const { token } = await authService.signIn('sunita', 'correct-horse');
  return token;
}

function asPanel(req: request.Test, token?: string): request.Test {
  req.set('x-orderbook-panel-id', panelId).set('x-orderbook-panel-secret', PANEL_SECRET);
  return token ? req.set('x-orderbook-acting-token', token) : req;
}

describe.skipIf(!canRunIntegrationTests)('the panel catalogue import routes (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    panelService.closePairingWindow();
    admin = await testActor();
    panelId = await createPanel();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a request carrying no panel credentials at all', async () => {
    const response = await request(app).get('/api/panel/products/import/template.csv').expect(401);
    expect(response.body.error).toBe('unauthorized');

    await request(app)
      .post('/api/panel/products/import')
      .attach('file', Buffer.from('categoryName,name,code\r\nA,B,C\r\n'), 'a.csv')
      .expect(401);
  });

  it('refuses before the route reads anything — the guard sits in front of the router', async () => {
    // With no file either, the handler's own first check would answer 400: a
    // 401 naming the pairing means `requirePanel` ran before the upload was
    // parsed, not merely that the handler found no actor afterwards.
    const response = await request(app).post('/api/panel/products/import').expect(401);
    expect(response.body.messageKey).toBe('error.unauthorized.panelCredentialsInvalid');
  });

  it('refuses a wrong panel secret', async () => {
    await request(app)
      .get('/api/panel/products/import/template.csv')
      .set('x-orderbook-panel-id', panelId)
      .set('x-orderbook-panel-secret', 'not-the-secret')
      .expect(401);
  });

  it('refuses a presented acting token the Master will not honour, rather than running as the panel', async () => {
    // The panel's own role could not import either, so a downgrade would read
    // as a 403. A 401 naming the sign-in is what tells the panel to forget the
    // token and ask the person to sign in again.
    const response = await asPanel(
      request(app).get('/api/panel/products/import/template.csv'),
      'not-a-token-the-master-issued',
    ).expect(401);
    expect(response.body).toMatchObject({
      error: 'unauthorized',
      messageKey: 'error.unauthorized.signInFailed',
    });
  });

  /*
   * `/api/panel` carries two routers, images first. Each used to open with
   * its own `.use(requirePanel)`, and a router's `.use` runs for every request
   * that enters it whether or not one of its routes matches — so an import
   * paid for the panel check in the image router, fell through, and paid for
   * it again in this one: two bcrypt compares of the pairing secret, and two
   * resolutions of who is acting, per request.
   */
  it('authenticates the panel once per request, not once per router it passes through', async () => {
    const token = await importerToken();
    const authenticate = vi.spyOn(panelService, 'authenticatePanel');

    await asPanel(request(app).get('/api/panel/products/import/template.csv'), token).expect(200);

    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('runs as the panel itself when nobody is signed in — and that role may not import', async () => {
    const response = await asPanel(request(app).get('/api/panel/products/import/template.csv')).expect(403);
    expect(response.body).toMatchObject({ error: 'forbidden', details: { permission: 'products.bulk' } });
  });

  it('serves the CSV template as an attachment whose header row is the column labels', async () => {
    const token = await importerToken();
    const response = await asPanel(request(app).get('/api/panel/products/import/template.csv'), token).expect(200);

    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toBe('attachment; filename="products-template.csv"');
    expect(response.text.split('\r\n')[0]).toBe(IMPORT_HEADERS.join(','));
  });

  it('serves the Excel template', async () => {
    const token = await importerToken();
    const response = await asPanel(request(app).get('/api/panel/products/import/template.xlsx'), token)
      .buffer()
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers['content-type']).toMatch(/spreadsheetml/);
    expect(response.headers['content-disposition']).toBe('attachment; filename="products-template.xlsx"');
    expect((response.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('lets the panel export on its own role: seeing the catalogue is enough', async () => {
    await catalog.createProduct(
      { name: 'Ivory', categoryName: 'Basins', variants: [{ code: 'R-1' }] },
      admin,
    );

    const response = await asPanel(request(app).get('/api/panel/products/export.csv')).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="products-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = response.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(IMPORT_HEADERS.join(','));
    expect(lines[1]).toContain('Basins,Ivory');
    expect(lines[1]).toContain('R-1');

    const main = await asPanel(request(app).get('/api/panel/products/export.csv?level=main')).expect(200);
    expect(main.headers['content-disposition']).toMatch(/filename="main-products-\d{4}-\d{2}-\d{2}\.csv"/);

    const xlsx = await asPanel(request(app).get('/api/panel/products/export.xlsx'))
      .buffer()
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.headers['content-disposition']).toMatch(/filename="products-\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect((xlsx.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');

    await asPanel(request(app).get('/api/panel/products/export.pdf')).expect(400);
    await request(app).get('/api/panel/products/export.csv').expect(401);
  });

  it('refuses a template format it does not know', async () => {
    const token = await importerToken();
    await asPanel(request(app).get('/api/panel/products/import/template.pdf'), token).expect(400);
  });

  it('previews on dryRun without writing, then imports as the signed-in person', async () => {
    const token = await importerToken();
    const file = Buffer.from(
      'categoryName,name,code,size\r\nBasins,Ivory,R-1,18x12\r\nBasins,,R-2,18x12\r\n',
      'utf8',
    );

    const preview = await asPanel(request(app).post('/api/panel/products/import'), token)
      .field('dryRun', 'true')
      .attach('file', file, 'supplier.csv')
      .expect(200);
    expect(preview.body).toMatchObject({ dryRun: true, created: 1, failed: 1 });
    expect((await catalog.listProducts({}, admin)).total).toBe(0);

    const imported = await asPanel(request(app).post('/api/panel/products/import'), token)
      .field('dryRun', 'false')
      .attach('file', file, 'supplier.csv')
      .expect(200);
    expect(imported.body).toMatchObject({ dryRun: false, created: 1, failed: 1, mode: 'create' });
    expect((await catalog.listProducts({}, admin)).items[0]).toMatchObject({
      name: 'Ivory',
      categoryName: 'Basins',
      variants: [expect.objectContaining({ code: 'R-1' })],
      size: '18x12',
    });

    // The person, not the machine, is on the audit row.
    const [activity] = await db()('activity_log').where({ entity_type: 'catalog' });
    expect(activity).toMatchObject({ actor_type: 'user', actor_name: 'Sunita Shah' });
  });

  it('answers a file past the size ceiling with its own message, not the photo one', async () => {
    const token = await importerToken();
    const response = await asPanel(request(app).post('/api/panel/products/import'), token)
      .attach('file', Buffer.alloc(MAX_PRODUCT_IMPORT_BYTES + 1, 97), 'huge.csv')
      .expect(400);
    expect(response.body).toMatchObject({ error: 'validation_error', messageKey: 'validation.import.tooLarge' });
  });

  it('answers 400 with a named token when no file is attached', async () => {
    const token = await importerToken();
    const response = await asPanel(request(app).post('/api/panel/products/import'), token)
      .field('dryRun', 'true')
      .expect(400);
    expect(response.body).toMatchObject({
      error: 'validation_error',
      messageKey: 'validation.import.fileRequired',
    });
  });
});
