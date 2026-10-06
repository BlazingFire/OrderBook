/**
 * `20261014000000_notice_board`: the grants. `notices.view` goes to every role whatever its tier
 * (deleted ones too), `notices.manage` only to the admin and server_master tiers, as a sorted
 * union that keeps what a role held, and a second run changes nothing. The tables are exercised
 * by `notices.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up as noticeBoard } from '../src/db/migrations/20261014000000_notice_board.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

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

describe.skipIf(!canRunIntegrationTests)('notice board grants (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('gives notices.view to every tier, keeping what the role held, sorted', async () => {
    const ids = await Promise.all(
      (['office', 'management', 'admin', 'server_master'] as const).map((tier) =>
        insertRole({ tier, permissions: ['reports.view'] }),
      ),
    );

    await noticeBoard(db());

    const [office, management, admin, serverMaster] = await Promise.all(ids.map(permissionsOf));
    expect(office).toEqual(['notices.view', 'reports.view']);
    expect(management).toEqual(['notices.view', 'reports.view']);
    expect(admin).toEqual(['notices.manage', 'notices.view', 'reports.view']);
    expect(serverMaster).toEqual(['notices.manage', 'notices.view', 'reports.view']);
  });

  it('grants a soft-deleted role too, so a restored role comes back as its siblings are', async () => {
    const id = await insertRole({ tier: 'office', permissions: [], deleted: true });

    await noticeBoard(db());

    expect(await permissionsOf(id)).toEqual(['notices.view']);
  });

  it('is idempotent, and never takes manage away from or hands it to the wrong tier twice', async () => {
    const office = await insertRole({ tier: 'office', permissions: [] });
    const admin = await insertRole({ tier: 'admin', permissions: [] });

    await noticeBoard(db());
    await noticeBoard(db());

    expect(await permissionsOf(office)).toEqual(['notices.view']);
    expect(await permissionsOf(admin)).toEqual(['notices.manage', 'notices.view']);
  });
});
