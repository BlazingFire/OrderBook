/**
 * What the company switches added on 2026-09-17 actually *do*.
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
import * as catalog from '../src/services/catalog.service.js';
import * as panels from '../src/services/panel.service.js';
import * as settings from '../src/services/settings.service.js';
import * as auth from '../src/services/auth.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

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
      await setUpFirstRun();
      await settings.writeSetting(actor, 'panels.autoPairingEnabled', false);
      panels.openPairingWindow();

      // The window is genuinely open: this is the setting refusing, not the
      // five-minute backstop having lapsed.
      expect(panels.isAcceptingPairing()).toBe(true);
      await expect(
        panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, '192.168.1.20'),
      ).rejects.toThrow(/only with the pairing password/i);

      // And a window that is not open says the other thing: open it.
      panels.closePairingWindow();
      await expect(
        panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, '192.168.1.20'),
      ).rejects.toThrow(/not accepting new panels/i);
    });

    it('answers discovery with the same "no", so no panel is invited to be refused', async () => {
      // `discovery/responder.ts` advertises `isAutoPairingOpen`. Advertising
      // the raw window instead would put "found, ready to pair" on a panel's
      // screen and then refuse the pairing it asked for.
      await setUpFirstRun();
      panels.openPairingWindow();

      expect(await panels.isAutoPairingOpen(actor.tenantId)).toBe(true);
      await settings.writeSetting(actor, 'panels.autoPairingEnabled', false);
      expect(await panels.isAutoPairingOpen(actor.tenantId)).toBe(false);
    });

    it('leaves manual pairing working, which is the whole point of turning it off', async () => {
      const credentials = await setUpFirstRun();
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

    /** Signs in as the main Server Master first-run created and returns a cookie-carrying agent. */
    async function signedIn() {
      const credentials = await setUpFirstRun();
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
      const credentials = await setUpFirstRun();
      await settings.writeSetting(actor, 'security.sessionHours', 1);

      const signedIn = await auth.signIn(credentials.username, credentials.password, 'browser', { onMasterPc: true });
      expect(signedIn.sessionTtlMs).toBe(60 * 60 * 1000);

      const response = await request(app)
        .post('/api/auth/sign-in')
        .send({ username: credentials.username, password: credentials.password })
        .expect(200);

      const cookie = (response.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookie).toMatch(/Max-Age=3600\b/);
    });

    it('uses the declared default when nobody has set it', async () => {
      const credentials = await setUpFirstRun();

      const signedIn = await auth.signIn(credentials.username, credentials.password, 'browser', { onMasterPc: true });

      expect(signedIn.sessionTtlMs).toBe(12 * 60 * 60 * 1000);
    });
  });

  describe('leads.packagingRequiredOnConvert', () => {
    /** A lead with one line and no packaging on it. */
    async function leadWithoutPackaging() {
      const party = await catalog.createParty({ name: 'Packless Traders' }, actor);
      const product = await catalog.createProduct(
        { name: 'Orissa Pan', categoryName: 'Pans', variants: [{ code: 'PKG-01' }] },
        actor,
      );
      const variant = product.variants[0]!;
      return leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, variantId: variant.id, quantity: 10 }],
        },
        actor,
      );
    }

    it('converts at the default — off since catalogue v2, whose lead entry never asks', async () => {
      const lead = await leadWithoutPackaging();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items[0]?.packaging ?? null).toBeNull();
    });

    it('refuses the conversion with the switch on', async () => {
      const lead = await leadWithoutPackaging();
      await settings.writeSetting(actor, 'leads.packagingRequiredOnConvert', true);

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(
        /packaging/i,
      );
    });

    it('converts with the switch off', async () => {
      const lead = await leadWithoutPackaging();
      await settings.writeSetting(actor, 'leads.packagingRequiredOnConvert', false);

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items[0]?.packaging ?? null).toBeNull();
    });

    it('refuses again when the switch is turned back on', async () => {
      // A reader that captured the value once at module load passes the case
      // above and fails this one, so this is what exercises the cache
      // invalidation on write.
      const lead = await leadWithoutPackaging();
      await settings.writeSetting(actor, 'leads.packagingRequiredOnConvert', false);
      await settings.writeSetting(actor, 'leads.packagingRequiredOnConvert', true);

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(/packaging/i);
    });

    it('leaves the other conversion guards alone with the switch off', async () => {
      const lead = await leadWithoutPackaging();
      await settings.writeSetting(actor, 'leads.packagingRequiredOnConvert', false);
      await orders.convertLead({ leadId: lead.id }, actor);

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(
        /already been converted/i,
      );
    });
  });

  describe('every switch reaches both channels', () => {
    it('answers the same on the signed-in user and in the snapshot', async () => {
      // Two call sites of one resolver. A switch wired into only one of them
      // works on the Master and does nothing on every panel, or the reverse.
      const credentials = await setUpFirstRun();
      await settings.writeSetting(actor, 'leads.followUpDefaultDays', 7);

      const signedIn = await auth.signIn(credentials.username, credentials.password, 'browser', { onMasterPc: true });
      expect(signedIn.user.features.followUpDefaultDays).toBe(7);

      expect((await buildSnapshot(actor)).features).toMatchObject({ followUpDefaultDays: 7 });
    });

    it('carries the notice board switches both ways, on by default (2026-10-08)', async () => {
      const credentials = await setUpFirstRun();
      expect((await buildSnapshot(actor)).features).toMatchObject({
        noticesOnHome: true,
        noticesAtSignIn: true,
      });

      await settings.writeSetting(actor, 'notices.showOnHome', false);
      await settings.writeSetting(actor, 'notices.showAtSignIn', false);

      const signedIn = await auth.signIn(credentials.username, credentials.password, 'browser', { onMasterPc: true });
      expect(signedIn.user.features).toMatchObject({ noticesOnHome: false, noticesAtSignIn: false });
      expect((await buildSnapshot(actor)).features).toMatchObject({
        noticesOnHome: false,
        noticesAtSignIn: false,
      });
    });

    it('answers the declared fallback when nothing has been set', async () => {
      const credentials = await setUpFirstRun();

      const signedIn = await auth.signIn(credentials.username, credentials.password, 'browser', { onMasterPc: true });
      // 3 since catalogue v2 (owner's decision, 2026-09-28); it was 0.
      expect(signedIn.user.features.followUpDefaultDays).toBe(3);
    });
  });
});
