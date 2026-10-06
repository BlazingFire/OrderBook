/**
 * Catalogue corrections from the owner's reading of the PDF (U8, U13, 2026-10-07).
 *
 * Brings an installed catalogue to where the shipped `swisware-plus-2026.md`
 * now is, in place — the product id and its variant stay, so leads, orders,
 * stock, party records and photos keep pointing at the same row:
 *
 * 1. **Page-4 toilets are numbered models.** The print reads `102 (9")` over
 *    `L-27, B-15, H-26`; the model is `102` and `9"` is the trap size. Named
 *    as the whole caption, all fourteen landed as named models (Model column,
 *    named half of the note) because `isNumericSubProduct` wants digits alone.
 *    Now `102` with size `9", L-27, B-15, H-26`; `SYPHONIC (9")` the same way.
 * 2. **Page 13: only the trap closets come in every colour.** The "all items
 *    available in all colours" note covers the E.W.C and Anglo Indian S and P
 *    traps; the four concealed / modern closets above it are white only.
 * 3. **Page 14: `14x14 NEW CORNER` is a table top basin.** It moves from Wash
 *    Basin to Table Top Wash Basin, last in order, and takes that product's
 *    rule (no colour) and its next free code — `TTW-0016` on a catalogue that
 *    was loaded as shipped. Its old `WB-0017` is freed; lines keep the variant.
 *
 * Each step touches a row only while it still holds exactly what was shipped,
 * so a row the company changed itself is left alone, and a second run finds
 * nothing to do. UPDATE only. The rows are inline, never read from the `.md`:
 * a migration must not change meaning when the shipped file does.
 */

import type { Knex } from 'knex';
import { tickHlc } from '@orderbook/shared';

/** [name as first shipped, name now, size now]. */
const RENAMES: ReadonlyArray<readonly [string, string, string]> = [
  ['102 (9")', '102', '9", L-27, B-15, H-26'],
  ['111 (9")', '111', '9", L-27, B-14, H-25'],
  ['103 (9")', '103', '9", L-27, B-14, H-27'],
  ['105 (9")', '105', '9", L-26, B-14, H-27'],
  ['107 (9")', '107', '9", L-26, B-14, H-30'],
  ['108 (9")', '108', '9", L-25, B-14, H-27'],
  ['109 (9")', '109', '9", L-26, B-14, H-29'],
  ['110 (9")', '110', '9", L-25, B-14, H-27'],
  ['112 (9")', '112', '9", L-26, B-14, H-28'],
  ['113 (9")', '113', '9", L-25, B-14, H-28'],
  ['115 (9")', '115', '9", L-26, B-14, H-29'],
  ['116 (9")', '116', '9", L-26, B-14, H-29'],
  ['118 (9")', '118', '9", L-26, B-14, H-30'],
  ['204 (4")', '204', '4", L-27, B-14, H-27'],
  ['SYPHONIC (9")', 'SYPHONIC', '9", L-26, B-14, H-30'],
];

/** Page 13's closets that are made in white only. */
const WHITE_ONLY_CLOSETS = [
  'E.W.C - ECO CONCEALED',
  'E.W.C - ECO CONCEALED SLIM',
  'E.W.C - MODERN',
  'E.W.C - CONCEALED',
] as const;

const NEW_CORNER = '14x14 NEW CORNER';

/**
 * Whether lines already written follow the change. The owner chose yes
 * (2026-10-07): an old lead's or order's line of exactly these rows takes the
 * new name — and, where its size snapshot is still the old size, the new size —
 * so its note prints `102` in the Code column like a new one; a moved basin's
 * lines take its new product and code. Party records follow the rename too.
 * `false` would leave history as taken.
 */
const RENAME_LINE_SNAPSHOTS = true;

interface Row {
  id: string;
  tenant_id: string;
  name: string;
  field_hlc: unknown;
}

type Stamp = (row: Row, fields: string[]) => Promise<Record<string, unknown>>;

export async function up(knex: Knex): Promise<void> {
  let hlc: string | null | undefined;
  // One tick for the whole migration, and only if it changes something.
  const stamp: Stamp = async (row, fields) => {
    if (hlc === undefined) hlc = await tickClock(knex);
    if (hlc === null) return { version: knex.raw('version + 1'), updated_at: knex.fn.now() };
    const previous = typeof row.field_hlc === 'object' && row.field_hlc !== null ? row.field_hlc : {};
    return {
      hlc,
      field_hlc: JSON.stringify({ ...previous, ...Object.fromEntries(fields.map((field) => [field, hlc])) }),
      version: knex.raw('version + 1'),
      updated_at: knex.fn.now(),
    };
  };

  await renameToiletModels(knex, stamp);
  await whiteOnlyClosets(knex, stamp);
  await moveNewCorner(knex, stamp);
}

/** Live sub products of the product coded `code` (any case) whose name is one of `names`. */
function subProductsOf(knex: Knex, code: string, names: readonly string[]) {
  return knex('products as p')
    .join('product_categories as c', function joinCategory() {
      this.on('c.id', '=', 'p.category_id').andOn('c.tenant_id', '=', 'p.tenant_id');
    })
    .whereRaw('upper(c.code) = ?', [code])
    .whereNull('c.deleted_at')
    .whereNull('p.deleted_at')
    .whereIn('p.name', [...names]);
}

async function renameToiletModels(knex: Knex, stamp: Stamp): Promise<void> {
  const rows = await subProductsOf(
    knex,
    'OPT',
    RENAMES.map(([from]) => from),
  ).select<Row[]>('p.id', 'p.tenant_id', 'p.name', 'p.field_hlc');

  for (const row of rows) {
    const [, name, size] = RENAMES.find(([from]) => from === row.name) as readonly [string, string, string];
    await knex('products')
      .where({ id: row.id, tenant_id: row.tenant_id, name: row.name })
      .update({ name, size, ...(await stamp(row, ['name', 'size'])) });

    if (RENAME_LINE_SNAPSHOTS) {
      const lines = { tenant_id: row.tenant_id, product_id: row.id, product_name: row.name };
      // The size it shipped with is the new one less its trap prefix (`9", `).
      await knex('line_items')
        .where({ ...lines, size: size.replace(/^\d+", /, '') })
        .update({ size });
      await knex('line_items').where(lines).update({ product_name: name, updated_at: knex.fn.now() });
      await knex('party_product_variants').where(lines).update({ product_name: name });
    }
  }
}

/**
 * Multicolour to fixed White: `multi_colour` off, `has_variants` on and the one
 * variant labelled White — how `colourRuleOf` reads `fixed`. Only while it is
 * still multicolour with an unlabelled variant, as shipped. Lines already taken
 * keep the colour chosen on them.
 */
async function whiteOnlyClosets(knex: Knex, stamp: Stamp): Promise<void> {
  const rows = await subProductsOf(knex, 'WC', WHITE_ONLY_CLOSETS)
    .where('p.multi_colour', true)
    .select<Row[]>('p.id', 'p.tenant_id', 'p.name', 'p.field_hlc');

  for (const row of rows) {
    const variants = await knex('product_variants')
      .where({ tenant_id: row.tenant_id, product_id: row.id })
      .whereNull('deleted_at')
      .select<Array<{ id: string; label: string | null }>>('id', 'label');
    const only = variants.length === 1 ? variants[0] : undefined;
    if (!only || only.label) continue;

    await knex('product_variants').where({ id: only.id }).update({ label: 'White', updated_at: knex.fn.now() });
    await knex('products')
      .where({ id: row.id, tenant_id: row.tenant_id })
      .update({
        multi_colour: false,
        has_variants: true,
        ...(await stamp(row, ['multiColour', 'hasVariants', 'variants'])),
      });
  }
}

/**
 * `14x14 NEW CORNER` from Wash Basin to the end of Table Top Wash Basin, with
 * that product's rule (no colour: the label goes) and its next code nobody has
 * held. Only while it is still in Wash Basin under its shipped code `WB-0017`
 * and labelled White.
 */
async function moveNewCorner(knex: Knex, stamp: Stamp): Promise<void> {
  const rows = await subProductsOf(knex, 'WB', [NEW_CORNER]).select<Row[]>(
    'p.id',
    'p.tenant_id',
    'p.name',
    'p.field_hlc',
  );

  for (const row of rows) {
    const target = await knex('product_categories')
      .where({ tenant_id: row.tenant_id })
      .whereRaw('upper(code) = ?', ['TTW'])
      .whereNull('deleted_at')
      .first<{ id: string; name: string; code: string } | undefined>('id', 'name', 'code');
    const variant = await knex('product_variants')
      .where({ tenant_id: row.tenant_id, product_id: row.id })
      .whereNull('deleted_at')
      .first<{ id: string; code: string; label: string | null } | undefined>('id', 'code', 'label');
    if (!target || !variant || variant.code.toUpperCase() !== 'WB-0017' || variant.label !== 'White') continue;

    const last = await knex('products')
      .where({ tenant_id: row.tenant_id, category_id: target.id })
      .whereNull('deleted_at')
      .max<{ max: number | null }>('sort_order as max')
      .first();
    // Every code any variant has carried, binned ones too, so a restore never collides.
    const taken = new Set(
      (await knex('product_variants').where({ tenant_id: row.tenant_id }).pluck<string[]>('code')).map((code) =>
        code.toLowerCase(),
      ),
    );
    let number = 16;
    while (taken.has(`ttw-${String(number).padStart(4, '0')}`)) number += 1;
    const code = `TTW-${String(number).padStart(4, '0')}`;

    await knex('product_variants').where({ id: variant.id }).update({ code, label: null, updated_at: knex.fn.now() });
    await knex('products')
      .where({ id: row.id, tenant_id: row.tenant_id })
      .update({
        category_id: target.id,
        sort_order: (last?.max ?? 0) + 1,
        has_variants: false,
        ...(await stamp(row, ['categoryId', 'sortOrder', 'hasVariants', 'variants'])),
      });

    if (RENAME_LINE_SNAPSHOTS) {
      await knex('line_items')
        .where({ tenant_id: row.tenant_id, product_id: row.id, code: variant.code })
        .update({ code, category_name: target.name, category_code: target.code, updated_at: knex.fn.now() });
    }
  }
}

/**
 * One tick of the Master's clock, so the panels see the change as the newest
 * edit. Null when the clock has never ticked — then the rows keep their stamp
 * and the new boot id still makes every panel refetch.
 */
async function tickClock(knex: Knex): Promise<string | null> {
  const clock = await knex('master_clock')
    .where({ id: 1 })
    .forUpdate()
    .first<{ device_code: string; physical: string; counter: number } | undefined>();
  if (!clock) return null;
  const { state, hlc } = tickHlc(
    { deviceCode: clock.device_code, physical: Number(clock.physical), counter: clock.counter },
    Date.now(),
  );
  await knex('master_clock').where({ id: 1 }).update({ physical: state.physical, counter: state.counter });
  return hlc;
}

export async function down(): Promise<void> {
  // Nothing. The old rows were transcription slips, not data worth restoring.
}
