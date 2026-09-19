/**
 * `20260322000000_drop_document_designer` — what an upgraded installation is
 * left with once the PDF Designer is gone.
 *
 * The migration has already run by the time any of these execute (the test
 * cluster migrates to the head of the registry), so each test sets a role up
 * in the state an older installation would have — holding the keys `20260309`
 * granted — and calls `up()` again. That is also the idempotency gate: a
 * migration that is not safe to re-run cannot be tested this way at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up as dropDocumentDesigner } from '../src/db/migrations/20260322000000_drop_document_designer.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

/** Frozen here for the same reason the migration inlines them. */
const REMOVED_KEYS = [
  'documents.create',
  'documents.delete',
  'documents.edit',
  'documents.render',
  'documents.view',
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

describe.skipIf(!canRunIntegrationTests)('drop the PDF Designer (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('DROP-1: none of the three document tables exists any more', async () => {
    const rows = await db()('information_schema.tables')
      .whereIn('table_name', ['document_templates', 'document_assets', 'document_exports'])
      .select('table_name');

    expect(rows).toEqual([]);
  });

  it('DROP-2: an admin role holding the five keys loses exactly those five', async () => {
    const id = await insertRole({
      tier: 'admin',
      permissions: ['leads.view', ...REMOVED_KEYS, 'users.manage'],
    });

    await dropDocumentDesigner(db());

    expect(await permissionsOf(id)).toEqual(['leads.view', 'users.manage']);
  });

  it('DROP-3: a role that never held them is left byte-for-byte alone', async () => {
    const id = await insertRole({ tier: 'management', permissions: ['leads.view', 'leads.edit'] });

    await dropDocumentDesigner(db());

    expect(await permissionsOf(id)).toEqual(['leads.view', 'leads.edit']);
  });

  it('DROP-4: it is idempotent — a second run changes nothing', async () => {
    const id = await insertRole({ tier: 'admin', permissions: ['leads.view', 'documents.view'] });

    await dropDocumentDesigner(db());
    const first = await permissionsOf(id);
    await dropDocumentDesigner(db());

    expect(await permissionsOf(id)).toEqual(first);
    expect(first).toEqual(['leads.view']);
  });

  it('DROP-5: a soft-deleted role is stripped too, so a restore does not bring the keys back', async () => {
    const id = await insertRole({
      tier: 'office',
      permissions: ['orders.view', 'documents.render'],
      deleted: true,
    });

    await dropDocumentDesigner(db());

    expect(await permissionsOf(id)).toEqual(['orders.view']);
  });
});
