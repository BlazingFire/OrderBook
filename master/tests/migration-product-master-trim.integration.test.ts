/**
 * `20260324000000_product_master_trim` — what an installation is left with
 * once the product master is name/category/alias/size + code/colour/weight,
 * pricing is gone and `multi_colour` exists.
 *
 * The migration has already run by the time any of these execute (the test
 * cluster migrates to the head of the registry), so the tests read the shape
 * it left behind and call `up()` again on a database that holds data. That
 * second call is the idempotency gate: the guard has to recognise a migrated
 * database, or an upgrade would try to drop columns that are already gone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up as productMasterTrim } from '../src/db/migrations/20260324000000_product_master_trim.js';
import * as leads from '../src/services/lead.service.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
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

describe.skipIf(!canRunIntegrationTests)('product master trim migration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('TRIM-1: products carry exactly the model fields, the switch and the plumbing', async () => {
    const products = await columnsOf('products');

    for (const kept of ['name', 'alias', 'category_id', 'size', 'has_variants', 'multi_colour', 'custom_fields']) {
      expect(products, kept).toContain(kept);
    }
    for (const gone of [
      'sin', 'grade', 'product_type', 'finish', 'series', 'thickness_mm', 'pieces_per_box',
      'box_coverage_sqft', 'rate', 'price_per_sqft', 'hsn_code', 'mrp', 'purchase_rate', 'gst_rate_pct',
      'uom', 'barcode', 'brand', 'shade', 'calibre', 'water_absorption_pct', 'pei_rating', 'edge_type',
      'surface_texture', 'application', 'origin_plant', 'parameters',
    ]) {
      expect(products, gone).not.toContain(gone);
    }

    const flag = await db()('information_schema.columns')
      .where({ table_schema: 'public', table_name: 'products', column_name: 'multi_colour' })
      .first<{ is_nullable: string; column_default: string }>('is_nullable', 'column_default');
    expect(flag?.is_nullable).toBe('NO');
    expect(flag?.column_default).toBe('false');
  });

  it('TRIM-2: no table carries money, and a line carries its colour', async () => {
    const lines = await columnsOf('line_items');
    expect(lines).toContain('colour');
    // `grade` is not in this list any more: the trim drops it and
    // `20260325000000_line_item_grade`, which runs after it, puts the *line's*
    // one back at the owner's request. The catalogue's grade columns below
    // stay gone — that is the half of the trim that still holds.
    expect(lines).toContain('grade');
    for (const gone of ['rate', 'line_total', 'sin', 'product_type']) {
      expect(lines, gone).not.toContain(gone);
    }
    expect(await columnsOf('leads')).not.toContain('total_amount');
    expect(await columnsOf('orders')).not.toContain('total_amount');

    const partyVariants = await columnsOf('party_product_variants');
    for (const gone of ['rate', 'sin', 'grade', 'product_type']) {
      expect(partyVariants, gone).not.toContain(gone);
    }
    expect(partyVariants).toContain('packaging');
  });

  it('TRIM-3: the search vector reads the columns that are left, so a save still indexes', async () => {
    const actor = await testActor();
    const { product } = await createTestProduct(actor, { name: 'Indexed', code: 'TRM-1', alias: 'Trimmed', size: 'L-16 H-31' });

    for (const term of ['Trimmed', 'L-16', 'TRM-1']) {
      const hit = await db()('products')
        .where({ id: product.id })
        .whereRaw(`search_vector @@ plainto_tsquery('simple', ?)`, [term])
        .select('id');
      expect(hit, term).toEqual([{ id: product.id }]);
    }

    const party = await catalog.createParty({ name: 'Trim Traders' }, actor);
    // A new line's colour must be on the company list (W2, 2026-10-07).
    await fields.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
    const anyColour = await catalog.createProduct(
      { name: 'Any colour', categoryName: 'WATER CLOSET', multiColour: true, variants: [{ code: 'TRM-2' }] },
      actor,
    );
    const lead = await leads.createLead(
      {
        partyId: party.id,
        items: [{ productId: anyColour.id, variantId: anyColour.variants[0]!.id, quantity: 1, colour: 'Ivory' }],
      },
      actor,
    );
    const line = await db()('line_items')
      .where({ parent_type: 'lead', parent_id: lead.id })
      .whereRaw(`search_vector @@ plainto_tsquery('simple', ?)`, ['Ivory'])
      .select('id');
    expect(line).toHaveLength(1);
  });

  it('TRIM-4: running up() again on a migrated database changes nothing', async () => {
    const actor = await testActor();
    const { product } = await createTestProduct(actor, { name: 'Survivor', code: 'SRV-1', multiColour: true });

    await productMasterTrim(db());

    const row = await db()('products').where({ id: product.id }).first<{ multi_colour: boolean }>('multi_colour');
    expect(row?.multi_colour).toBe(true);
    expect(await columnsOf('products')).toContain('multi_colour');
  });

  it('TRIM-5: the shipped roles hold no rate key, and no product option list survives', async () => {
    const tenantId = await testTenantId();
    const roles = await db()('roles').where({ tenant_id: tenantId }).select<Array<{ permissions: unknown }>>('permissions');
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const keys = Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
      expect(keys.filter((key) => key.startsWith('field.'))).toEqual([]);
    }

    const lists = await db()('option_lists')
      .where({ tenant_id: tenantId })
      .distinct<Array<{ list_key: string }>>('list_key');
    for (const list of lists) {
      expect(list.list_key).not.toMatch(/^product\./);
      expect(list.list_key).not.toBe('line.grade');
    }

    const pricing = await db()('settings').where({ tenant_id: tenantId, key: 'pricing.enabled' }).select('key');
    expect(pricing).toEqual([]);
  });
});
