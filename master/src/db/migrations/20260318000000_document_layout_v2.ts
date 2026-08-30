/**
 * PDF Designer — the layout becomes geometry.
 *
 * `document_templates.layout` held six named sections in flow order and no
 * positions. It now holds placed elements. This rewrites every existing row and
 * moves the column default to match.
 *
 * **The converter below is inlined and frozen as of 2026-08-30**, never
 * imported from `@orderbook/shared`, for the reason the `20260308` header
 * states: a migration is a fixed historical fact, and `20260301` imported the
 * live permission catalogue — after which editing that catalogue silently
 * changed what an already-applied migration had done. The live converter will
 * go on evolving; this copy must not. `master/tests/document-layout-migration.test.ts`
 * pins the two together as of today, so a future change to the shared one is a
 * deliberate decision rather than a surprise.
 *
 * **`layout_v1` is a backup column, not scaffolding.** This is a one-way
 * rewrite of a company's live templates, so `down()` restores the exact bytes
 * rather than trying to convert backwards — an inverse of this conversion
 * would be a guess, and a guess about a document a customer has already
 * received is not worth making.
 *
 * The numbers are the renderer's own as of this date, in points, divided by
 * 72/25.4 to reach millimetres.
 */

import type { Knex } from 'knex';

/** 72 points to the inch, 25.4 millimetres to the inch. Frozen. */
const PT_PER_MM = 72 / 25.4;
const mmFromPt = (points: number): number => points / PT_PER_MM;

/** Paper in millimetres, frozen as of 2026-08-30. */
const PAPER_MM: Record<string, [number, number]> = {
  A4: [210, 297],
  A5: [148, 210],
  Letter: [215.9, 279.4],
};

/** The strip the page footer is written into on the renderer's second pass. */
const FOOTER_RESERVE_MM = mmFromPt(24);

interface FrozenBlock {
  kind: string;
  align?: string;
  groupByProduct?: boolean;
  showBoxCount?: boolean;
  label?: string;
}

interface FrozenGeometry {
  paperSize: string;
  orientation: string;
  margins: { top: number; right: number; bottom: number; left: number };
  hasLogo: boolean;
  hasSignature: boolean;
}

const style = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  face: 'body',
  bold: false,
  size: 8,
  colour: null,
  align: 'left',
  padding: 0,
  lineHeight: 1.45,
  maxChars: 0,
  fit: 'truncate',
  ...patch,
});

/**
 * The frozen twin of `blocksToElements`.
 *
 * Kept structurally identical to the shared one so the pinning test can compare
 * outputs directly rather than by eye.
 */
function convert(blocks: FrozenBlock[], geometry: FrozenGeometry): Record<string, unknown>[] {
  const [shortEdge, longEdge] = PAPER_MM[geometry.paperSize] ?? PAPER_MM.A4!;
  const page =
    geometry.orientation === 'landscape'
      ? { width: longEdge!, height: shortEdge! }
      : { width: shortEdge!, height: longEdge! };

  const left = geometry.margins.left;
  const right = page.width - geometry.margins.right;
  const width = right - left;
  const bottomLimit = page.height - geometry.margins.bottom - FOOTER_RESERVE_MM;

  const elements: Record<string, unknown>[] = [];
  let cursorY = geometry.margins.top;
  let z = 0;
  let sequence = 0;

  const place = (element: Record<string, unknown>): void => {
    z += 1;
    sequence += 1;
    elements.push({ ...element, id: `${String(element.kind)}-${sequence}`, z });
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'header': {
        const top = cursorY;
        const centred = block.align === 'centre';

        if (geometry.hasLogo) {
          place({
            kind: 'image',
            slot: 'logo',
            x: left,
            y: top,
            w: mmFromPt(90),
            h: mmFromPt(36),
            band: 'header',
            flow: 'fixed',
          });
        }

        const nameLeft = geometry.hasLogo ? left + mmFromPt(100) : left;

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'company.name' },
          label: null,
          labelPlacement: 'none',
          x: centred ? left : nameLeft,
          y: top,
          w: centred ? width : right - nameLeft,
          h: mmFromPt(18),
          band: 'header',
          flow: 'fixed',
          style: style({ size: 15, bold: true, align: centred ? 'centre' : 'left' }),
        });

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'document.title' },
          label: null,
          labelPlacement: 'none',
          x: left,
          y: centred ? top + mmFromPt(18) : top,
          w: width,
          h: mmFromPt(16),
          band: 'header',
          flow: 'fixed',
          style: style({ size: 13, bold: true, align: centred ? 'centre' : 'right' }),
        });

        const refLeft = right - mmFromPt(150);

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'document.reference' },
          label: 'Ref',
          labelPlacement: 'before',
          x: refLeft,
          y: top + mmFromPt(20),
          w: right - refLeft,
          h: mmFromPt(11),
          band: 'header',
          flow: 'fixed',
          style: style({ size: 8 }),
        });

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'document.issuedOn' },
          label: 'Date',
          labelPlacement: 'before',
          x: refLeft,
          y: top + mmFromPt(31),
          w: right - refLeft,
          h: mmFromPt(11),
          band: 'header',
          flow: 'fixed',
          style: style({ size: 8 }),
        });

        place({
          kind: 'rule',
          colour: null,
          thickness: 0.5,
          x: left,
          y: top + mmFromPt(44),
          w: width,
          h: 0,
          band: 'header',
          flow: 'fixed',
        });

        cursorY = top + mmFromPt(52);
        break;
      }

      case 'party': {
        const top = cursorY;
        const addressHeight = mmFromPt(40);

        place({
          kind: 'text',
          text: 'To',
          x: left,
          y: top,
          w: width / 2,
          h: mmFromPt(10),
          band: 'body',
          flow: 'fixed',
          style: style({ size: 7.5, colour: '#777777' }),
        });

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'party.name' },
          label: null,
          labelPlacement: 'none',
          x: left,
          y: top + mmFromPt(10),
          w: width / 2,
          h: mmFromPt(14),
          band: 'body',
          flow: 'fixed',
          style: style({ size: 10.5, bold: true }),
        });

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'party.addressLines' },
          label: null,
          labelPlacement: 'none',
          x: left,
          y: top + mmFromPt(24),
          w: width / 2,
          h: addressHeight,
          band: 'body',
          flow: 'fixed',
          style: style({ size: 8, fit: 'wrap', lineHeight: 10 / 8 }),
        });

        cursorY = top + mmFromPt(24) + addressHeight + mmFromPt(8);
        break;
      }

      case 'lines': {
        const top = cursorY;
        const designed = Math.max(mmFromPt(18 + 16 * 8), mmFromPt(18));
        const height = Math.min(designed, bottomLimit - top);

        place({
          kind: 'table',
          columns: [],
          rowHeightMm: mmFromPt(16),
          headingHeightMm: mmFromPt(18),
          repeatHeadingOnBreak: true,
          headingFill: '#F4F4F5',
          groupByProduct: block.groupByProduct === true,
          headingStyle: style({ size: 7.5, bold: true, colour: '#444444' }),
          cellStyle: style({ size: 8 }),
          x: left,
          y: top,
          w: width,
          h: height,
          band: 'body',
          flow: 'fixed',
        });

        cursorY = top + height + mmFromPt(10);
        break;
      }

      case 'totals': {
        let y = cursorY + mmFromPt(4);
        const boxWidth = mmFromPt(220);

        if (block.showBoxCount === true) {
          place({
            kind: 'field',
            binding: { source: 'catalogue', binding: 'document.boxCount' },
            label: 'Boxes',
            labelPlacement: 'before',
            x: right - boxWidth,
            y,
            w: boxWidth,
            h: mmFromPt(14),
            band: 'body',
            flow: 'after-table',
            style: style({ size: 8.5, colour: '#555555', face: 'mono', align: 'right' }),
          });
          y += mmFromPt(14);
        }

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'document.grandTotal' },
          label: 'Total',
          labelPlacement: 'before',
          x: right - boxWidth,
          y,
          w: boxWidth,
          h: mmFromPt(18),
          band: 'body',
          flow: 'after-table',
          style: style({ size: 11, bold: true, face: 'mono', align: 'right' }),
        });

        cursorY = y + mmFromPt(18);
        break;
      }

      case 'terms': {
        // The block's own `text` is deliberately not carried: the model has
        // always read the template's `terms_text` column, so converting the
        // block's copy would resurrect a value no customer has ever seen.
        const top = cursorY;
        const bodyHeight = mmFromPt(48);

        place({
          kind: 'text',
          text: 'Terms',
          x: left,
          y: top + mmFromPt(6),
          w: width,
          h: mmFromPt(10),
          band: 'body',
          flow: 'after-table',
          style: style({ size: 7.5, colour: '#777777' }),
        });

        place({
          kind: 'field',
          binding: { source: 'catalogue', binding: 'document.terms' },
          label: null,
          labelPlacement: 'none',
          x: left,
          y: top + mmFromPt(18),
          w: width * 0.7,
          h: bodyHeight,
          band: 'body',
          flow: 'after-table',
          style: style({ size: 8, colour: '#333333', fit: 'wrap', maxChars: 500 }),
        });

        cursorY = top + mmFromPt(18) + bodyHeight + mmFromPt(10);
        break;
      }

      case 'signature': {
        // Converted to what it does rather than what its position implied: the
        // draw code's vertical clamp reduces to a constant, so the block has
        // always printed at the foot of the page.
        const top = bottomLimit - mmFromPt(62);
        const boxLeft = right - mmFromPt(160);

        if (geometry.hasSignature) {
          place({
            kind: 'image',
            slot: 'signature',
            x: boxLeft,
            y: top,
            w: mmFromPt(150),
            h: mmFromPt(34),
            band: 'body',
            flow: 'fixed',
          });
        }

        place({
          kind: 'rule',
          colour: '#999999',
          thickness: 0.5,
          x: boxLeft,
          y: top + mmFromPt(40),
          w: mmFromPt(160),
          h: 0,
          band: 'body',
          flow: 'fixed',
        });

        place({
          kind: 'text',
          text: block.label ?? '',
          x: boxLeft,
          y: top + mmFromPt(44),
          w: mmFromPt(160),
          h: mmFromPt(12),
          band: 'body',
          flow: 'fixed',
          style: style({ size: 7.5, colour: '#666666' }),
        });

        cursorY = Math.max(cursorY, top + mmFromPt(62));
        break;
      }

      default:
        break;
    }
  }

  return elements;
}

/** Exported for the pinning test, which is the only other caller. */
export const __frozenConvert = convert;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('document_templates', (table) => {
    // The original bytes, so `down()` restores rather than guesses.
    table.jsonb('layout_v1').nullable();
  });

  await knex.raw(`
    UPDATE document_templates
       SET layout_v1 = layout
     WHERE layout_v1 IS NULL
  `);

  // Every row still on the old shape, including soft-deleted ones: a template
  // in the recycle bin can be restored, and it must come back usable.
  const rows = await knex('document_templates')
    .whereRaw(`layout->>'version' IS NULL`)
    .select(
      'id',
      'layout',
      'paper_size',
      'orientation',
      'margin_top_mm',
      'margin_right_mm',
      'margin_bottom_mm',
      'margin_left_mm',
      'show_logo',
      'show_signature',
      'logo_asset_id',
      'signature_asset_id',
    );

  for (const row of rows) {
    const raw = row.layout as { blocks?: FrozenBlock[] } | null;
    const blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];

    const elements = convert(blocks, {
      paperSize: String(row.paper_size ?? 'A4'),
      orientation: String(row.orientation ?? 'portrait'),
      margins: {
        top: Number(row.margin_top_mm),
        right: Number(row.margin_right_mm),
        bottom: Number(row.margin_bottom_mm),
        left: Number(row.margin_left_mm),
      },
      hasLogo: Boolean(row.show_logo) && Boolean(row.logo_asset_id),
      hasSignature: Boolean(row.show_signature) && Boolean(row.signature_asset_id),
    });

    await knex('document_templates')
      .where({ id: row.id })
      .update({ layout: JSON.stringify({ version: 2, elements }) });
  }

  /*
   * The column default moves with the data.
   *
   * A row inserted without a layout has to land on something the validator
   * accepts, and the validator now insists on exactly one table. The old
   * default said `{"blocks":[{"kind":"lines",...}]}`, which no longer parses as
   * a layout at all.
   */
  await knex.raw(`
    ALTER TABLE document_templates
      ALTER COLUMN layout SET DEFAULT '{"version":2,"elements":[{"id":"table-1","kind":"table","columns":[],"rowHeightMm":5.6444,"headingHeightMm":6.35,"repeatHeadingOnBreak":true,"headingFill":"#F4F4F5","groupByProduct":false,"headingStyle":{"face":"body","bold":true,"size":7.5,"colour":"#444444","align":"left","padding":0,"lineHeight":1.45,"maxChars":0,"fit":"truncate"},"cellStyle":{"face":"body","bold":false,"size":8,"colour":null,"align":"left","padding":0,"lineHeight":1.45,"maxChars":0,"fit":"truncate"},"x":15,"y":60,"w":180,"h":100,"z":1,"band":"body","flow":"fixed"}]}'::jsonb
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE document_templates
      ALTER COLUMN layout SET DEFAULT '{"blocks":[{"kind":"lines","groupByProduct":false}]}'::jsonb
  `);

  // The exact bytes back, for every row that had them. A row created after this
  // migration has no backup and keeps its elements — converting backwards would
  // be inventing a block order that never existed.
  await knex.raw(`
    UPDATE document_templates
       SET layout = layout_v1
     WHERE layout_v1 IS NOT NULL
  `);

  await knex.schema.alterTable('document_templates', (table) => {
    table.dropColumn('layout_v1');
  });
}
