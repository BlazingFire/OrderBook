/**
 * `20261007000000_backup_all_permission_grant` (1.3 Phase 8, migration #7):
 * `storage.backupAll` for the Server Master tier, and for nobody else.
 *
 * The migration has already run by the time these execute, so each test sets
 * a role up and calls `up()` again, which is also how idempotency is checked
 * (the pattern of `migration-grant.integration.test.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { minimumTierFor, PERMISSIONS } from '@orderbook/shared';

import { db } from '../src/db/knex.js';
import { up as grantBackupAll } from '../src/db/migrations/20261007000000_backup_all_permission_grant.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

const KEY = 'storage.backupAll';

async function insertRole(options: {
  tier: 'office' | 'management' | 'admin' | 'server_master';
  permissions: string[];
  deleted?: boolean;
}): Promise<string> {
  const id = `RL${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  await db()('roles').insert({
    id,
    tenant_id: await testTenantId(),
    name: `Test ${id}`,
    tier: options.tier,
    permissions: JSON.stringify(options.permissions),
    is_system: false,
    ...(options.deleted ? { deleted_at: db().fn.now() } : {}),
  });
  return id;
}

async function permissionsOf(id: string): Promise<string[]> {
  const row = await db()('roles').where({ id }).first<{ permissions: unknown }>('permissions');
  return Array.isArray(row?.permissions) ? (row.permissions as string[]) : [];
}

describe.skipIf(!canRunIntegrationTests)('backup-all permission grant (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('grants the key to a Server Master role, as a sorted union that keeps what it held', async () => {
    const id = await insertRole({ tier: 'server_master', permissions: ['users.manage', 'leads.view', 'leads.view'] });

    await grantBackupAll(db());

    expect(await permissionsOf(id)).toEqual(['leads.view', KEY, 'users.manage'].sort());
  });

  it('grants a soft-deleted Server Master role too', async () => {
    const id = await insertRole({ tier: 'server_master', permissions: ['leads.view'], deleted: true });

    await grantBackupAll(db());

    expect(await permissionsOf(id)).toContain(KEY);
  });

  it('leaves every other tier alone', async () => {
    const ids = await Promise.all(
      (['admin', 'management', 'office'] as const).map((tier) => insertRole({ tier, permissions: ['leads.view'] })),
    );

    await grantBackupAll(db());

    for (const id of ids) expect(await permissionsOf(id)).toEqual(['leads.view']);
  });

  it('takes the key off any other tier, as the live-catalogue Administrator seed leaves it', async () => {
    const id = await insertRole({ tier: 'admin', permissions: ['users.manage', KEY, 'leads.view'] });

    await grantBackupAll(db());

    expect(await permissionsOf(id)).toEqual(['leads.view', 'users.manage']);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const id = await insertRole({ tier: 'server_master', permissions: ['leads.view'] });

    await grantBackupAll(db());
    const first = await permissionsOf(id);
    await grantBackupAll(db());

    expect(await permissionsOf(id)).toEqual(first);
  });

  it('grants a real catalogue key whose ceiling is the Server Master tier', () => {
    // The migration inlines the key on purpose, so the test checks it against the live catalogue.
    expect(PERMISSIONS).toContain(KEY);
    expect(minimumTierFor(KEY)).toBe('server_master');
  });
});
