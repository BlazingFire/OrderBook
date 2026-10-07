/**
 * Exercises the Master's HTTP surface the way its own browser UI uses it,
 * including the authentication guards — a missing `requireAuth` on a route
 * would expose shop data to anyone on the LAN, and unit tests on the services
 * would not catch that.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import type { Express } from 'express';

import { canRunIntegrationTests } from './helpers/db.js';
import { config } from '../src/config/index.js';
import * as catalog from '../src/services/catalog.service.js';
import * as imageService from '../src/services/image.service.js';
import * as leads from '../src/services/lead.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roles from '../src/services/role.service.js';
import * as users from '../src/services/user.service.js';
import {
  FIRST_RUN_ACCOUNTS,
  resetData,
  setupDatabase,
  teardownDatabase,
  stageIdByName,
  testActor,
} from './helpers/fixtures.js';
import { createApp } from '../src/http/app.js';
import { closePairingWindow } from '../src/services/panel.service.js';
import { resetRateLimits } from '../src/http/middleware/api-key-rate-limit.js';

let app: Express;

/** The main Server Master first-run creates; supertest is loopback, where a Server Master may sign in. */
const MAIN = FIRST_RUN_ACCOUNTS[0]!;

/** Signs in and returns an agent that carries the session cookie. */
async function signedInAgent(password: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username: MAIN.username, password }).expect(200);
  return agent;
}

async function initialize(): Promise<{ password: string; pairingPassword: string; masterUniqueId: string }> {
  const response = await request(app)
    .post('/api/setup/initialize')
    .send({ companyName: 'Shree Ceramics', accounts: FIRST_RUN_ACCOUNTS })
    .expect(201);
  return { ...response.body, password: MAIN.password };
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
    // This suite signs in hundreds of times a minute from one loopback address.
    resetRateLimits();
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

        // `/uploads/images` is the permission-checked image route, so a signed-out
        // caller gets its 401 JSON. What must never happen is the *file's own
        // bytes* coming back, which is what an `express.static(uploadsDir)`
        // mount did.
        expect(response.status).toBe(401);
        expect(response.headers['content-type'] ?? '').not.toContain('image/webp');
        expect(response.body?.toString?.() ?? '').not.toContain('uniquely identifiable');
        expect(response.text ?? '').not.toContain('uniquely identifiable');
      } finally {
        await rm(path.join(config.imagesDir, 'tenant-under-test'), { recursive: true, force: true });
      }
    });
  });

  describe('product image files at /uploads/images', () => {
    async function imageFixture() {
      const admin = await testActor();
      const product = await catalog.createProduct(
        { categoryName: 'Tiles', variants: [{ code: 'IMG-1' }], name: 'Glossy' },
        admin,
      );
      const source = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 120, b: 40 } } })
        .jpeg()
        .toBuffer();
      const updated = await imageService.uploadImage(
        { productId: product.id, fileBuffer: source, crop: { cropX: 0, cropY: 0, cropWidth: 400, cropHeight: 300, rotationDeg: 0 } },
        admin,
      );
      return { admin, imageId: updated.images[0]!.id, tenantDir: path.join(config.imagesDir, admin.tenantId) };
    }

    async function agentWith(permissions: string[], username: string) {
      const admin = await testActor();
      const role = await roles.createRole({ name: `Role ${username}`, tier: 'office', permissions }, admin);
      await users.createUser({ username, displayName: username, roleId: role.id, password: 'correct-horse' }, admin);
      const agent = request.agent(app);
      await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
      return agent;
    }

    it('is immutable under its versioned URL, carries a validator, and answers a repeat request with 304', async () => {
      const { imageId, tenantDir } = await imageFixture();
      try {
        const viewer = await agentWith(['products.view'], 'celia');
        for (const url of [`/uploads/images/${imageId}/thumb`, `/api/images/${imageId}/thumb`]) {
          const first = await viewer.get(url).expect(200);
          expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
          expect(first.headers.etag).toBeTruthy();
          expect(first.headers['last-modified']).toBeTruthy();

          await viewer.get(url).set('If-None-Match', first.headers.etag!).expect(304);
        }
      } finally {
        await rm(tenantDir, { recursive: true, force: true });
      }
    });

    it('serves image/webp to a user with products.view and 404 to one without', async () => {
      const { imageId, tenantDir } = await imageFixture();
      try {
        const viewer = await agentWith(['products.view'], 'vera');
        const ok = await viewer.get(`/uploads/images/${imageId}/thumb`).expect(200);
        expect(ok.headers['content-type']).toContain('image/webp');

        const blind = await agentWith(['leads.view'], 'blake');
        await blind.get(`/uploads/images/${imageId}/thumb`).expect(404);
      } finally {
        await rm(tenantDir, { recursive: true, force: true });
      }
    });

    it('answers a quiet 404, never cached, for a photo whose file is gone from disk', async () => {
      const { imageId, tenantDir } = await imageFixture();
      const errors = vi.spyOn(console, 'error');
      try {
        await rm(path.join(tenantDir, imageId), { recursive: true, force: true });
        const viewer = await agentWith(['products.view'], 'nadia');
        for (const url of [`/uploads/images/${imageId}/thumb`, `/api/images/${imageId}/large`]) {
          const missing = await viewer.get(url).expect(404);
          expect(missing.body.error).toBe('not_found');
          expect(missing.headers['cache-control'] ?? '').not.toContain('immutable');
          // Express's own weak tag on the JSON body is fine; the photo's checksum tag must be gone.
          expect(missing.headers.etag ?? '').not.toMatch(/^"[0-9a-f]{64}"$/);
        }
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
        await rm(tenantDir, { recursive: true, force: true });
      }
    });
  });

  describe('setup', () => {
    it('reports an uninitialised master', async () => {
      await request(app)
        .get('/api/setup/status')
        .expect(200, { setupComplete: false, onMasterPc: true, serverMasterSetupNeeded: false });
    });

    it('initialises once and then refuses', async () => {
      await initialize();
      await request(app)
        .get('/api/setup/status')
        .expect(200, {
          setupComplete: true,
          companyName: 'Shree Ceramics',
          onMasterPc: true,
          serverMasterSetupNeeded: false,
        });
      await request(app).post('/api/setup/initialize').send({}).expect(409);
    });

    it('hides the identity endpoint behind sign-in', async () => {
      await initialize();
      await request(app).get('/api/setup/identity').expect(401);
    });

    it('returns the identity to a signed-in Server Master', async () => {
      const { password, masterUniqueId } = await initialize();
      const agent = await signedInAgent(password);

      const response = await agent.get('/api/setup/identity').expect(200);
      expect(response.body).toMatchObject({ masterUniqueId, companyName: 'Shree Ceramics' });
    });
  });

  describe('authentication', () => {
    it('rejects a wrong password with 401', async () => {
      await initialize();
      await request(app).post('/api/auth/sign-in').send({ username: MAIN.username, password: 'nope' }).expect(401);
    });

    it('rejects a malformed sign-in body with 400', async () => {
      await initialize();
      await request(app).post('/api/auth/sign-in').send({ username: MAIN.username }).expect(400);
    });

    it('sets a session cookie and answers /me', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const response = await agent.get('/api/auth/me').expect(200);
      expect(response.body.user.username).toBe(MAIN.username);
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
      ['get', '/api/products/import/template.csv'],
      ['post', '/api/products/import'],
      ['get', '/uploads/images/IMG0000000001/thumb'],
      ['put', '/api/categories/PC0000000001'],
      ['delete', '/api/categories/PC0000000001'],
      ['get', '/api/leads/LD0000000001/pdf'],
      ['get', '/api/leads'],
      ['put', '/api/leads/LD0000000001'],
      ['get', '/api/lead-entry'],
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

    describe("a party's own records and access, for the Master's party screen", () => {
      async function agentWith(permissions: string[], username: string) {
        const admin = await testActor();
        const role = await roles.createRole({ name: `Role ${username}`, tier: 'office', permissions }, admin);
        await users.createUser(
          { username, displayName: username, roleId: role.id, password: 'correct-horse' },
          admin,
        );
        const agent = request.agent(app);
        await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
        return agent;
      }

      async function seedRecord() {
        const actor = await testActor();
        const party = await catalog.createParty({ name: 'Patel Tiles' }, actor);
        const product = await catalog.createProduct(
          { name: 'Carrara White', categoryName: 'Tiles', variants: [{ code: 'GVT-01' }] },
          actor,
        );
        await catalog.upsertVariant(
          { partyId: party.id, productId: product.id, alias: 'PW' },
          actor,
        );
        return { actor, party, product };
      }

      it('names the catalogue model with products.view, and sends null without it', async () => {
        await initialize();
        const { party } = await seedRecord();

        const viewer = await agentWith(['parties.view', 'products.view'], 'vera');
        const named = await viewer.get(`/api/parties/${party.id}/variants`).expect(200);
        expect(named.body).toMatchObject([{ alias: 'PW', catalogueName: 'Carrara White' }]);

        const blind = await agentWith(['parties.view'], 'blake');
        const unnamed = await blind.get(`/api/parties/${party.id}/variants`).expect(200);
        expect(unnamed.body).toMatchObject([{ alias: 'PW', catalogueName: null }]);
      });

      it('sends a null catalogue name once the product is deleted', async () => {
        await initialize();
        const { actor, party, product } = await seedRecord();
        await catalog.deleteProduct(product.id, actor);

        const viewer = await agentWith(['parties.view', 'products.view'], 'vera');
        const records = await viewer.get(`/api/parties/${party.id}/variants`).expect(200);

        expect(records.body).toMatchObject([{ catalogueName: null }]);
      });

      it("sends the caller's own grant on a party as myAccess, and the list rows carry it with a records count", async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        const { actor, party } = await seedRecord();
        const open = await admin.get(`/api/parties/${party.id}`).expect(200);
        expect(open.body.myAccess).toBeNull();

        const adminId = ((await admin.get('/api/auth/me').expect(200)).body as { user: { id: string } }).user.id;
        await partyAccess.replaceAssignments(
          party.id,
          { entries: [{ userId: adminId, level: 'manage' }], expectedVersion: open.body.sync.version },
          actor,
        );

        const granted = await admin.get(`/api/parties/${party.id}`).expect(200);
        expect(granted.body.myAccess).toBe('manage');

        const list = await admin.get('/api/parties').expect(200);
        expect(list.body.items).toMatchObject([{ id: party.id, recordCount: 1, myAccess: 'manage' }]);
      });

      it('serves the people list to a party.accessAll reader with the narrow shape, and refuses a user with neither key (403)', async () => {
        await initialize();
        // These two keys sit above the office and management ceilings, so the roles are admin tier.
        const adminWith = async (permissions: string[], username: string) => {
          const owner = await testActor();
          const role = await roles.createRole({ name: `Role ${username}`, tier: 'admin', permissions }, owner);
          await users.createUser(
            { username, displayName: username, roleId: role.id, password: 'correct-horse' },
            owner,
          );
          const agent = request.agent(app);
          await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
          return agent;
        };
        const reader = await adminWith(['party.accessAll'], 'reader');
        const editor = await adminWith(['party.assign'], 'editor');
        const stranger = await agentWith(['parties.view'], 'stranger');

        const forReader = await reader.get('/api/party-access/people').expect(200);
        expect(forReader.body.length).toBeGreaterThan(0);
        for (const person of forReader.body as Array<Record<string, unknown>>) {
          expect(Object.keys(person).sort()).toEqual(
            ['avatar', 'displayName', 'id', 'roleName', 'roleTier', 'username'].sort(),
          );
        }
        expect((await editor.get('/api/party-access/people').expect(200)).body).toEqual(forReader.body);

        const refused = await stranger.get('/api/party-access/people').expect(403);
        expect(refused.body).toMatchObject({ error: 'forbidden' });
      });

      it('shows the pairing window state (addresses, port, search status) only to panels.manage (Connection audit)', async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        const stranger = await agentWith(['parties.view'], 'stranger');

        const state = await admin.get('/api/panels/pairing-window').expect(200);
        expect(state.body).toMatchObject({ open: false, accepting: false, autoPairingEnabled: true });
        expect(Array.isArray(state.body.addresses)).toBe(true);
        expect(typeof state.body.port).toBe('number');
        expect(state.body.discovery).toHaveProperty('listening');

        await stranger.get('/api/panels/pairing-window').expect(403);
      });

      it('serves per-stage counts for leads and orders, before the :id routes, to people who may view them', async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        const leads = await admin.get('/api/leads/stage-counts').expect(200);
        const orders = await admin.get('/api/orders/stage-counts?search=zzz').expect(200);
        expect(leads.body).toEqual({ total: 0, counts: {} });
        expect(orders.body).toEqual({ total: 0, counts: {} });

        const blind = await agentWith(['parties.view'], 'blind');
        await blind.get('/api/orders/stage-counts').expect(403);
        await blind.get('/api/leads/stage-counts').expect(403);
      });

      it('serves the Party Access summary before :partyId, and a sorted list that survives a bad sort', async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        await seedRecord();

        // `summary` is a path, not a party id: it must answer counts, not 404 "Party".
        const counts = await admin.get('/api/party-access/summary').expect(200);
        expect(counts.body).toEqual({ total: 1, restricted: 0, open: 1 });

        await admin.get('/api/party-access?sort=city&dir=desc').expect(200);
        // Never a 500 from an unlisted column or direction.
        const odd = await admin.get('/api/party-access?sort=phone%3Bdrop&dir=sideways').expect(200);
        expect(odd.body.total).toBe(1);
      });
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

    describe('editing a lead and the form that reads from the Master', () => {
      /** Signs in as a user holding exactly `permissions`. */
      async function agentWith(permissions: string[], username = 'meena') {
        const admin = await testActor();
        const role = await roles.createRole(
          { name: `Role ${username}`, tier: 'office', permissions },
          admin,
        );
        await users.createUser(
          { username, displayName: username, roleId: role.id, password: 'correct-horse' },
          admin,
        );
        const agent = request.agent(app);
        await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
        return agent;
      }

      const line = (seeded: { productId: string; variantId: string }, quantity: number) => ({
        productId: seeded.productId,
        variantId: seeded.variantId,
        quantity,
        packaging: 'carton',
      });

      it('replaces the lines on PUT /api/leads/:id', async () => {
        const { password } = await initialize();
        const agent = await signedInAgent(password);
        const seeded = await seedLead(agent);

        const saved = await agent
          .put(`/api/leads/${seeded.lead.id}`)
          .send({ notes: 'ring back', items: [line(seeded, 7), line(seeded, 3)] })
          .expect(200);

        expect(saved.body.notes).toBe('ring back');
        expect(saved.body.items.map((item: { quantity: number }) => item.quantity)).toEqual([7, 3]);
        const read = await agent.get(`/api/leads/${seeded.lead.id}`).expect(200);
        expect(read.body.items).toHaveLength(2);
      });

      it('leaves the lines alone when the body carries none', async () => {
        const { password } = await initialize();
        const agent = await signedInAgent(password);
        const seeded = await seedLead(agent);

        const saved = await agent
          .put(`/api/leads/${seeded.lead.id}`)
          .send({ notes: 'only the note' })
          .expect(200);

        expect(saved.body.items).toHaveLength(1);
        expect(saved.body.items[0].quantity).toBe(12);
      });

      it('refuses an edit once the lead is converted (400 convertedLocked)', async () => {
        const { password } = await initialize();
        const agent = await signedInAgent(password);
        const seeded = await seedLead(agent);
        await agent.post(`/api/leads/${seeded.lead.id}/convert`).send({}).expect(201);

        const refused = await agent
          .put(`/api/leads/${seeded.lead.id}`)
          .send({ items: [line(seeded, 1)] })
          .expect(400);

        expect(JSON.stringify(refused.body)).toContain('convertedLocked');
      });

      it('refuses PUT without leads.edit (403)', async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        const seeded = await seedLead(admin);
        const desk = await agentWith(['leads.view', 'leads.create']);

        const refused = await desk
          .put(`/api/leads/${seeded.lead.id}`)
          .send({ notes: 'x' })
          .expect(403);

        expect(refused.body).toMatchObject({ error: 'forbidden', details: { permission: 'leads.edit' } });
      });

      it.each([
        ['an empty item list', []],
        ['items that are not a list', 'nonsense'],
        ['a line with no product', [{ variantId: 'x', quantity: 1 }]],
        ['a line with no variant', [{ productId: 'x', quantity: 1 }]],
      ])('answers %s with 400, not 500', async (_name, items) => {
        const { password } = await initialize();
        const agent = await signedInAgent(password);
        const seeded = await seedLead(agent);

        await agent.put(`/api/leads/${seeded.lead.id}`).send({ items }).expect(400);

        // And nothing was lost: the lead still has its line.
        const read = await agent.get(`/api/leads/${seeded.lead.id}`).expect(200);
        expect(read.body.items).toHaveLength(1);
      });

      it('answers GET /api/lead-entry with what the form reads', async () => {
        const { password } = await initialize();
        const agent = await signedInAgent(password);
        const seeded = await seedLead(agent);
        await catalog.upsertVariant(
          { partyId: seeded.partyId, productId: seeded.productId, alias: 'Carrara (Patel)' },
          await testActor(),
        );

        const view = await agent.get('/api/lead-entry').expect(200);

        // `owners` because a Server Master may raise an order for anybody.
        expect(Object.keys(view.body).sort()).toEqual(
          ['features', 'optionLists', 'owners', 'partyGrants', 'partyVariants', 'products'].sort(),
        );
        // The catalogue rides along so editing a multicolour line keeps its colour rule.
        expect(view.body.products.map((product: { id: string }) => product.id)).toContain(seeded.productId);
        expect(view.body.partyVariants).toEqual([
          expect.objectContaining({ partyId: seeded.partyId, alias: 'Carrara (Patel)' }),
        ]);
        expect(Array.isArray(view.body.optionLists)).toBe(true);
      });

      it('leaves products out without products.view', async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        await seedLead(admin);
        const desk = await agentWith(['leads.create']);

        const view = await desk.get('/api/lead-entry').expect(200);

        expect(view.body).not.toHaveProperty('products');
      });

      it('offers the Owner picker only to a caller who may name an owner', async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        const desk = await agentWith(['leads.create']);

        expect((await desk.get('/api/lead-entry').expect(200)).body).not.toHaveProperty('owners');

        const owners = (await admin.get('/api/lead-entry').expect(200)).body.owners as Array<{
          username: string;
        }>;
        expect(owners.map((owner) => owner.username)).toEqual(
          expect.arrayContaining([MAIN.username, 'meena']),
        );
      });

      it('refuses GET /api/lead-entry without leads.create or leads.edit (403)', async () => {
        await initialize();
        const desk = await agentWith(['leads.view', 'parties.view']);

        const refused = await desk.get('/api/lead-entry').expect(403);

        expect(refused.body).toMatchObject({ error: 'forbidden' });
      });

      it('leaves a restricted party’s own records out of the view', async () => {
        const { password } = await initialize();
        const admin = await signedInAgent(password);
        const seeded = await seedLead(admin);
        const actor = await testActor();
        const other = await catalog.createParty({ name: 'Open Traders' }, actor);
        await catalog.upsertVariant(
          { partyId: seeded.partyId, productId: seeded.productId, alias: 'Restricted alias' },
          actor,
        );
        await catalog.upsertVariant(
          { partyId: other.id, productId: seeded.productId, alias: 'Open alias' },
          actor,
        );
        // Patel Tiles is assigned to the administrator alone; Meena is not on it.
        const adminId = ((await admin.get('/api/auth/me').expect(200)).body as { user: { id: string } }).user.id;
        const patel = await catalog.getParty(seeded.partyId, actor);
        await partyAccess.replaceAssignments(
          seeded.partyId,
          { entries: [{ userId: adminId, level: 'manage' }], expectedVersion: patel.sync.version },
          actor,
        );
        const desk = await agentWith(['leads.create', 'parties.view']);

        const view = await desk.get('/api/lead-entry').expect(200);

        expect(view.body.partyVariants.map((variant: { alias: string }) => variant.alias)).toEqual([
          'Open alias',
        ]);
      });
    });

    it('dispatches an order', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);

      const order = await agent.post(`/api/leads/${lead.id}/convert`).send({}).expect(201);
      await agent.post(`/api/orders/${order.body.id}/dispatch`).send({}).expect(200);
      await agent.get('/api/stock').expect(404);
    });


    it('lists only converted leads for convertedOnly, which skips the open-board guard', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);

      // Nothing converted yet: the converted slice is empty while the board has it.
      const before = await agent.get('/api/leads?convertedOnly=true').expect(200);
      expect(before.body.items).toHaveLength(0);
      expect(before.body.total).toBe(0);

      await agent.post(`/api/leads/${lead.id}/convert`).send({}).expect(201);

      const converted = await agent.get('/api/leads?convertedOnly=true').expect(200);
      expect(converted.body.items.map((row: { id: string }) => row.id)).toEqual([lead.id]);
      expect(converted.body.total).toBe(1);
      // ...and it wins over includeConverted rather than contradicting it.
      const both = await agent.get('/api/leads?convertedOnly=true&includeConverted=true').expect(200);
      expect(both.body.items).toHaveLength(1);
    });

    it('filters the lead list by partyId', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { partyId } = await seedLead(agent);

      const mine = await agent.get(`/api/leads?partyId=${partyId}`).expect(200);
      expect(mine.body.items).toHaveLength(1);

      const other = await agent.get('/api/leads?partyId=no-such-party').expect(200);
      expect(other.body.items).toHaveLength(0);
      expect(other.body.total).toBe(0);
    });

    it('searches leads and orders by a line item, in words that must all match', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);
      const { lead } = await seedLead(agent);
      await agent.post(`/api/leads/${lead.id}/convert`).send({}).expect(201);
      // Seeded again, so there is an open lead on a second party to be excluded.
      const second = await agent.post('/api/parties').send({ name: 'Mehta Traders' }).expect(201);
      const product = await agent
        .post('/api/products')
        .send({ name: 'Slate Grey', categoryName: 'Stone', variants: [{ code: 'SLT-01', weightKg: 10 }] })
        .expect(201);
      const other = await leads.createLead(
        {
          partyId: second.body.id as string,
          items: [
            {
              productId: product.body.id as string,
              variantId: (product.body as { variants: Array<{ id: string }> }).variants[0]!.id,
              quantity: 3,
              packaging: 'carton',
            },
          ],
        },
        await testActor(),
      );

      // By product name: matches the line, not the party or the id.
      const leadsByProduct = await agent
        .get('/api/leads?includeConverted=true&search=carrara')
        .expect(200);
      expect(leadsByProduct.body.items.map((row: { id: string }) => row.id)).toEqual([lead.id]);

      const ordersByProduct = await agent.get('/api/orders?search=carrara').expect(200);
      expect(ordersByProduct.body.items).toHaveLength(1);
      expect((await agent.get('/api/orders?search=slate').expect(200)).body.items).toHaveLength(0);

      // By a line's code, and by packaging.
      expect((await agent.get('/api/leads?search=SLT-01').expect(200)).body.items).toHaveLength(1);
      expect((await agent.get('/api/leads?search=carton').expect(200)).body.items).toHaveLength(1);

      // Several words are ANDed, each anywhere on the record: party + product.
      const both = await agent.get('/api/leads?search=mehta%20slate').expect(200);
      expect(both.body.items.map((row: { id: string }) => row.id)).toEqual([other.id]);
      const crossed = await agent.get('/api/leads?search=mehta%20carrara').expect(200);
      expect(crossed.body.items).toHaveLength(0);

      // A typed % is not a wildcard.
      expect((await agent.get('/api/leads?search=%25').expect(200)).body.items).toHaveLength(0);
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

    it('reports the download, when GitHub was last asked, and the nightly update (1.4 R6, R7, R8)', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const { body } = await agent.get('/api/updates/status').expect(200);
      expect(body.download.master.phase).toBe('idle');
      expect(body.download.office.phase).toBe('idle');
      expect(body).toHaveProperty('lastCheckedAt');
      // On, at 23:00, until somebody changes it.
      expect(body.auto).toEqual({ enabled: true, time: '23:00', lastRun: null });
    });

    it('Check now answers the same shape for any signed-in person, and refuses a stranger', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const { body } = await agent.post('/api/updates/check').send({}).expect(200);
      expect(body).toHaveProperty('master');
      expect(body).toHaveProperty('download');
      expect(typeof body.lastCheckedAt === 'string' || body.lastCheckedAt === null).toBe(true);

      await request(app).post('/api/updates/check').send({}).expect(401);
    });

    it('lets an administrator set the nightly update and refuses a time that is not a time', async () => {
      const { password } = await initialize();
      const agent = await signedInAgent(password);

      const saved = await agent.put('/api/updates/auto').send({ enabled: false, time: '22:15' }).expect(200);
      expect(saved.body).toMatchObject({ enabled: false, time: '22:15' });
      expect((await agent.get('/api/updates/status').expect(200)).body.auto).toMatchObject({
        enabled: false,
        time: '22:15',
      });

      await agent.put('/api/updates/auto').send({ time: '25:61' }).expect(400);
      await request(app).put('/api/updates/auto').send({ enabled: true }).expect(401);

      // Back to the default, so a later test in this file sees what a fresh Master has.
      await agent.put('/api/updates/auto').send({ enabled: true, time: '23:00' }).expect(200);
    });

    it('tells its own shell, and only its own shell, whether a nightly install is due', async () => {
      await initialize();
      const local = await request(app).get('/api/health').expect(200);
      // Loopback (supertest connects locally): the key is there, and nothing is due.
      expect(local.body).toHaveProperty('autoUpdate', null);
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
