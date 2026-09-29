/**
 * Exercises the Master's HTTP surface the way its own browser UI uses it,
 * including the authentication guards — a missing `requireAuth` on a route
 * would expose shop data to anyone on the LAN, and unit tests on the services
 * would not catch that.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { canRunIntegrationTests } from './helpers/db.js';
import { config } from '../src/config/index.js';
import * as leads from '../src/services/lead.service.js';
import * as roles from '../src/services/role.service.js';
import * as users from '../src/services/user.service.js';
import { resetData, setupDatabase, teardownDatabase, stageIdByName, testActor } from './helpers/fixtures.js';
import { createApp } from '../src/http/app.js';
import { closePairingWindow } from '../src/services/panel.service.js';

let app: Express;

/** Signs in and returns an agent that carries the session cookie. */
async function signedInAgent(password: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username: 'admin', password }).expect(200);
  return agent;
}

async function initialize(): Promise<{ password: string; pairingPassword: string; masterUniqueId: string }> {
  const response = await request(app)
    .post('/api/setup/initialize')
    .send({ companyName: 'Shree Ceramics' })
    .expect(201);
  return response.body;
}

describe.skipIf(!canRunIntegrationTests)('master HTTP API (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    closePairingWindow();
  });

  describe('health', () => {
    it('is reachable without signing in, so a panel can check the master is up', async () => {
      const response = await request(app).get('/api/health').expect(200);
      expect(response.body.status).toBe('ok');
      expect(typeof response.body.hasNetworkLink).toBe('boolean');
    });

    it('tells a loopback caller what the process is holding right now', async () => {
      // Supertest connects over loopback, which is the only caller these are
      // answered to — how much memory the shop's Master is holding is not
      // something the LAN needs told.
      const response = await request(app).get('/api/health').expect(200);

      expect(response.body.runtime).toMatchObject({
        rssBytes: expect.any(Number),
        heapUsedBytes: expect.any(Number),
        sessions: expect.any(Number),
        panelSockets: expect.any(Number),
        adminSockets: expect.any(Number),
        changeRingSeq: expect.any(Number),
      });
    });
  });

  describe('the data directory is not served statically', () => {
    /**
     * `config.imagesDir` lives inside `config.uploadsDir`, so an
     * `express.static('/uploads')` mount handed out every product image variant
     * with no session, no `products.view` and no tenant check — routing straight
     * around `imageFilesRoutes` and `resolveImageFile`, whose documented job is
     * to answer 404 to a caller who may not see the product. It read as
     * harmless: the mount was annotated "unused by the pipeline", and it was,
     * until images were configured to write underneath it.
     */
    it('does not expose product image bytes through an unauthenticated /uploads mount', async () => {
      // A real file on disk, in the exact place the pipeline writes variants —
      // asserting on a made-up path would pass just as happily with the mount
      // restored, since `express.static` 404s what does not exist.
      const secret = Buffer.from('RIFF....WEBP not-really-an-image but uniquely identifiable');
      const onDisk = path.join(config.imagesDir, 'tenant-under-test', 'image-under-test');
      await mkdir(onDisk, { recursive: true });
      await writeFile(path.join(onDisk, 'master.webp'), secret);

      try {
        const response = await request(app).get('/uploads/images/tenant-under-test/image-under-test/master.webp');

        // The SPA fallback answers non-`/api` paths with index.html, so a 200 is
        // expected here — what must never happen is the *file's own bytes*
        // coming back, which is what an `express.static(uploadsDir)` mount did.
        expect(response.headers['content-type'] ?? '').not.toContain('image/webp');
        expect(response.body?.toString?.() ?? '').not.toContain('uniquely identifiable');
        expect(response.text ?? '').not.toContain('uniquely identifiable');
      } finally {
        await rm(path.join(config.imagesDir, 'tenant-under-test'), { recursive: true, force: true });
      }
    });
  });

  describe('setup', () => {
    it('reports an uninitialised master', async () => {
      await request(app).get('/api/setup/status').expect(200, { setupComplete: false });
    });

    it('initialises once and then refuses', async () => {
      await initialize();
      await request(app).get('/api/setup/status').expect(200, { setupComplete: true });
      await request(app).post('/api/setup/initialize').send({}).expect(409);
    });

    it('hides the identity endpoint behind sign-in', async () => {
      await initialize();
      await request(app).get('/api/setup/identity').expect(401);
    });

    it('returns the identity to a signed-in admin', async () => {
      const { password, masterUniqueId } = await initialize();
      const agent = await signedInAgent(password);

      const response = await agent.get('/api/setup/identity').expect(200);
      expect(response.body).toMatchObject({ masterUniqueId, companyName: 'Shree Ceramics' });
    });
  });

  describe('authentication', () => {
    it('rejects a wrong password with 401', async () => {
      await initialize();
      await request(app).post('/api/auth/sign-in').send({ username: 'admin', password: 'nope' }).expect(401);
    });

    it('rejects a malformed sign-in body with 400', async () => {
      await initialize();
      await request(app).post('/api/auth/sign-in').send({ username: 'admin' }).expect(400);
    });

    it('sets a session cookie and answers /me', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const response = await agent.get('/api/auth/me').expect(200);
      expect(response.body.user.username).toBe('admin');
    });

    it('stops answering /me after signing out', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      await agent.post('/api/auth/sign-out').expect(204);
      await agent.get('/api/auth/me').expect(401);
    });
  });

  describe('data endpoints require a session', () => {
    const guarded: Array<[string, string]> = [
      ['get', '/api/dashboard'],
      ['get', '/api/storage'],
      ['get', '/api/parties'],
      ['post', '/api/parties'],
      ['get', '/api/products'],
      ['post', '/api/products'],
      ['get', '/api/categories'],
      ['post', '/api/categories'],
      ['put', '/api/categories/PC0000000001'],
      ['delete', '/api/categories/PC0000000001'],
      ['get', '/api/leads/LD0000000001/pdf'],
      ['get', '/api/leads'],
      ['get', '/api/orders'],
      ['get', '/api/conflicts'],
      ['get', '/api/pipelines'],
      ['get', '/api/panels'],
      ['post', '/api/panels/pairing-window/open'],
      ['get', '/api/fields/catalogue'],
      ['get', '/api/fields/stages'],
      ['post', '/api/fields/values'],
    ];

    it.each(guarded)('%s %s returns 401 when signed out', async (method, path) => {
      await initialize();
      await (request(app) as never as Record<string, (p: string) => request.Test>)[method]!(path).expect(401);
    });
  });

  describe('parties and products', () => {
    it('creates and lists a party', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const created = await agent
        .post('/api/parties')
        .send({ name: 'Patel Tiles', phone: '9876543210', city: 'Morbi' })
        .expect(201);

      expect(created.body).toMatchObject({ partyCode: 'P-0001', name: 'Patel Tiles' });

      const list = await agent.get('/api/parties').expect(200);
      expect(list.body.total).toBe(1);
    });

    it('rejects a party with no name', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      await agent.post('/api/parties').send({ name: '' }).expect(400);
    });

    it('rejects a duplicate product code with 409', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const product = (code: string, name: string) => ({
        name,
        categoryName: 'Basins',
        variants: [{ code }],
      });
      await agent.post('/api/products').send(product('A1', 'One')).expect(201);
      await agent.post('/api/products').send(product('A1', 'Two')).expect(409);
    });

    it('runs categories — the owner’s Products — through create, list, edit and a refused delete', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const created = await agent
        .post('/api/categories')
        .send({ name: 'One Piece Toilet', code: 'OPT', sortOrder: 1 })
        .expect(201);
      await agent.post('/api/categories').send({ name: 'Again', code: 'opt' }).expect(409);
      await agent.post('/api/categories').send({ name: 'Bad', code: 'O-P' }).expect(400);

      await agent
        .post('/api/products')
        .send({ name: '102', categoryCode: 'OPT', variants: [{ code: '' }] })
        .expect(201);

      const list = await agent.get('/api/categories?search=opt').expect(200);
      expect(list.body).toMatchObject([{ code: 'OPT', subProductCount: 1 }]);

      const edited = await agent
        .put(`/api/categories/${created.body.id}`)
        .send({ sortOrder: 7 })
        .expect(200);
      expect(edited.body).toMatchObject({ code: 'OPT', sortOrder: 7 });

      // A live sub product sits under it.
      await agent.delete(`/api/categories/${created.body.id}`).expect(409);
    });

    it('filters parties by search term', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      await agent.post('/api/parties').send({ name: 'Patel Tiles' }).expect(201);
      await agent.post('/api/parties').send({ name: 'Rajesh Traders' }).expect(201);

      const filtered = await agent.get('/api/parties?search=patel').expect(200);
      expect(filtered.body.items).toHaveLength(1);
    });
  });

  describe('leads and orders', () => {
    /**
     * Leads are raised on the Office Panels, so these seed through the service
     * — the same path a panel's socket command takes — and then exercise what
     * the Master's own API is actually for: watching, progressing, converting
     * and dispatching.
     */
    async function seedLead(agent: ReturnType<typeof request.agent>) {
      const party = await agent.post('/api/parties').send({ name: 'Patel Tiles' }).expect(201);
      const product = await agent
        .post('/api/products')
        .send({
          name: 'Carrara White',
          categoryName: 'Tiles',
          variants: [{ code: 'GVT-01', weightKg: 20 }],
        })
        .expect(201);

      const lead = await leads.createLead(
        {
          partyId: party.body.id as string,
          items: [
            {
              productId: product.body.id as string,
              variantId: (product.body as { variants: Array<{ id: string }> }).variants[0]!.id,
              quantity: 12,
              packaging: 'carton',
            },
          ],
        },
        await testActor(),
      );

      return {
        partyId: party.body.id as string,
        productId: product.body.id as string,
        variantId: (product.body as { variants: Array<{ id: string }> }).variants[0]!.id,
        lead,
      };
    }

    it('raises a lead through POST /api/leads — the same service the panels use', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const seeded = await seedLead(agent);

      // Refused, not missing: an empty line set is a validation failure (400),
      // which proves the route exists and reaches the service.
      await agent.post('/api/leads').send({ partyId: 'x', items: [] }).expect(400);

      const created = await agent
        .post('/api/leads')
        .send({
          partyId: seeded.partyId,
          items: [
            {
              productId: seeded.productId,
              variantId: seeded.variantId,
              quantity: 2,
              packaging: 'carton',
            },
          ],
        })
        .expect(201);

      expect(created.body.id).toBe('LD0000000002');
      expect(created.body.items[0]).toMatchObject({ code: 'GVT-01', quantity: 2 });
    });

    it('serves the lead PDF inline, behind leads.export', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);

      const response = await agent
        .get(`/api/leads/${lead.id}/pdf`)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toMatch(/^inline; filename=".+\.pdf"$/);
      expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

      await agent.get('/api/leads/LD9999999999/pdf').expect(404);
    });

    it('lists open leads with their totals', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      await seedLead(agent);

      const response = await agent.get('/api/leads').expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        id: 'LD0000000001',
        totalWeightKg: 240,
        stageName: 'New',
      });
    });

    it('returns 404 for a lead that does not exist', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      await agent.get('/api/leads/LD0000009999').expect(404);
    });

    it('moves a lead to another stage', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);

      const stageId = await stageIdByName('lead', 'Quoted');
      const response = await agent
        .post(`/api/leads/${lead.id}/stage`)
        .send({ stageId })
        .expect(200);

      expect(response.body.stageName).toBe('Quoted');
    });

    it('rejects a stage change with no stage', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);

      await agent.post(`/api/leads/${lead.id}/stage`).send({}).expect(400);
    });

    it('converts a lead and then keeps the two lists apart', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);

      const order = await agent.post(`/api/leads/${lead.id}/convert`).send({}).expect(201);
      expect(order.body).toMatchObject({ id: 'OD0000000001', leadId: lead.id });

      // The lead leaves the open board but is still there when asked for.
      const open = await agent.get('/api/leads').expect(200);
      const all = await agent.get('/api/leads?includeConverted=true').expect(200);
      const orders = await agent.get('/api/orders').expect(200);

      expect(open.body.items).toHaveLength(0);
      expect(all.body.items).toHaveLength(1);
      expect(orders.body.items).toHaveLength(1);
    });

    it('refuses to convert the same lead twice', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);

      await agent.post(`/api/leads/${lead.id}/convert`).send({}).expect(201);
      await agent.post(`/api/leads/${lead.id}/convert`).send({}).expect(400);
    });

    it('dispatches an order and moves the stock ledger', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { variantId, lead } = await seedLead(agent);

      await agent.post('/api/stock/inbound').send({ variantId, quantityBoxes: 50 }).expect(200);

      const order = await agent.post(`/api/leads/${lead.id}/convert`).send({}).expect(201);

      // Reserved, not yet gone.
      const held = await agent.get('/api/stock').expect(200);
      expect(held.body[0]).toMatchObject({ quantityBoxes: 50, reservedBoxes: 12, availableBoxes: 38 });

      await agent.post(`/api/orders/${order.body.id}/dispatch`).send({}).expect(200);

      const after = await agent.get('/api/stock').expect(200);
      expect(after.body[0]).toMatchObject({ quantityBoxes: 38, reservedBoxes: 0 });
    });

    it('reports dashboard counts', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      await seedLead(agent);

      const response = await agent.get('/api/dashboard').expect(200);

      expect(response.body).toMatchObject({
        leadCount: 1,
        orderCount: 0,
        partyCount: 1,
        productCount: 1,
        lowStockCount: 0,
        followUpsDueCount: 0,
        openConflictCount: 0,
      });
    });
  });

  describe('search', () => {
    it('finds a product through the universal endpoint', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      await agent
        .post('/api/products')
        .send({ name: 'Cascade Basin', categoryName: 'Basins', variants: [{ code: 'SAN-77' }] })
        .expect(201);

      const response = await agent.get('/api/search?q=Cascade').expect(200);

      expect(response.body.some((hit: { kind: string }) => hit.kind === 'product')).toBe(true);
    });
  });

  describe('pairing endpoint', () => {
    it('is reachable without a session, since a new panel has no credentials yet', async () => {
      await initialize();
      // Refused on authorization grounds (401), not rejected as unauthenticated
      // access to the endpoint itself.
      await request(app)
        .post('/api/pairing/request')
        .send({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' })
        .expect(401);
    });

    it('rejects a malformed pairing request with 400', async () => {
      await initialize();
      await request(app).post('/api/pairing/request').send({ mode: 'sideways' }).expect(400);
    });

    it('pairs automatically once an admin opens the window', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      await agent.post('/api/panels/pairing-window/open').expect(200);

      const response = await request(app)
        .post('/api/pairing/request')
        .send({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' })
        .expect(201);

      expect(response.body.panelSecret).toBeTruthy();

      const panels = await agent.get('/api/panels').expect(200);
      expect(panels.body.panels).toHaveLength(1);
      expect(panels.body.panels[0]).toMatchObject({ name: 'Front Desk', status: 'active' });
    });

    it('pairs manually with the pairing password', async () => {
      const { pairingPassword } = await initialize();

      await request(app)
        .post('/api/pairing/request')
        .send({ mode: 'manual', panelName: 'Back Office', hostname: 'pc2', pairingPassword })
        .expect(201);
    });

    it('rejects manual pairing with a wrong password', async () => {
      await initialize();

      await request(app)
        .post('/api/pairing/request')
        .send({ mode: 'manual', panelName: 'X', hostname: 'pc2', pairingPassword: 'WRONG12345' })
        .expect(401);
    });

    it('revokes a panel', async () => {
      const { password, pairingPassword } = await initialize();
      const agent = await signedInAgent(password);

      const paired = await request(app)
        .post('/api/pairing/request')
        .send({ mode: 'manual', panelName: 'X', hostname: 'pc2', pairingPassword })
        .expect(201);

      await agent.post(`/api/panels/${paired.body.panelId}/revoke`).expect(200);

      const panels = await agent.get('/api/panels').expect(200);
      expect(panels.body.panels[0].status).toBe('revoked');
    });
  });

  describe('storage', () => {
    it('reports usage figures for the settings screen', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const response = await agent.get('/api/storage').expect(200);
      expect(response.body).toHaveProperty('databaseBytes');
      expect(response.body).toHaveProperty('uploadsBytes');
      expect(response.body.totalBytes).toBe(
        response.body.databaseBytes + response.body.uploadsBytes,
      );
    });

    /*
     * The figures sit on Settings › Storage, and the Settings nav entry is
     * shown only to `settings.manage` (`master/web/src/App.tsx`). The route
     * used to check nothing past the session, so anybody signed in — a
     * counter clerk included — could read how big the database and the
     * uploads are and how much disk the Master PC has left.
     */
    it('refuses the figures to somebody signed in without settings.manage', async () => {
      await initialize();
      const admin = await testActor();
      const desk = await roles.createRole(
        { name: 'Desk', tier: 'office', permissions: ['leads.view'] },
        admin,
      );
      await users.createUser(
        { username: 'meena', displayName: 'Meena Patel', roleId: desk.id, password: 'correct-horse' },
        admin,
      );

      const agent = request.agent(app);
      await agent.post('/api/auth/sign-in').send({ username: 'meena', password: 'correct-horse' }).expect(200);

      const response = await agent.get('/api/storage').expect(403);
      expect(response.body).toMatchObject({ error: 'forbidden', details: { permission: 'settings.manage' } });
    });
  });

  describe('updates', () => {
    /*
     * Two routers share the `/api/updates` prefix: the panels' routes (on their
     * pairing credentials) and the Master's own (on the browser session). The
     * panels' router used to guard itself with `.use(requirePanel)`, which ran
     * for every path under the prefix, so the Master's own Updates screen was
     * refused with "panel credentials invalid" before its router was reached.
     */
    it("answers the Master's own Updates screen on its session", async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const response = await agent.get('/api/updates/status').expect(200);
      expect(response.body).toHaveProperty('master');
      expect(response.body).toHaveProperty('office');
    });

    it('still refuses a signed-out caller', async () => {
      await initialize();
      await request(app).get('/api/updates/status').expect(401);
    });

    it("still keeps the panels' routes on panel credentials", async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      // A browser session is not a pairing: the office build is for panels.
      const response = await agent.get('/api/updates/office/latest').expect(401);
      expect(response.body.messageKey).toBe('error.unauthorized.panelCredentialsInvalid');
    });
  });

  describe('unknown API routes', () => {
    it('returns 404 JSON to a signed-in admin rather than the SPA shell', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const response = await agent.get('/api/nope').expect(404);
      expect(response.body.error).toBe('not_found');
    });

    it('returns 401 to a signed-out caller, without revealing whether the route exists', async () => {
      // The authenticated data router is mounted at /api, so anything it does
      // not match is still gated. That is deliberate: an unauthenticated
      // caller learns nothing about which endpoints are real.
      await initialize();
      await request(app).get('/api/nope').expect(401);
    });
  });
});
