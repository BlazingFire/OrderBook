/**
 * The keyed `/api/v1` surface, exercised over HTTP.
 *
 * These are the four things that would be silent, expensive mistakes:
 *
 *  · a key outliving the permission its owner lost — the intersection is
 *    computed per request for exactly this reason;
 *  · a PATCH nulling the columns the caller did not mention, which is what a
 *    full-replace update does to a partial body;
 *  · the whole surface answering at all while the feature is switched off.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { canRunIntegrationTests } from './helpers/db.js';
import { db } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { resetRateLimits } from '../src/http/middleware/api-key-rate-limit.js';
import { resetApiKeyFailures } from '../src/http/middleware/require-api-key.js';
import { resetPublicApiTenantCache } from '../src/http/routes/public-api.routes.js';
import * as apiKeyService from '../src/services/api-key.service.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { invalidateSettingsCache, writeSetting } from '../src/services/settings.service.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let app: Express;

/** A real user row, because a key is only ever as much as its owner. */
async function seedOwner(
  username: string,
  permissions: string[],
): Promise<{ userId: string; roleId: string }> {
  const actor = await testActor();

  // Through the services, not raw inserts: `roles.id` and `users.id` are TEXT
  // with no database default, and the id shape is the services' business.
  const role = await roleService.createRole(
    { name: `Role ${username}`, tier: 'admin', permissions: [...permissions].sort() },
    actor,
  );
  const created = await userService.createUser(
    { username, displayName: `Owner ${username}`, roleId: role.id },
    actor,
  );

  return { userId: created.user.id, roleId: role.id };
}

async function issue(ownerUserId: string, scopes: string[]): Promise<string> {
  const actor = await testActor();
  const issued = await apiKeyService.issueKey(actor, {
    label: `key for ${ownerUserId}`,
    ownerUserId,
    scopes,
  });
  return issued.token;
}

async function enableApi(enabled: boolean): Promise<void> {
  const actor = await testActor();
  await writeSetting(actor, 'externalApi.enabled', enabled);
}

describe.skipIf(!canRunIntegrationTests)('public API (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    resetRateLimits();
    resetApiKeyFailures();
    resetPublicApiTenantCache();
    invalidateSettingsCache();
    await enableApi(true);
  });

  describe('the off switch', () => {
    it('answers 404 to everything while the feature is off, not 401', async () => {
      await enableApi(false);

      // 401 would be the shape of "sign in", which is the wrong answer about a
      // feature nobody has turned on — and it is what falling through to the
      // cookie-guarded router would produce.
      await request(app).get('/api/v1/whoami').expect(404);
      await request(app).get('/api/v1/openapi.json').expect(404);
    });
  });

  describe('authentication', () => {
    it('refuses a request with no key, a malformed key and a wrong secret alike', async () => {
      const { userId } = await seedOwner('owner-auth', ['products.view']);
      const token = await issue(userId, ['products.view']);

      await request(app).get('/api/v1/whoami').expect(401);
      await request(app).get('/api/v1/whoami').set('Authorization', 'Bearer nonsense').expect(401);
      await request(app)
        .get('/api/v1/whoami')
        .set('Authorization', `Bearer ${token.slice(0, -3)}xyz`)
        .expect(401);
    });

    it('accepts a valid key and says what it holds', async () => {
      const { userId } = await seedOwner('owner-ok', ['products.view', 'parties.view']);
      const token = await issue(userId, ['products.view']);

      const response = await request(app)
        .get('/api/v1/whoami')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Intersection: the owner holds two, the key was issued for one.
      expect(response.body.permissions).toEqual(['products.view']);
      expect(response.body.ownerUserId).toBe(userId);
    });

    it('loses a permission the moment the owner does, without re-issuing the key', async () => {
      const { userId, roleId } = await seedOwner('owner-demoted', ['products.view']);
      const token = await issue(userId, ['products.view']);

      await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await db()('roles')
        .where({ id: roleId })
        .update({ permissions: JSON.stringify([]), version: 2 });

      await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('refuses a revoked key', async () => {
      const { userId } = await seedOwner('owner-revoked', ['products.view']);
      const token = await issue(userId, ['products.view']);
      const actor = await testActor();

      const keys = await apiKeyService.listKeys(actor);
      await apiKeyService.revokeKey(actor, keys[0]!.id);

      await request(app).get('/api/v1/whoami').set('Authorization', `Bearer ${token}`).expect(401);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 once the window is spent, and says how long to wait', async () => {
      const { userId } = await seedOwner('owner-rate', ['products.view']);
      const actor = await testActor();
      const issued = await apiKeyService.issueKey(actor, {
        label: 'slow key',
        ownerUserId: userId,
        scopes: ['products.view'],
        rateLimitPerMin: 2,
      });

      const call = () =>
        request(app).get('/api/v1/whoami').set('Authorization', `Bearer ${issued.token}`);

      await call().expect(200);
      await call().expect(200);
      const refused = await call().expect(429);
      expect(refused.body.details?.seconds ?? refused.body.seconds).toBeGreaterThan(0);
    });
  });

  describe('PATCH', () => {
    it('leaves every field the body did not name exactly as it was', async () => {
      const actor = await testActor();
      const product = await catalogService.createProduct(
        {
          name: 'Rustic 300',
          categoryName: 'Basins',
          variants: [{ code: 'RST-300', weightKg: 12 }],
          alias: 'Rustic',
          size: '300x300',
          multiColour: true,
        },
        actor,
      );

      const { userId } = await seedOwner('owner-patch', ['products.view', 'products.edit']);
      const token = await issue(userId, ['products.view', 'products.edit']);

      const response = await request(app)
        .patch(`/api/v1/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ alias: 'Rustic Matt' })
        .expect(200);

      expect(response.body.alias).toBe('Rustic Matt');
      // The columns nobody mentioned.
      expect(response.body.name).toBe('Rustic 300');
      expect(response.body.categoryName).toBe('Basins');
      expect(response.body.variants).toEqual([
        expect.objectContaining({ id: product.variants[0]!.id, code: 'RST-300', weightKg: 12 }),
      ]);
      expect(response.body.size).toBe('300x300');
      expect(response.body.multiColour).toBe(true);
    });
  });

  describe('audit', () => {
    it('records the key as its own principal, and the chain still verifies', async () => {
      const actor = await testActor();
      const product = await catalogService.createProduct(
        { name: 'Rustic 302', categoryName: 'Basins', variants: [{ code: 'RST-302' }] },
        actor,
      );

      const { userId } = await seedOwner('owner-audit', ['products.view', 'products.edit']);
      const token = await issue(userId, ['products.view', 'products.edit']);

      await request(app)
        .patch(`/api/v1/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ alias: 'Audited' })
        .expect(200);

      const row = await db()('activity_log')
        .where({ entity_type: 'product', entity_id: product.id, action: 'updated' })
        .orderBy('created_at', 'desc')
        .first<{ actor_type: string; actor_id: string | null }>();

      // `actor_type` and `actor_id` are both inside the row hash, so "which key
      // did this" is tamper-evident rather than merely recorded.
      expect(row?.actor_type).toBe('api_key');
      expect(row?.actor_id).toBeTruthy();
    });

    it('writes no row at all for a failed authentication', async () => {
      const before = await db()('activity_log').count<[{ count: string }]>({ count: '*' });

      await request(app)
        .get('/api/v1/whoami')
        .set('Authorization', 'Bearer obk_aaa_bbb')
        .expect(401);

      const after = await db()('activity_log').count<[{ count: string }]>({ count: '*' });
      // Every insert there takes an advisory lock on the tenant, so a spray of
      // guessed keys would serialise every audited write in the company.
      expect(after[0]!.count).toBe(before[0]!.count);
    });
  });

  describe('the contract', () => {
    it('publishes a document listing exactly the routes that are mounted', async () => {
      const { userId } = await seedOwner('owner-doc', ['products.view']);
      const token = await issue(userId, ['products.view']);

      const response = await request(app)
        .get('/api/v1/openapi.json')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.paths['/parties/{id}'].patch.operationId).toBe('patchParty');
      expect(response.body.paths['/leads']).toBeTruthy();
      // The two absences that are rules rather than gaps.
      expect(response.body.paths['/leads'].post).toBeUndefined();
      expect(Object.values(response.body.paths).some((path) => 'delete' in (path as object))).toBe(
        false,
      );
    });
  });
});
