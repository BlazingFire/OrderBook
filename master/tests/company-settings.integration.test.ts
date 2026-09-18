/**
 * What the five company switches added on 2026-09-17 actually *do*.
 *
 * `settings.integration.test.ts` covers the settings table itself — reading,
 * writing, refusing, auditing. This file covers the other half, which is the
 * half that can rot silently: a switch that stores a value nothing reads looks
 * identical on screen to one that works.
 *
 * Every test here turns a switch away from its default and asserts the
 * behaviour changes, because the defaults are chosen to preserve what the
 * product did before the switch existed — so a test run entirely at the
 * defaults would pass against a switch that is wired to nothing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import type { ActorContext } from '../src/domain/actor.js';
import { createApp } from '../src/http/app.js';
import { db } from '../src/db/knex.js';
import * as catalog from '../src/services/catalog.service.js';
import { importProducts } from '../src/services/product-import.service.js';
import * as inventory from '../src/services/inventory.service.js';
import * as panels from '../src/services/panel.service.js';
import * as settings from '../src/services/settings.service.js';
import * as setup from '../src/services/setup.service.js';
import * as auth from '../src/services/auth.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;
let app: Express;

describe.skipIf(!canRunIntegrationTests)('company settings, end to end (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    panels.closePairingWindow();
    actor = await testActor();
  });

  describe('panels.autoPairingEnabled', () => {
    it('refuses an auto pairing even with the window open', async () => {
      await setup.runFirstTimeSetup(null);
      await settings.writeSetting(actor, 'panels.autoPairingEnabled', false);
      panels.openPairingWindow();

      // The window is genuinely open: this is the setting refusing, not the
      // five-minute backstop having lapsed.
      expect(panels.isAcceptingPairing()).toBe(true);
      await expect(
        panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, '192.168.1.20'),
      ).rejects.toThrow(/not accepting new panels/i);
    });

    it('answers discovery with the same "no", so no panel is invited to be refused', async () => {
      // `discovery/responder.ts` advertises `isAutoPairingOpen`. Advertising
      // the raw window instead would put "found, ready to pair" on a panel's
      // screen and then refuse the pairing it asked for.
      await setup.runFirstTimeSetup(null);
      panels.openPairingWindow();

      expect(await panels.isAutoPairingOpen(actor.tenantId)).toBe(true);
      await settings.writeSetting(actor, 'panels.autoPairingEnabled', false);
      expect(await panels.isAutoPairingOpen(actor.tenantId)).toBe(false);
    });

    it('leaves manual pairing working, which is the whole point of turning it off', async () => {
      const credentials = await setup.runFirstTimeSetup(null);
      await settings.writeSetting(actor, 'panels.autoPairingEnabled', false);

      const result = await panels.pairPanel(
        {
          mode: 'manual',
          panelName: 'Back Office',
          hostname: 'pc2',
          pairingPassword: credentials.pairingPassword,
          masterUniqueId: credentials.masterUniqueId,
        },
        '192.168.1.21',
      );

      expect(result.panelSecret).toBeTruthy();
    });
  });

  describe('security.developerModeEnabled', () => {
    const originalOverride = process.env.ORDERBOOK_DEVELOPER_PASSWORD;

    afterEach(() => {
      if (originalOverride === undefined) delete process.env.ORDERBOOK_DEVELOPER_PASSWORD;
      else process.env.ORDERBOOK_DEVELOPER_PASSWORD = originalOverride;
    });

    /** Signs in as the admin first-run created and returns a cookie-carrying agent. */
    async function signedIn() {
      const credentials = await setup.runFirstTimeSetup(null);
      const agent = request.agent(app);
      await agent
        .post('/api/auth/sign-in')
        .send({ username: credentials.username, password: credentials.password })
        .expect(200);
      return agent;
    }

    it('closes every developer route when off, and opens them again when on', async () => {
      delete process.env.ORDERBOOK_DEVELOPER_PASSWORD;
      const agent = await signedIn();

      await agent.get('/api/developer/status').expect(200);

      await settings.writeSetting(actor, 'security.developerModeEnabled', false);
      await agent.get('/api/developer/status').expect(401);
      await agent.post('/api/developer/unlock').send({ password: 'anything' }).expect(401);

      await settings.writeSetting(actor, 'security.developerModeEnabled', true);
      await agent.get('/api/developer/status').expect(200);
    });

    it('is overridden by ORDERBOOK_DEVELOPER_PASSWORD, so a machine is never locked out of itself', async () => {
      // The floor. An installation that turns developer mode off and then
      // loses everyone holding `settings.manage` has no other way back in.
      const agent = await signedIn();
      await settings.writeSetting(actor, 'security.developerModeEnabled', false);

      delete process.env.ORDERBOOK_DEVELOPER_PASSWORD;
      await agent.get('/api/developer/status').expect(401);

      process.env.ORDERBOOK_DEVELOPER_PASSWORD = 'a-password-set-on-this-machine';
      await agent.get('/api/developer/status').expect(200);
    });

    it('does not treat an empty override as set, which would open the door by accident', async () => {
      const agent = await signedIn();
      await settings.writeSetting(actor, 'security.developerModeEnabled', false);

      process.env.ORDERBOOK_DEVELOPER_PASSWORD = '';
      await agent.get('/api/developer/status').expect(401);
    });
  });

  describe('security.sessionHours', () => {
    it('stamps the session and the cookie from one number', async () => {
      // Two independent reads was the bug this replaced: the service stamped
      // the session from the setting while the route set the cookie from
      // `config.session.ttlMs`, so the browser forgot a session the server
      // still honoured, or kept one it had dropped.
      const credentials = await setup.runFirstTimeSetup(null);
      await settings.writeSetting(actor, 'security.sessionHours', 1);

      const signedIn = await auth.signIn(credentials.username, credentials.password, 'browser');
      expect(signedIn.sessionTtlMs).toBe(60 * 60 * 1000);

      const response = await request(app)
        .post('/api/auth/sign-in')
        .send({ username: credentials.username, password: credentials.password })
        .expect(200);

      const cookie = (response.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookie).toMatch(/Max-Age=3600\b/);
    });

    it('uses the declared default when nobody has set it', async () => {
      const credentials = await setup.runFirstTimeSetup(null);

      const signedIn = await auth.signIn(credentials.username, credentials.password, 'browser');

      expect(signedIn.sessionTtlMs).toBe(12 * 60 * 60 * 1000);
    });
  });

  describe('inventory.defaultReorderLevel', () => {
    /** 5 boxes on the floor, no reorder level of its own — the shape every movement creates. */
    async function seedBare() {
      const product = await catalog.createProduct(
        { productCode: 'FLR-01', name: 'Glazed 600x600', rate: 45_000, weightKg: 28 },
        actor,
      );
      await inventory.recordInbound(
        { productId: product.id, colour: 'Ivory', quantityBoxes: 5 },
        actor,
      );
      return product;
    }

    async function levelFor(productId: string) {
      const levels = await inventory.listStock({ limit: 100 }, actor);
      return levels.find((level) => level.productId === productId);
    }

    it('reaches the list, the low-only filter, the count and a single level alike', async () => {
      const product = await seedBare();

      expect(await levelFor(product.id)).toMatchObject({ isLow: false, reorderLevel: null });
      expect(await inventory.countLowStock(actor.tenantId)).toBe(0);
      expect(await inventory.listStock({ limit: 100, lowOnly: true }, actor)).toHaveLength(0);

      await settings.writeSetting(actor, 'inventory.defaultReorderLevel', 10);

      expect(await levelFor(product.id)).toMatchObject({ isLow: true, reorderLevel: null });
      expect(await inventory.countLowStock(actor.tenantId)).toBe(1);
      expect(await inventory.listStock({ limit: 100, lowOnly: true }, actor)).toHaveLength(1);

      // The single-level path — `setReorderLevel` returns through the same
      // `outgoing()` every list row goes through.
      const single = await inventory.setReorderLevel(
        { productId: product.id, colour: 'Ivory', reorderLevel: null },
        actor,
      );
      expect(single).toMatchObject({ isLow: true, reorderLevel: null });
    });

    it('never overrides a level somebody set on the line itself', async () => {
      const product = await seedBare();
      await settings.writeSetting(actor, 'inventory.defaultReorderLevel', 10);
      await inventory.setReorderLevel(
        { productId: product.id, colour: 'Ivory', reorderLevel: 2 },
        actor,
      );

      // 5 boxes against a line level of 2 is not low, even though the company
      // default of 10 would say it is.
      expect(await levelFor(product.id)).toMatchObject({ isLow: false, reorderLevel: 2 });
      expect(await inventory.countLowStock(actor.tenantId)).toBe(0);
    });

    it('counts a line that has run out when the default is zero', async () => {
      // `Number(null)` is 0, so a count that coerces the absent column reads
      // "no default" and "flag anything empty" as the same thing. Only a line
      // at zero is low here — the 5-box line is not.
      const product = await seedBare();
      const empty = await catalog.createProduct(
        { productCode: 'FLR-02', name: 'Matt 300x300', rate: 22_000, weightKg: 18 },
        actor,
      );
      await inventory.recordInbound({ productId: empty.id, colour: 'Ivory', quantityBoxes: 3 }, actor);
      await inventory.recordAdjustment(
        { productId: empty.id, colour: 'Ivory', quantityBoxes: 0, note: 'counted' },
        actor,
      );

      await settings.writeSetting(actor, 'inventory.defaultReorderLevel', 0);

      expect(await levelFor(product.id)).toMatchObject({ isLow: false });
      expect(await levelFor(empty.id)).toMatchObject({ isLow: true });
      expect(await inventory.countLowStock(actor.tenantId)).toBe(1);
    });
  });

  describe('catalog.importCreatesCategories', () => {
    function csv(rows: Array<Array<string | number>>): { buffer: Buffer; fileName: string } {
      return {
        buffer: Buffer.from(rows.map((row) => row.map(String).join(',')).join('\r\n') + '\r\n', 'utf8'),
        fileName: 'supplier.csv',
      };
    }

    const FILE = csv([
      ['productCode', 'name', 'categoryName'],
      ['GVT-1', 'Carrara White', 'Vitrified'],
      ['GVT-2', 'Statuario', ''],
    ]);

    it('refuses the row naming a category the company does not have, and invents nothing', async () => {
      await settings.writeSetting(actor, 'catalog.importCreatesCategories', false);

      const result = await importProducts(FILE, { dryRun: false, mode: 'create' }, actor);

      expect(result.issues).toEqual([
        {
          row: 2,
          kind: 'error',
          column: 'categoryName',
          messageKey: 'validation.import.unknownCategory',
          params: { categoryName: 'Vitrified' },
        },
      ]);
      expect(result.failed).toBe(1);
      // The row is refused, not filed under no category: nothing of it landed.
      expect(result.created).toBe(1);
      expect(await catalog.listCategories(actor)).toEqual([]);
      const codes = (await db()('products').select('product_code')).map((row) => row.product_code);
      expect(codes).toEqual(['GVT-2']);
    });

    it('gives the preview and the commit the same answer about the same row', async () => {
      await settings.writeSetting(actor, 'catalog.importCreatesCategories', false);

      const preview = await importProducts(FILE, { dryRun: true, mode: 'create' }, actor);
      const commit = await importProducts(FILE, { dryRun: false, mode: 'create' }, actor);

      // The defect this switch could introduce: a preview that says "ok" and a
      // commit that refuses. Both passes must name row 2 and count it the same.
      expect(preview.issues).toEqual(commit.issues);
      expect(preview.created).toBe(commit.created);
      expect(preview.failed).toBe(commit.failed);
      // And the preview wrote nothing while establishing that.
      expect(await catalog.listCategories(actor)).toEqual([]);
    });

    it('refuses an unknown category on the upsert path too, where a second repository call creates one', async () => {
      // `updateProduct` resolves a free-text category through
      // `resolveCategoryId`, which creates it — a second invention site, on a
      // path the chunked create never touches.
      await catalog.createProduct({ productCode: 'GVT-1', name: 'Carrara White' }, actor);
      await settings.writeSetting(actor, 'catalog.importCreatesCategories', false);

      const result = await importProducts(FILE, { dryRun: false, mode: 'upsert' }, actor);

      expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
        [2, 'validation.import.unknownCategory'],
      ]);
      expect(result.updated).toBe(0);
      expect(await catalog.listCategories(actor)).toEqual([]);
    });

    it('accepts the row once the category exists, matching case-insensitively', async () => {
      // Created by an earlier import, while the switch was still on — and
      // spelt differently, because the match is on `lower(name)`, the same
      // rule `ensureCategories` already uses.
      await importProducts(
        csv([
          ['productCode', 'name', 'categoryName'],
          ['OLD-1', 'Ivory Matt', 'VITRIFIED'],
        ]),
        { dryRun: false, mode: 'create' },
        actor,
      );
      await settings.writeSetting(actor, 'catalog.importCreatesCategories', false);

      const result = await importProducts(FILE, { dryRun: false, mode: 'create' }, actor);

      expect(result.issues).toEqual([]);
      expect(result.created).toBe(2);
      expect(await catalog.listCategories(actor)).toHaveLength(1);
    });

    it('creates the category at its default, so an upgraded installation imports exactly as before', async () => {
      const result = await importProducts(FILE, { dryRun: false, mode: 'create' }, actor);

      expect(result.issues).toEqual([]);
      expect(result.created).toBe(2);
      expect((await catalog.listCategories(actor)).map((category) => category.name)).toEqual([
        'Vitrified',
      ]);
    });
  });
});
