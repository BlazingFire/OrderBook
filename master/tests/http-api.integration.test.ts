/**
 * Exercises the Master's HTTP surface the way its own browser UI uses it,
 * including the authentication guards — a missing `requireAuth` on a route
 * would expose shop data to anyone on the LAN, and unit tests on the services
 * would not catch that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { canRunIntegrationTests } from './helpers/db.js';
import * as leads from '../src/services/lead.service.js';
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

      await agent.post('/api/products').send({ productCode: 'A1', name: 'One' }).expect(201);
      await agent.post('/api/products').send({ productCode: 'A1', name: 'Two' }).expect(409);
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
        .send({ productCode: 'GVT-01', name: 'Carrara White', rate: 45_000, weightKg: 20 })
        .expect(201);

      const lead = await leads.createLead(
        {
          partyId: party.body.id as string,
          items: [
            {
              productId: product.body.id as string,
              packaging: 'carton',
              quantities: [{ colour: 'Ivory', quantity: 12 }],
            },
          ],
        },
        await testActor(),
      );

      return { partyId: party.body.id as string, productId: product.body.id as string, lead };
    }

    it('has no endpoint for raising a lead — that belongs to the Office Panel', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      await agent.post('/api/leads').send({ partyId: 'x', items: [] }).expect(404);
    });

    it('lists open leads with their totals', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      await seedLead(agent);

      const response = await agent.get('/api/leads').expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        id: 'LD0000000001',
        totalAmount: 540_000,
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
      const { productId, lead } = await seedLead(agent);

      await agent
        .post('/api/stock/inbound')
        .send({ productId, colour: 'Ivory', quantityBoxes: 50 })
        .expect(200);

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
        .send({ productCode: 'SAN-77', name: 'Cascade Basin' })
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
