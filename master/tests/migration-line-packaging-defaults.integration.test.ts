/**
 * `20260328000000_line_packaging_defaults` — Box, Grass and Paper on the
 * packaging list, without doubling or reviving what a company already has.
 *
 * `setupDatabase` strips every option row but the source platforms, so each
 * case starts from an empty `line.packaging` list and runs `up()` itself.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up } from '../src/db/migrations/20260328000000_line_packaging_defaults.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

async function packagingList(): Promise<
  Array<{ value: string; sequence: number; deleted: boolean }>
> {
  const rows = await db()('option_lists')
    .where({ tenant_id: await testTenantId(), list_key: 'line.packaging' })
    .orderBy('sequence')
    .select<Array<{ value: string; sequence: number; deleted_at: Date | null }>>(
      'value',
      'sequence',
      'deleted_at',
    );
  return rows.map((row) => ({
    value: row.value,
    sequence: row.sequence,
    deleted: row.deleted_at !== null,
  }));
}

async function insertPackaging(value: string, sequence: number, deleted = false): Promise<void> {
  await db()('option_lists').insert({
    id: randomUUID(),
    tenant_id: await testTenantId(),
    list_key: 'line.packaging',
    value,
    label: value,
    sequence,
    is_active: true,
    deleted_at: deleted ? new Date() : null,
  });
}

describe.skipIf(!canRunIntegrationTests)('line packaging defaults migration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    // `resetData` keeps the option rows `setupDatabase` captured, and on a brand-new test database
    // that capture is empty (the six source platforms are seeded per company, and there is none at
    // migration time), so it skips the option cleanup and the last case's rows would leak into this one.
    await db()('option_lists').where({ list_key: 'line.packaging' }).delete();
  });

  it('PKG-DEF-1: fills an empty list with Box, Grass and Paper, once however often it runs', async () => {
    await up(db());
    await up(db());

    expect(await packagingList()).toEqual([
      { value: 'Box', sequence: 1, deleted: false },
      { value: 'Grass', sequence: 2, deleted: false },
      { value: 'Paper', sequence: 3, deleted: false },
    ]);
  });

  it('PKG-DEF-2: leaves a value the company has — in any case, deleted too — and adds after the rest', async () => {
    await insertPackaging('box', 1);
    await insertPackaging('Crate', 4);
    await insertPackaging('Grass', 2, true);

    await up(db());

    expect(await packagingList()).toEqual([
      { value: 'box', sequence: 1, deleted: false },
      { value: 'Grass', sequence: 2, deleted: true },
      { value: 'Crate', sequence: 4, deleted: false },
      { value: 'Paper', sequence: 7, deleted: false },
    ]);
  });
});
