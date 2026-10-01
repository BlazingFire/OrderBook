/**
 * The product import for a signed-in Master user (session cookie), the same
 * handlers the paired-panel path uses (`panel-catalog-route.integration.test.ts`
 * pins that one). What matters here is the session guard and that the service
 * checks `products.bulk` against the signed-in person.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/http/app.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let app: Express;
let admin: ActorContext;

async function agentWith(permissions: string[], username: string) {
  const role = await roleService.createRole({ name: `Role ${username}`, tier: 'management', permissions }, admin);
  await userService.createUser(
    { username, displayName: username, roleId: role.id, password: 'correct-horse' },
    admin,
  );
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
  return agent;
}

const importer = () =>
  agentWith(['products.view', 'products.create', 'products.edit', 'products.bulk'], 'sunita');

describe.skipIf(!canRunIntegrationTests)('the session catalogue import routes (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('answers 401 with no session', async () => {
    await request(app).get('/api/products/import/template.csv').expect(401);
    await request(app)
      .post('/api/products/import')
      .attach('file', Buffer.from('categoryName,name,code\r\nA,B,C\r\n'), 'a.csv')
      .expect(401);
  });

  it('answers 403 naming products.bulk without that permission', async () => {
    const agent = await agentWith(['products.view', 'products.create'], 'meena');
    const response = await agent.get('/api/products/import/template.csv').expect(403);
    expect(response.body).toMatchObject({ error: 'forbidden', details: { permission: 'products.bulk' } });
    await agent
      .post('/api/products/import')
      .attach('file', Buffer.from('categoryName,name,code\r\nA,B,C\r\n'), 'a.csv')
      .expect(403);
  });

  it('serves the CSV template as an attachment', async () => {
    const agent = await importer();
    const response = await agent.get('/api/products/import/template.csv').expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toBe('attachment; filename="products-template.csv"');
    // The header row belongs to the import format, which changes on its own; only require one.
    expect(response.text.split('\r\n')[0]).not.toBe('');
  });

  it('serves the Excel template', async () => {
    const agent = await importer();
    const response = await agent
      .get('/api/products/import/template.xlsx')
      .buffer()
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(response.headers['content-type']).toMatch(/spreadsheetml/);
    expect((response.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('refuses a template format it does not know', async () => {
    const agent = await importer();
    await agent.get('/api/products/import/template.pdf').expect(400);
  });

  it('previews on dryRun without writing, then imports as the signed-in person', async () => {
    const agent = await importer();
    const file = Buffer.from('categoryName,name,code,size\r\nBasins,Ivory,R-1,18x12\r\nBasins,,R-2,18x12\r\n', 'utf8');

    const preview = await agent
      .post('/api/products/import')
      .field('dryRun', 'true')
      .attach('file', file, 'supplier.csv')
      .expect(200);
    expect(preview.body).toMatchObject({ dryRun: true, created: 1, failed: 1 });
    expect((await catalog.listProducts({}, admin)).total).toBe(0);

    const imported = await agent
      .post('/api/products/import')
      .field('dryRun', 'false')
      .attach('file', file, 'supplier.csv')
      .expect(200);
    expect(imported.body).toMatchObject({ dryRun: false, created: 1, failed: 1, mode: 'create' });
    expect((await catalog.listProducts({}, admin)).items[0]).toMatchObject({ name: 'Ivory', categoryName: 'Basins' });
  });

  it('answers 400 with a named token when no file is attached', async () => {
    const agent = await importer();
    const response = await agent.post('/api/products/import').field('dryRun', 'true').expect(400);
    expect(response.body).toMatchObject({ error: 'validation_error', messageKey: 'validation.import.fileRequired' });
  });
});
