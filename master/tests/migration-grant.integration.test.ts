/**
 * The Stage 7 permission grant (`docs/backend-modules/08-PERMISSIONS.md` §5).
 *
 * The migration has already run by the time any of these execute, so each test
 * sets a role up in the state it wants and calls `up()` again — which is also
 * how the idempotency gate is expressed, since a migration that is not safe to
 * re-run is a migration that cannot be tested this way at all.
 *
 * The gate that matters most is `GRANT-5`: a stored array containing a
 * **duplicate** must still be granted. `permissions` is JSONB and nothing in
 * the database forbids a repeat, so an implementation that compares
 * `merged.length === stored.length` reads such a row as "no change needed" and
 * skips it — reporting success while leaving the role without a single one of
 * the keys. That is the quietest failure in the batch, and it is invisible to
 * every other test here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up as grantNewModuleKeys } from '../src/db/migrations/20260309000000_new_module_permission_grant.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

/** Frozen here for the same reason the migration inlines them. */
const NEW_KEYS = [
  'documents.create',
  'documents.delete',
  'documents.edit',
  'documents.render',
  'documents.view',
  'fields.view',
  'logs.export',
  'logs.verifyChain',
  'logs.view',
  'recycleBin.view',
  'recycleBin.viewAll',
];

async function insertRole(options: {
  tier: 'office' | 'management' | 'admin';
  permissions: string[];
  deleted?: boolean;
}): Promise<string> {
  const tenantId = await testTenantId();
  const id = `RL${Math.random().toString(36).slice(2, 12).toUpperCase()}`;

  await db()('roles').insert({
    id,
    tenant_id: tenantId,
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

describe.skipIf(!canRunIntegrationTests)('new-module permission grant (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('GRANT-1: an admin role missing the new keys is granted every one of them', async () => {
    const id = await insertRole({ tier: 'admin', permissions: ['leads.view', 'users.manage'] });

    await grantNewModuleKeys(db());

    const granted = await permissionsOf(id);
    for (const key of NEW_KEYS) expect(granted, `missing ${key}`).toContain(key);
  });

  it('GRANT-2: it is idempotent — a second run changes nothing', async () => {
    const id = await insertRole({ tier: 'admin', permissions: ['leads.view'] });

    await grantNewModuleKeys(db());
    const first = await permissionsOf(id);

    await grantNewModuleKeys(db());
    const second = await permissionsOf(id);

    expect(second).toEqual(first);
  });

  it('GRANT-3: it is a union, not a replace — a hand-added key survives', async () => {
    const id = await insertRole({
      tier: 'admin',
      permissions: ['leads.view', 'stock.adjust', 'orders.dispatch'],
    });

    await grantNewModuleKeys(db());

    const granted = await permissionsOf(id);
    expect(granted).toContain('stock.adjust');
    expect(granted).toContain('orders.dispatch');
    expect(granted).toContain('documents.view');
  });

  it('GRANT-4: a management-tier role gains nothing — the no-wildcard rule', async () => {
    const id = await insertRole({ tier: 'management', permissions: ['leads.view'] });

    await grantNewModuleKeys(db());

    // Handing every role a new capability is exactly what the rule forbids: an
    // administrator ticks these in the grid deliberately, or nobody holds them.
    expect(await permissionsOf(id)).toEqual(['leads.view']);
  });

  it('GRANT-5: an admin role whose stored array holds a DUPLICATE is still granted', async () => {
    // A row that arrived over sync from an older replica, or was hand-edited.
    // A length-comparison no-op test reads this as "nothing to do" and skips
    // it, leaving the role without a single new key while reporting success.
    const id = await insertRole({
      tier: 'admin',
      permissions: ['leads.view', 'leads.view', 'users.manage'],
    });

    await grantNewModuleKeys(db());

    const granted = await permissionsOf(id);
    for (const key of NEW_KEYS) expect(granted, `missing ${key}`).toContain(key);
    // The union also cleaned the duplicate up, as a side effect.
    expect(granted.filter((key) => key === 'leads.view')).toHaveLength(1);
  });

  it('GRANT-6: a soft-deleted admin role is granted too, so a restore does not bring back a broken role', async () => {
    const id = await insertRole({ tier: 'admin', permissions: ['leads.view'], deleted: true });

    await grantNewModuleKeys(db());

    const granted = await permissionsOf(id);
    expect(granted).toContain('documents.view');
    expect(granted).toContain('logs.view');
  });

  it('GRANT-7: the result is sorted, matching how every other write stores the array', async () => {
    const id = await insertRole({ tier: 'admin', permissions: ['users.manage', 'leads.view'] });

    await grantNewModuleKeys(db());

    const granted = await permissionsOf(id);
    expect(granted).toEqual([...granted].sort());
  });

  it('GRANT-8: every key it grants is a real key in the live catalogue', async () => {
    // The migration inlines its list on purpose, which means the list can
    // drift out of the catalogue. It cannot import the catalogue to check —
    // that is the `20260301` defect — so the *test* does the comparison.
    const { PERMISSIONS } = await import('@orderbook/shared');

    for (const key of NEW_KEYS) {
      expect(PERMISSIONS as readonly string[], `${key} is not in the catalogue`).toContain(key);
    }
  });
});
