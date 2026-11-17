/**
 * `20260323000000_product_variants` — what an installation is left with once
 * the product master is category → model → variant.
 *
 * The migration has already run by the time any of these execute (the test
 * cluster migrates to the head of the registry), so the tests read the shape
 * it left behind and call `up()` again on a database that holds data. That
 * second call is also the idempotency gate: the migration wipes every
 * product-linked table, so if the guard ever stopped recognising a migrated
 * database, an upgrade that re-ran it would erase the shop's catalogue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up as productVariants } from '../src/db/migrations/20260323000000_product_variants.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

async function columnsOf(table: string): Promise<string[]> {
  const rows = await db()('information_schema.columns')
    .where({ table_schema: 'public', table_name: table })
    .orderBy('ordinal_position')
    .select<Array<{ column_name: string }>>('column_name');
  return rows.map((row) => row.column_name);
}

async function indexesOf(table: string): Promise<string[]> {
  const rows = await db()('pg_indexes')
    .where({ schemaname: 'public', tablename: table })
    .select<Array<{ indexname: string }>>('indexname');
  return rows.map((row) => row.indexname).sort();
}

describe.skipIf(!canRunIntegrationTests)('product variants migration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('MIG-1: the code, the weight and the colour live on product_variants, not products', async () => {
    expect(await columnsOf('product_variants')).toEqual([
      'id',
      'tenant_id',
      'product_id',
      'code',
      'label',
      'weight_kg',
      'sequence',
      'is_active',
      'deleted_at',
      'created_at',
      'updated_at',
    ]);

    const products = await columnsOf('products');
    expect(products).toContain('has_variants');
    expect(products).not.toContain('product_code');
    // 2026-11-17 gave the sub product its own `code`, `weight_kg`, `colours`
    // and `print_side`, backfilled from the first variant; the variant table
    // stays dormant.
    expect(products).toContain('code');
    expect(products).toContain('weight_kg');
    expect(products).not.toContain('color');

    // A category is no longer optional.
    const category = await db()('information_schema.columns')
      .where({ table_schema: 'public', table_name: 'products', column_name: 'category_id' })
      .first<{ is_nullable: string }>('is_nullable');
    expect(category?.is_nullable).toBe('NO');

    const sequences = await db()('information_schema.sequences')
      .where({ sequence_name: 'product_code_seq' })
      .select('sequence_name');
    expect(sequences).toEqual([]);
  });

  it('MIG-2: a line is one variant, and the colour-quantity child table is gone', async () => {
    const tables = await db()('information_schema.tables')
      .where({ table_schema: 'public', table_name: 'line_item_quantities' })
      .select('table_name');
    expect(tables).toEqual([]);

    const lines = await columnsOf('line_items');
    expect(lines).toContain('variant_id');
    expect(lines).toContain('variant_label');
    expect(lines).toContain('quantity');
    expect(lines).not.toContain('total_quantity');

    // The CHECK is what makes "a line with nothing on it" impossible to store.
    const checks = await db()('information_schema.check_constraints')
      .where({ constraint_name: 'line_items_quantity_positive' })
      .select('constraint_name');
    expect(checks).toHaveLength(1);
  });

  it('MIG-3: stock, movements and reservations are keyed by the variant', async () => {
    for (const table of ['inventory_stock', 'stock_movements', 'stock_reservations']) {
      const columns = await columnsOf(table);
      expect(columns, table).toContain('variant_id');
      expect(columns, table).toContain('product_id');
      expect(columns, table).not.toContain('colour');
    }
    expect(await columnsOf('inventory_stock')).not.toContain('variant_code');

    expect(await indexesOf('product_variants')).toEqual([
      'idx_product_variants_code_tenant',
      'idx_product_variants_label',
      'idx_product_variants_product',
      'product_variants_pkey',
    ]);
    expect(await indexesOf('inventory_stock')).toContain('idx_inventory_variant');
    expect(await indexesOf('inventory_stock')).not.toContain('idx_inventory_product_colour');
    expect(await indexesOf('stock_movements')).toContain('idx_stock_movements_variant');
    expect(await indexesOf('stock_reservations')).toContain('idx_reservations_variant');
    expect(await indexesOf('line_items')).toContain('idx_line_items_variant');
    expect(await indexesOf('products')).toContain('idx_products_category');
    // Added by the 2026-11-17 removal: the sub product's own code is unique.
    expect(await indexesOf('products')).toContain('idx_products_code_tenant');
  });

  it('MIG-4: running up() again on a migrated database changes nothing — the wipe does not fire', async () => {
    const actor = await testActor();
    const { product } = await createTestProduct(actor, { name: 'Survivor', code: 'SRV-1' });
    // Nothing writes a variant row any more; this one is staged by hand because
    // the subject of this suite is the dormant table's own shape.
    const tenantId = await testTenantId();
    await db()('product_variants').insert({
      id: 'VR9999999901',
      tenant_id: tenantId,
      product_id: product.id,
      code: 'SRV-1',
      label: null,
      sequence: 0,
    });

    await productVariants(db());

    const rows = await db()('products').where({ id: product.id }).select('id');
    expect(rows).toHaveLength(1);
    const variants = await db()('product_variants').where({ product_id: product.id }).select('code');
    expect(variants).toEqual([{ code: 'SRV-1' }]);
  });

  it('MIG-5: the database itself refuses a duplicate code, a zero weight and a repeated colour on one model, and allows blank colours', async () => {
    const actor = await testActor();
    const tenantId = await testTenantId();
    const { product: guarded } = await createTestProduct(actor, { name: 'Guarded', code: 'GRD-1' });
    const { product: other } = await createTestProduct(actor, { name: 'Other', code: 'OTH-1' });

    const row = (overrides: Record<string, unknown>) => ({
      id: 'VR9999999999',
      tenant_id: tenantId,
      product_id: other.id,
      code: 'X',
      label: 'Blue',
      weight_kg: null,
      sequence: 9,
      ...overrides,
    });

    // Staged by hand: nothing writes this table any more, and its own shape is
    // the subject here. `guarded` takes the code every other insert collides on.
    await db()('product_variants').insert({
      id: 'VR9999999995',
      tenant_id: tenantId,
      product_id: guarded.id,
      code: 'GRD-1',
      label: 'Blue',
      sequence: 0,
    });

    // The code index is case-insensitive and spans products.
    await expect(db()('product_variants').insert(row({ code: 'grd-1' }))).rejects.toMatchObject({
      code: '23505',
      constraint: 'idx_product_variants_code_tenant',
    });
    // A weight is either unknown or a real figure.
    await expect(db()('product_variants').insert(row({ weight_kg: 0 }))).rejects.toMatchObject({
      code: '23514',
      constraint: 'product_variants_weight_check',
    });
    // A colour that is given must differ, whatever the case...
    await db()('product_variants').insert(row({ id: 'VR9999999997', code: 'Y', label: 'Blue' }));
    await expect(db()('product_variants').insert(row({ label: 'BLUE' }))).rejects.toMatchObject({
      code: '23505',
      constraint: 'idx_product_variants_label',
    });
    // ...but several rows may leave it blank (20261105000000_variant_blank_label).
    await db()('product_variants').insert(row({ id: 'VR9999999998', code: 'Z', label: null }));
    await expect(
      db()('product_variants').insert(row({ id: 'VR9999999996', code: 'W', label: null })),
    ).resolves.toBeDefined();

    // ...while a binned product's codes are free for the taking.
    await db()('product_variants')
      .where({ id: 'VR9999999995' })
      .update({ deleted_at: db().fn.now() });
    await expect(db()('product_variants').insert(row({ code: 'GRD-1', label: 'Green' }))).resolves.toBeDefined();
  });

  it('MIG-6: the product carries its own code, so the vector follows the product row', async () => {
    const actor = await testActor();
    const { product } = await createTestProduct(actor, { name: 'Indexed', code: 'IDX-1' });

    // The variant trigger is gone with the table; `products_search_refresh`
    // reads the product's own columns, so editing the row re-indexes it.
    await db()('products').where({ id: product.id }).update({ code: 'TRIGGERCODE2' });

    const hit = await db()('products')
      .where({ id: product.id })
      .whereRaw(`search_vector @@ plainto_tsquery('simple', ?)`, ['TRIGGERCODE2'])
      .select('id');
    expect(hit).toEqual([{ id: product.id }]);

    const stale = await db()('products')
      .where({ id: product.id })
      .whereRaw(`search_vector @@ plainto_tsquery('simple', ?)`, ['IDX-1'])
      .select('id');
    expect(stale).toEqual([]);
  });

  it('MIG-7: the tenant has an id counter for the new entity', async () => {
    const tenantId = await testTenantId();
    const row = await db()('id_sequences')
      .where({ tenant_id: tenantId, entity: 'product_variant' })
      .first<{ entity: string }>('entity');
    expect(row?.entity).toBe('product_variant');
  });
});
