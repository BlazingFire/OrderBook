/**
 * `20261013000000_printroom_office_management_grant` (1.4 D4, R9): `print.send`
 * for Office and Management roles, so the Printroom shows for them.
 *
 * The migration has already run by the time these execute, so each test sets
 * a role up and calls `up()` again, which is also how idempotency is checked
 * (the pattern of `migration-grant.integration.test.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PERMISSIONS } from '@orderbook/shared';

import { db } from '../src/db/knex.js';
import { up as grantPrint } from '../src/db/migrations/20261013000000_printroom_office_management_grant.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

const KEY = 'print.send';

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

describe.skipIf(!canRunIntegrationTests)('printroom office/management grant (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('grants the key to Office and Management roles, as a sorted union that keeps what they held', async () => {
    const ids = await Promise.all(
      (['office', 'management'] as const).map((tier) => insertRole({ tier, permissions: ['reports.view', 'leads.view'] })),
    );

    await grantPrint(db());

    for (const id of ids) expect(await permissionsOf(id)).toEqual(['leads.view', KEY, 'reports.view']);
  });

  it('grants a soft-deleted role too, and never grants print.station', async () => {
    const id = await insertRole({ tier: 'office', permissions: [], deleted: true });

    await grantPrint(db());

    expect(await permissionsOf(id)).toEqual([KEY]);
  });

  it('leaves the admin and server_master tiers alone', async () => {
    const ids = await Promise.all(
      (['admin', 'server_master'] as const).map((tier) => insertRole({ tier, permissions: ['leads.view'] })),
    );

    await grantPrint(db());

    for (const id of ids) expect(await permissionsOf(id)).toEqual(['leads.view']);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const id = await insertRole({ tier: 'management', permissions: ['leads.view'] });

    await grantPrint(db());
    const first = await permissionsOf(id);
    await grantPrint(db());

    expect(await permissionsOf(id)).toEqual(first);
  });

  it('names a real catalogue key', () => {
    expect(PERMISSIONS).toContain(KEY);
  });
});
