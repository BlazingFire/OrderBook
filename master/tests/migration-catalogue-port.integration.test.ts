/**
 * `20260326000000_catalogue_brands_and_codes_port` — one schema for every
 * history (`docs/catalogue/CATALOGUE_MODEL.md` §3).
 *
 * The test cluster migrates to the head of the registry before any of this
 * runs, so the migration has already been applied once. Running `up()` again
 * is the case of the stale-branch database, which reaches this migration with
 * every column and index already in place; running `down()` first is the case
 * of a 1.2.0 database, which reaches it with none of them and the old
 * (tenant, name) index still there. Both must end in the same place.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import {
  down as catalogueDown,
  up as catalogueUp,
} from '../src/db/migrations/20260326000000_catalogue_brands_and_codes_port.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

async function indexNames(table: string): Promise<string[]> {
  const rows = await db()('pg_indexes')
    .where({ schemaname: 'public', tablename: table })
    .select<Array<{ indexname: string }>>('indexname');
  return rows.map((row) => row.indexname).sort();
}

async function columnNames(table: string): Promise<string[]> {
  const rows = await db()('information_schema.columns')
    .where({ table_schema: 'public', table_name: table })
    .select<Array<{ column_name: string }>>('column_name');
  return rows.map((row) => row.column_name);
}

async function expectPortedSchema(): Promise<void> {
  const categoryIndexes = await indexNames('product_categories');
  expect(categoryIndexes).toContain('idx_categories_brand_name');
  expect(categoryIndexes).toContain('idx_categories_code');
  expect(categoryIndexes).not.toContain('idx_categories_name_tenant');

  expect(await columnNames('product_categories')).toEqual(
    expect.arrayContaining(['code', 'brand', 'sort_order', 'updated_at', 'deleted_at']),
  );
  expect(await columnNames('products')).toContain('sort_order');
  expect(await columnNames('line_items')).toEqual(
    expect.arrayContaining(['brand_name', 'category_code']),
  );
}

let sequence = 0;

async function insertCategory(values: {
  name: string;
  brand?: string | null;
  code?: string | null;
  deleted?: boolean;
}): Promise<void> {
  sequence += 1;
  await db()('product_categories').insert({
    id: `PCTEST${String(sequence).padStart(4, '0')}`,
    tenant_id: await testTenantId(),
    name: values.name,
    brand: values.brand ?? null,
    code: values.code ?? null,
    ...(values.deleted ? { deleted_at: db().fn.now() } : {}),
  });
}

describe.skipIf(!canRunIntegrationTests)('catalogue port migration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('CAT-MIG-1: a migrated database carries the new columns and indexes, not the old name index', async () => {
    await expectPortedSchema();
  });

  it('CAT-MIG-2: running it again on a database that already has everything changes nothing', async () => {
    // The stale-branch database: its own body already added every object.
    await catalogueUp(db());
    await catalogueUp(db());

    await expectPortedSchema();
  });

  it('CAT-MIG-3: a 1.2.0-shaped database, with the old index and no new columns, is brought level', async () => {
    try {
      await catalogueDown(db());
      expect(await indexNames('product_categories')).toContain('idx_categories_name_tenant');
      expect(await columnNames('product_categories')).not.toContain('code');

      // A 1.2.0 category, brandless and codeless, must survive the swap.
      await db()('product_categories').insert({
        id: 'PCLEGACY01',
        tenant_id: await testTenantId(),
        name: 'ONE PIECE TOILET',
      });

      await catalogueUp(db());
    } finally {
      // Whatever happened above, leave the shared cluster on the head schema.
      await catalogueUp(db());
    }

    await expectPortedSchema();
    const legacy = await db()('product_categories').where({ id: 'PCLEGACY01' }).first();
    expect(legacy).toMatchObject({ code: null, brand: null, sort_order: null, deleted_at: null });
  });

  it('CAT-MIG-4: a name is unique per brand among live rows, and a deleted row frees it', async () => {
    await insertCategory({ name: 'One Piece Toilet', brand: 'Swisware+', code: 'OPT' });
    await insertCategory({ name: 'One Piece Toilet', brand: 'Other brand', code: 'OPT2' });
    await insertCategory({ name: 'One Piece Toilet', brand: null });

    await expect(
      insertCategory({ name: 'one piece toilet', brand: 'SWISWARE+', code: 'X1' }),
    ).rejects.toThrow(/idx_categories_brand_name/);
    await expect(insertCategory({ name: 'ONE PIECE TOILET', brand: null })).rejects.toThrow(
      /idx_categories_brand_name/,
    );

    await db()('product_categories').where({ code: 'OPT2' }).update({ deleted_at: db().fn.now() });
    await insertCategory({ name: 'One Piece Toilet', brand: 'Other brand', code: 'OPT3' });
  });

  it('CAT-MIG-5: a code is unique case-insensitively among live rows, and absent codes never collide', async () => {
    await insertCategory({ name: 'Wash Basin', code: 'WB' });
    await expect(insertCategory({ name: 'Table Top', code: 'wb' })).rejects.toThrow(
      /idx_categories_code/,
    );

    await insertCategory({ name: 'Legacy A' });
    await insertCategory({ name: 'Legacy B' });

    await insertCategory({ name: 'Old basin', code: 'OB', deleted: true });
    await insertCategory({ name: 'New basin', code: 'OB' });
  });
});
