/**
 * Developer mode against a real database: the dummy users sign in with their
 * documented passwords, re-seeding re-arms an account somebody changed, and
 * the reset takes the Master back to first run over the HTTP route.
 *
 * The reset is the last test in the file on purpose. It drops the schema and
 * re-migrates, so the role and stage ids `fixtures.ts` captured at
 * `setupDatabase()` are stale afterwards; nothing here runs `resetData()` past
 * that point, and the next file's `setupDatabase()` captures afresh.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { DEVELOPER_TOKEN_HEADER, DUMMY_USERS } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { hashPassword } from '../src/lib/password.js';
import * as auth from '../src/services/auth.service.js';
import { seedDummyUsers } from '../src/services/developer.service.js';
import { isSetupComplete, runFirstTimeSetup } from '../src/services/setup.service.js';

const BUILT_IN_PASSWORD = 'Dev@OrderBook2026';

describe.skipIf(!canRunIntegrationTests)('developer mode (integration)', () => {
  let app: Express;

  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(resetData);

  describe('seedDummyUsers', () => {
    it('runs first-time setup on a blank Master and creates three users who can sign in', async () => {
      const result = await seedDummyUsers();

      expect(result.pairingPassword).toMatch(/^[A-Z2-9]{10}$/);
      expect(result.companyName).toBe('OrderBook Test Company');
      // Setup itself creates `admin`, so the dummy `admin` re-arms that row
      // rather than adding a second one — the documented password replaces
      // the generated one setup would have shown on screen.
      expect(result.users.map((u) => u.outcome)).toEqual(['reset', 'created', 'created']);
      expect(await isSetupComplete()).toBe(true);

      for (const spec of DUMMY_USERS) {
        const signedIn = await auth.signIn(spec.username, spec.password);
        expect(signedIn.user.roleTier).toBe(spec.tier);
      }
    });

    it('re-arms an existing user whose password was changed, and drops their session', async () => {
      await runFirstTimeSetup('Shree Ceramics');
      const first = await seedDummyUsers();
      expect(first.pairingPassword).toBeNull();
      expect(first.companyName).toBe('Shree Ceramics');

      const before = await auth.signIn('office', 'Office@1234');
      await db()('users')
        .where({ tenant_id: await testTenantId(), username: 'office' })
        .update({ password_hash: await hashPassword('Changed@1'), is_active: false });

      const second = await seedDummyUsers();
      expect(second.users.map((u) => u.outcome)).toEqual(['reset', 'reset', 'reset']);
      expect(await auth.resolveSession(before.token)).toBeNull();
      await expect(auth.signIn('office', 'Office@1234')).resolves.toBeTruthy();
    });
  });

  describe('routes', () => {
    async function signedInAgent() {
      const setup = await request(app)
        .post('/api/setup/initialize')
        .send({ companyName: 'Shree Ceramics' })
        .expect(201);
      const agent = request.agent(app);
      await agent.post('/api/auth/sign-in').send({ username: 'admin', password: setup.body.password }).expect(200);
      return agent;
    }

    it('needs a session before it will even talk about the password', async () => {
      await request(app).post('/api/developer/unlock').send({ password: BUILT_IN_PASSWORD }).expect(401);
    });

    it('unlocks, reports status by token, seeds, and locks', async () => {
      const agent = await signedInAgent();

      await agent.post('/api/developer/unlock').send({ password: 'wrong' }).expect(401);
      const unlock = await agent.post('/api/developer/unlock').send({ password: BUILT_IN_PASSWORD }).expect(201);
      const token: string = unlock.body.token;

      const status = await agent.get('/api/developer/status').set(DEVELOPER_TOKEN_HEADER, token).expect(200);
      expect(status.body).toMatchObject({ unlocked: true, expiresAt: unlock.body.expiresAt });
      const bare = await agent.get('/api/developer/status').expect(200);
      expect(bare.body.unlocked).toBe(false);

      await agent.post('/api/developer/seed-dummy-users').expect(401);
      const seeded = await agent.post('/api/developer/seed-dummy-users').set(DEVELOPER_TOKEN_HEADER, token).expect(201);
      expect(seeded.body.users).toHaveLength(3);

      // Seeding re-armed the very `admin` this agent signed in as, and a
      // session must not outlive its password — so the cookie is dead and the
      // documented password is what works now. The developer token is not a
      // session and survives.
      await agent.get('/api/developer/status').expect(401);
      const reArmed = request.agent(app);
      await reArmed.post('/api/auth/sign-in').send({ username: 'admin', password: 'Admin@1234' }).expect(200);
      const still = await reArmed.get('/api/developer/status').set(DEVELOPER_TOKEN_HEADER, token).expect(200);
      expect(still.body.unlocked).toBe(true);

      await reArmed.post('/api/developer/lock').set(DEVELOPER_TOKEN_HEADER, token).expect(200);
      const after = await reArmed.get('/api/developer/status').set(DEVELOPER_TOKEN_HEADER, token).expect(200);
      expect(after.body.unlocked).toBe(false);
    });

    // Last in the file — see the header.
    it('reset-all needs the token and the word, then leaves a first-run Master with its seeded roles', async () => {
      const agent = await signedInAgent();
      const unlock = await agent.post('/api/developer/unlock').send({ password: BUILT_IN_PASSWORD }).expect(201);
      const token: string = unlock.body.token;

      await agent.post('/api/developer/reset-all').send({ confirmation: 'RESET' }).expect(401);
      const refused = await agent
        .post('/api/developer/reset-all')
        .set(DEVELOPER_TOKEN_HEADER, token)
        .send({ confirmation: 'reset' })
        .expect(400);
      expect(refused.body.messageKey).toBe('validation.developer.confirmationRequired');
      expect(await isSetupComplete()).toBe(true);

      const reset = await agent
        .post('/api/developer/reset-all')
        .set(DEVELOPER_TOKEN_HEADER, token)
        .send({ confirmation: 'RESET' })
        .expect(200);
      expect(reset.body).toEqual({ ok: true, state: 'first-run' });

      expect(await isSetupComplete()).toBe(false);
      expect(await db()('users').count<{ count: string }[]>('id as count')).toEqual([{ count: '0' }]);
      const roles = await db()('roles').orderBy('name').pluck<string[]>('name');
      expect(roles).toEqual(['Admin', 'Management', 'Office']);
      // The session that asked for the reset is gone with everything else.
      await agent.get('/api/developer/status').expect(401);
    });
  });
});
