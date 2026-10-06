/**
 * `20261015000000_catalogue_corrections` — the owner's catalogue corrections,
 * made in place on an installed catalogue:
 *
 * - the page-4 toilets renamed from their caption (`102 (9")`) to their model
 *   number (`102`);
 * - the four page-13 closets that are white only;
 * - `14x14 NEW CORNER` moved from Wash Basin to Table Top Wash Basin.
 *
 * An install from before the fix is staged by loading the shipped file and
 * putting rows back the way they first shipped; others carry a change the
 * company made itself. Pending and final orders are taken before the
 * migration runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildOrderNote, colourRuleOf } from '@orderbook/shared';

import { db } from '../src/db/knex.js';
import { up } from '../src/db/migrations/20261015000000_catalogue_corrections.js';
import * as catalog from '../src/services/catalog.service.js';
import { loadCatalogue, readCatalogueFile } from '../src/services/catalogue-seed.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

interface Row {
  id: string;
  name: string;
  size: string | null;
  version: number;
  hlc: string | null;
  code: string;
  variantId: string;
  label: string | null;
  multiColour: boolean;
  categoryCode: string;
}

/** The sub product holding variant `code`, with what the migration may change. */
async function byCode(code: string): Promise<Row> {
  return db()('products as p')
    .join('product_variants as v', 'v.product_id', 'p.id')
    .join('product_categories as c', 'c.id', 'p.category_id')
    .where('v.code', code)
    .first(
      'p.id',
      'p.name',
      'p.size',
      'p.version',
      'p.hlc',
      'v.code',
      'v.id as variantId',
      'v.label',
      'p.multi_colour as multiColour',
      'c.code as categoryCode',
    );
}

async function categoryId(code: string): Promise<string> {
  return (await db()('product_categories').where({ code }).first('id')).id;
}

/** As first shipped: multicolour, no label. */
async function shipMulticolour(code: string): Promise<void> {
  const row = await byCode(code);
  await db()('products').where({ id: row.id }).update({ multi_colour: true, has_variants: false });
  await db()('product_variants').where({ id: row.variantId }).update({ label: null });
}

/** An install from before the fix, with a pending and a final order on the old rows. */
async function stageOldInstall() {
  const actor = await testActor();
  await loadCatalogue(await readCatalogueFile(), actor, { replace: false });

  await db()('products').where({ id: (await byCode('OPT-0001')).id }).update({ name: '102 (9")', size: 'L-27, B-15, H-26' });
  await db()('products').where({ id: (await byCode('OPT-0015')).id }).update({ name: 'SYPHONIC (9")', size: 'L-26, B-14, H-30' });
  // The company's own name for 111: not the shipped caption, so not ours to change.
  await db()('products').where({ id: (await byCode('OPT-0002')).id }).update({ name: '111 (9") Deluxe', size: 'L-27, B-14, H-25' });

  await shipMulticolour('WC-0001');
  await shipMulticolour('WC-0002');
  // WC-0003 the company already made fixed Ivory itself.
  await db()('products').where({ id: (await byCode('WC-0003')).id }).update({ multi_colour: false, has_variants: true });
  await db()('product_variants').where({ code: 'WC-0003' }).update({ label: 'Ivory' });

  const corner = await byCode('TTW-0016');
  await db()('products')
    .where({ id: corner.id })
    .update({ category_id: await categoryId('WB'), sort_order: 17, has_variants: true });
  await db()('product_variants').where({ id: corner.variantId }).update({ code: 'WB-0017', label: 'White' });

  const party = await catalog.createParty({ name: 'Old Orders Traders' }, actor);
  const take = async (code: string) => {
    const row = await byCode(code);
    return leads.createLead(
      { partyId: party.id, items: [{ productId: row.id, variantId: row.variantId, quantity: 3, packaging: 'Box' }] },
      actor,
    );
  };
  const lead = await take('OPT-0001');
  const order = await orders.convertLead({ leadId: (await take('OPT-0001')).id }, actor);
  const cornerLead = await take('WB-0017');
  return { actor, lead, order, cornerLead, corner };
}

async function snapshot() {
  return {
    rows: await Promise.all(['OPT-0001', 'OPT-0002', 'OPT-0015', 'WC-0001', 'WC-0003', 'TTW-0016'].map(byCode)),
    lines: await db()('line_items').orderBy('id').select('id', 'product_name', 'size', 'code', 'category_code', 'updated_at'),
  };
}

describe.skipIf(!canRunIntegrationTests)('catalogue corrections migration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('CAT-FIX-1: renames the shipped captions in place, keeping the id, the code and the variant', async () => {
    await stageOldInstall();
    const before = await byCode('OPT-0001');
    expect(before.name).toBe('102 (9")');

    await up(db());

    const after = await byCode('OPT-0001');
    expect(after).toMatchObject({ id: before.id, variantId: before.variantId, name: '102', size: '9", L-27, B-15, H-26' });
    expect(after.version).toBe(before.version + 1);
    expect(after.hlc).not.toBe(before.hlc);
    expect((await byCode('OPT-0015')).name).toBe('SYPHONIC');
  });

  it('CAT-FIX-2: leaves what the company changed itself', async () => {
    await stageOldInstall();
    const renamed = await byCode('OPT-0002');
    const ivory = await byCode('WC-0003');

    await up(db());

    expect(await byCode('OPT-0002')).toEqual(renamed);
    expect(await byCode('WC-0003')).toEqual(ivory);
  });

  it('CAT-FIX-3: a second run changes nothing', async () => {
    await stageOldInstall();
    await up(db());
    const once = await snapshot();

    await up(db());

    expect(await snapshot()).toEqual(once);
  });

  it("CAT-FIX-4: an old pending order's and final order's note print 102 in the Code column", async () => {
    const { actor, lead, order } = await stageOldInstall();
    // Taken on the old name, so it starts on the named side.
    expect(buildOrderNote(await leads.getLead(lead.id, actor)).named.map((line) => line.subProduct)).toEqual([
      '102 (9")',
    ]);

    await up(db());

    for (const record of [await leads.getLead(lead.id, actor), await orders.getOrder(order.id, actor)]) {
      expect(record.items.map((line) => [line.productName, line.size])).toEqual([['102', '9", L-27, B-15, H-26']]);
      const note = buildOrderNote(record);
      expect(note.named).toEqual([]);
      expect(note.coded.flatMap((group) => group.lines.map((line) => line.subProduct))).toEqual(['102']);
    }
  });

  it('CAT-FIX-5: the concealed and modern closets become white only; the trap closets stay multicolour', async () => {
    const { actor } = await stageOldInstall();

    await up(db());

    for (const code of ['WC-0001', 'WC-0002']) {
      const product = (await catalog.findProductByCode(code, actor))!;
      expect(colourRuleOf(product)).toBe('fixed');
      expect(product.variants.map((variant) => variant.label)).toEqual(['White']);
    }
    expect(colourRuleOf((await catalog.findProductByCode('WC-0005', actor))!)).toBe('selectable');
  });

  it('CAT-FIX-6: 14x14 NEW CORNER moves to Table Top Wash Basin on the next free code, and its old line follows', async () => {
    const { actor, cornerLead, corner } = await stageOldInstall();

    await up(db());

    expect(await byCode('WB-0017')).toBeUndefined();
    const moved = await byCode('TTW-0016');
    expect(moved).toMatchObject({ id: corner.id, variantId: corner.variantId, categoryCode: 'TTW', label: null });
    expect(colourRuleOf((await catalog.findProductByCode('TTW-0016', actor))!)).toBe('dedicated');
    const line = (await leads.getLead(cornerLead.id, actor)).items[0];
    expect(line).toMatchObject({ variantId: corner.variantId, code: 'TTW-0016', categoryCode: 'TTW' });
  });
});
