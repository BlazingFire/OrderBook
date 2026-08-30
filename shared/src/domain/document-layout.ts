/**
 * The page as a set of placed elements, and the conversion from the ordered
 * blocks that came before it.
 *
 * Version 1 was a closed grammar of six blocks in flow order with no geometry
 * at all — a template could say "party, then lines, then totals" and nothing
 * more. Version 2 says where things go.
 *
 * **Millimetres, from the top-left of the paper.** Margins were already
 * millimetres on the template, a designer canvas has to show a page rather
 * than a printable area, and PDFKit's origin is already top-left with y
 * increasing downward — so nothing here needs an axis flip and nothing leaks
 * the renderer's coordinate system into a type the browser reads. Type size
 * stays in points, because nobody sets a font in millimetres.
 *
 * Elements anchor to the **page**, not the margin box: what the canvas showed
 * is what prints. The consequence is accepted deliberately — changing paper
 * size does not rescale a layout, so a smaller page can push an element off
 * the sheet and validation refuses that save rather than moving somebody's
 * design without telling them.
 *
 * Nothing here knows what a lead or an order is. An element names a *binding*;
 * resolving one to text, and deciding whether this reader may see it at all,
 * happens on the Master where the permissions are.
 */

import type { DocumentBlock, PaperSize, PageOrientation } from './documents.js';

/** 72 points to the inch, 25.4 millimetres to the inch. */
export const PT_PER_MM = 72 / 25.4;

export const mmFromPt = (points: number): number => points / PT_PER_MM;

/**
 * Paper in millimetres.
 *
 * The renderer keeps its own copy in points (`PAGE_SIZES`, `master/src/pdf/renderer.ts`)
 * so a page size never has to be computed mid-render; a test pins the two
 * against each other rather than having one import the other across the
 * package boundary.
 */
export const PAPER_MM: Readonly<Record<PaperSize, readonly [number, number]>> = {
  A4: [210, 297],
  A5: [148, 210],
  Letter: [215.9, 279.4],
} as const;

export function pageSizeMm(
  paper: PaperSize,
  orientation: PageOrientation,
): { width: number; height: number } {
  const [shortEdge, longEdge] = PAPER_MM[paper];
  return orientation === 'landscape'
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge };
}

/**
 * Where an element sits in the page's vertical story.
 *
 * `header` and `footer` repeat on every page; `body` is drawn once. This is the
 * only concept of a page an element has — there is deliberately no `page: 3`,
 * because the number of pages depends on how many rows the order has.
 */
export type ElementBand = 'header' | 'body' | 'footer';

/**
 * Whether a body element rides the table's growth.
 *
 * `fixed` stays where it was placed. `after-table` moves by however much the
 * table grew or shrank against its designed height — one delta, applied once,
 * which is what makes a totals block sit under sixty rows as readily as under
 * three without a reflow engine.
 */
export type ElementFlow = 'fixed' | 'after-table';

/** The two vendored families a designer may choose. Devanagari is never chosen
 *  here — it is selected per run from the text itself, because a party name
 *  mixes scripts inside one string. */
export type TextFace = 'body' | 'mono';

/**
 * What to do when the text does not fit the box.
 *
 * `wrap` grows downward past the box, which is what a terms paragraph has
 * always done. `shrink` keeps the box and steps the size down. `truncate` is
 * one line with an ellipsis. `clip` wraps and draws only the lines that fit.
 */
export type TextFit = 'wrap' | 'shrink' | 'truncate' | 'clip';

export interface ElementTextStyle {
  face: TextFace;
  bold: boolean;
  /** Points. */
  size: number;
  /** `#RRGGBB`, or null to take the template's accent colour. */
  colour: string | null;
  align: 'left' | 'centre' | 'right';
  /** Millimetres of inset on every side. */
  padding: number;
  /** Multiplier on the size. 1.45 is what `wrappedRunText` has always used. */
  lineHeight: number;
  /** 0 means no limit. Applied to a resolved value before it is measured. */
  maxChars: number;
  fit: TextFit;
}

export const DEFAULT_TEXT_STYLE: ElementTextStyle = {
  face: 'body',
  bold: false,
  size: 8,
  colour: null,
  align: 'left',
  padding: 0,
  lineHeight: 1.45,
  maxChars: 0,
  fit: 'truncate',
};

export const textStyle = (patch: Partial<ElementTextStyle> = {}): ElementTextStyle => ({
  ...DEFAULT_TEXT_STYLE,
  ...patch,
});

/**
 * What an element prints.
 *
 * `catalogue` names one of a closed set the Master resolves and permission-checks;
 * `custom` names a field somebody defined on the Fields screen, resolved out of
 * the record's own `customFields` blob and nothing else. Keeping them separate
 * namespaces is what stops a custom field ever naming a priced one.
 */
export type DocumentBindingRef =
  | { source: 'catalogue'; binding: string }
  | { source: 'custom'; entity: 'lead' | 'order' | 'party'; key: string };

export type ElementLabelPlacement = 'none' | 'before' | 'above';

interface ElementBase {
  id: string;
  /** Millimetres from the page's top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Paint order. PDFKit has no z-index, so this is the order of the calls. */
  z: number;
  band: ElementBand;
  flow: ElementFlow;
}

/**
 * A column of the one table.
 *
 * `key` is the closed `DocumentColumnKey` union the model already uses, so an
 * operator can reorder columns, rename their headings and drag their widths
 * but cannot invent one — which is what keeps a rate out of a rate-blind
 * document by construction. Widths stay **relative weights** rather than
 * millimetres for the same reason: when the rate column is dropped, the
 * survivors renormalise across the full width on their own.
 */
export interface TableColumnSpec {
  key: string;
  /** null takes the model's own translated heading. */
  heading: string | null;
  align: 'left' | 'right';
  weight: number;
}

export type DocumentElement =
  | (ElementBase & { kind: 'text'; text: string; style: ElementTextStyle })
  | (ElementBase & {
      kind: 'field';
      binding: DocumentBindingRef;
      label: string | null;
      labelPlacement: ElementLabelPlacement;
      style: ElementTextStyle;
    })
  | (ElementBase & { kind: 'image'; slot: 'logo' | 'signature' })
  | (ElementBase & { kind: 'rule'; colour: string | null; thickness: number })
  | (ElementBase & { kind: 'box'; fill: string | null; stroke: string | null; radius: number })
  | (ElementBase & {
      kind: 'table';
      columns: TableColumnSpec[];
      rowHeightMm: number;
      headingHeightMm: number;
      repeatHeadingOnBreak: boolean;
      headingFill: string | null;
      groupByProduct: boolean;
      headingStyle: ElementTextStyle;
      cellStyle: ElementTextStyle;
    });

export type DocumentElementKind = DocumentElement['kind'];

export const DOCUMENT_ELEMENT_KINDS: readonly DocumentElementKind[] = [
  'text',
  'field',
  'image',
  'rule',
  'box',
  'table',
];

/**
 * The stored layout, discriminated on `version` at the top level.
 *
 * A tagged union rather than optional fields, so nothing downstream ever reads
 * `layout.elements ?? convert(layout.blocks)` for the rest of the product's
 * life. `normaliseLayout` narrows it to v2 once, at the mapper.
 */
export type DocumentLayoutV1 = { version?: 1; blocks: DocumentBlock[] };
export type DocumentLayoutV2 = { version: 2; elements: DocumentElement[] };
export type StoredDocumentLayout = DocumentLayoutV1 | DocumentLayoutV2;

/** The most a layout may carry. `/preview` sends the whole template through the
 *  Office panel's 1 MB JSON limit, and a ceiling found in production is found
 *  by a customer. */
export const MAX_ELEMENTS = 200;
export const MAX_ELEMENT_CHARS = 2000;
export const SHRINK_FLOOR_PT = 5;

export interface PageGeometry {
  paperSize: PaperSize;
  orientation: PageOrientation;
  margins: { top: number; right: number; bottom: number; left: number };
}

/**
 * How much of the page the flow region may use.
 *
 * `- 24pt` reproduces the renderer's own `bottomLimit`, which reserves the
 * strip the page footer is written into on the second pass.
 */
export const FOOTER_RESERVE_MM = mmFromPt(24);

let sequence = 0;

/** Ids are stable within a layout and meaningless outside it, so a counter is
 *  enough — and unlike `randomUUID` it keeps the converter pure, which is what
 *  lets a test compare two conversions for equality. */
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** Test seam, so a conversion's ids are reproducible run to run. */
export function resetElementIds(): void {
  sequence = 0;
}

interface Cursor {
  /** Millimetres down the page, where the next block starts. */
  y: number;
  z: number;
}

/**
 * Turn the ordered blocks of a version 1 layout into placed elements that print
 * the same.
 *
 * Every number below is the renderer's own, taken from `master/src/pdf/renderer.ts`
 * and divided by `PT_PER_MM`. That duplication is deliberate and it is pinned
 * by a test: the alternative is the shared package importing the Master's PDF
 * code, which would put PDFKit in the browser's dependency graph.
 *
 * Two blocks convert to less than they appear to. A `terms` block's own `text`
 * has never been drawn — `buildDocumentModel` reads the template's `termsText`
 * column — so it is dropped rather than carried. And a `signature` block has
 * always been pinned to the bottom of the page regardless of where it fell in
 * the order, because its vertical clamp reduces to a constant; it converts to
 * what it does, not to what the ordering implied.
 */
export function blocksToElements(
  blocks: readonly DocumentBlock[],
  geometry: PageGeometry,
  options: { hasLogo?: boolean; hasSignature?: boolean } = {},
): DocumentElement[] {
  const page = pageSizeMm(geometry.paperSize, geometry.orientation);
  const left = geometry.margins.left;
  const right = page.width - geometry.margins.right;
  const width = right - left;
  const bottomLimit = page.height - geometry.margins.bottom - FOOTER_RESERVE_MM;

  const elements: DocumentElement[] = [];
  const cursor: Cursor = { y: geometry.margins.top, z: 0 };

  const place: Place = (element) => {
    cursor.z += 1;
    elements.push({ ...element, z: cursor.z } as DocumentElement);
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'header':
        headerElements(block.align, { left, right, width, geometry }, cursor, place, options);
        break;
      case 'party':
        partyElements(left, width, cursor, place);
        break;
      case 'lines':
        cursor.y = tableElement(block.groupByProduct, left, width, cursor, place, bottomLimit);
        break;
      case 'totals':
        totalsElements(block.showBoxCount, right, cursor, place);
        break;
      case 'terms':
        termsElements(left, width, cursor, place);
        break;
      case 'signature':
        signatureElements(block.label, right, bottomLimit, cursor, place, options);
        break;
    }
  }

  return elements;
}

/**
 * `Omit` over a union collapses it to the keys every member shares, which
 * would leave a placer that accepts no `text`, no `binding` and no `slot`.
 * Distributing it over the members keeps each variant whole.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Place = (element: DistributiveOmit<DocumentElement, 'z'>) => void;

/** `drawHeader`: logo, company name, right-aligned title, a Ref/Date pair, and
 *  a rule 8pt above a block bottom that is always 52pt down. */
function headerElements(
  align: 'left' | 'centre',
  box: { left: number; right: number; width: number; geometry: PageGeometry },
  cursor: Cursor,
  place: Place,
  options: { hasLogo?: boolean; hasSignature?: boolean },
): void {
  const { left, right, width } = box;
  const top = cursor.y;
  const centred = align === 'centre';

  if (options.hasLogo) {
    place({
      id: nextId('logo'),
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

  const nameLeft = options.hasLogo ? left + mmFromPt(100) : left;

  place({
    id: nextId('company'),
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
    style: textStyle({ size: 15, bold: true, align: centred ? 'centre' : 'left' }),
  });

  place({
    id: nextId('title'),
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
    style: textStyle({ size: 13, bold: true, align: centred ? 'centre' : 'right' }),
  });

  // `keyValueBlock` at (right - 150, top + 20), 11pt line height, label and
  // value on one baseline — which is what `labelPlacement: 'before'` means.
  const refLeft = right - mmFromPt(150);
  place({
    id: nextId('ref'),
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
    style: textStyle({ size: 8 }),
  });

  place({
    id: nextId('issued'),
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
    style: textStyle({ size: 8 }),
  });

  place({
    id: nextId('headrule'),
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

  cursor.y = top + mmFromPt(52);
}

/** `drawParty`: a 7.5pt "To", the name at +10pt, then address lines from +24pt
 *  on a 10pt step, and 8pt of air below. */
function partyElements(left: number, width: number, cursor: Cursor, place: Place): void {
  const top = cursor.y;
  const addressHeight = mmFromPt(40);

  place({
    id: nextId('party-label'),
    kind: 'text',
    text: 'To',
    x: left,
    y: top,
    w: width / 2,
    h: mmFromPt(10),
    band: 'body',
    flow: 'fixed',
    style: textStyle({ size: 7.5, colour: '#777777' }),
  });

  place({
    id: nextId('party-name'),
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
    style: textStyle({ size: 10.5, bold: true }),
  });

  place({
    id: nextId('party-address'),
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
    // The resolver joins the lines with newlines and `wrapLines` splits on them
    // first, so the address keeps the breaks it was entered with instead of
    // being re-flowed into a paragraph.
    style: textStyle({ size: 8, fit: 'wrap', lineHeight: 10 / 8 }),
  });

  cursor.y = top + mmFromPt(24) + addressHeight + mmFromPt(8);
}

/** `drawTable`: an 18pt heading row on #F4F4F5, then 16pt rows. */
function tableElement(
  groupByProduct: boolean,
  left: number,
  width: number,
  cursor: Cursor,
  place: Place,
  bottomLimit: number,
): number {
  const top = cursor.y;
  // The designed height is what the flow delta is measured against: how far the
  // table's real bottom lands from here decides how much moves.
  const designed = Math.max(mmFromPt(18 + 16 * 8), mmFromPt(18));

  place({
    id: nextId('table'),
    kind: 'table',
    columns: [],
    rowHeightMm: mmFromPt(16),
    headingHeightMm: mmFromPt(18),
    repeatHeadingOnBreak: true,
    headingFill: '#F4F4F5',
    groupByProduct,
    headingStyle: textStyle({ size: 7.5, bold: true, colour: '#444444' }),
    cellStyle: textStyle({ size: 8 }),
    x: left,
    y: top,
    w: width,
    h: Math.min(designed, bottomLimit - top),
    band: 'body',
    flow: 'fixed',
  });

  return top + Math.min(designed, bottomLimit - top) + mmFromPt(10);
}

/** `drawTotals`: right-aligned, starting 4pt below the table. */
function totalsElements(showBoxCount: boolean, right: number, cursor: Cursor, place: Place): void {
  let y = cursor.y + mmFromPt(4);
  const boxWidth = mmFromPt(220);

  if (showBoxCount) {
    place({
      id: nextId('boxes'),
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
      style: textStyle({ size: 8.5, colour: '#555555', face: 'mono', align: 'right' }),
    });
    y += mmFromPt(14);
  }

  place({
    id: nextId('total'),
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
    style: textStyle({ size: 11, bold: true, face: 'mono', align: 'right' }),
  });

  cursor.y = y + mmFromPt(18);
}

/** `drawTerms`: a 7.5pt caption at +6pt, the paragraph at +18pt across 70% of
 *  the width. The text comes from the template's column, never the block. */
function termsElements(left: number, width: number, cursor: Cursor, place: Place): void {
  const top = cursor.y;
  const bodyHeight = mmFromPt(48);

  place({
    id: nextId('terms-label'),
    kind: 'text',
    text: 'Terms',
    x: left,
    y: top + mmFromPt(6),
    w: width,
    h: mmFromPt(10),
    band: 'body',
    flow: 'after-table',
    style: textStyle({ size: 7.5, colour: '#777777' }),
  });

  place({
    id: nextId('terms'),
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
    style: textStyle({ size: 8, colour: '#333333', fit: 'wrap', maxChars: 500 }),
  });

  cursor.y = top + mmFromPt(18) + bodyHeight + mmFromPt(10);
}

/**
 * `drawSignature`, converted to what it actually does.
 *
 * Its vertical position reduces to `bottomLimit - 62` for every input, so the
 * block has always been pinned to the bottom of the page whatever its place in
 * the order. It converts as a bottom-anchored, non-flowing group.
 */
function signatureElements(
  label: string,
  right: number,
  bottomLimit: number,
  cursor: Cursor,
  place: Place,
  options: { hasLogo?: boolean; hasSignature?: boolean },
): void {
  const top = bottomLimit - mmFromPt(62);
  const boxLeft = right - mmFromPt(160);

  if (options.hasSignature) {
    place({
      id: nextId('sign-image'),
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
    id: nextId('sign-rule'),
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
    id: nextId('sign-label'),
    kind: 'text',
    text: label,
    x: boxLeft,
    y: top + mmFromPt(44),
    w: mmFromPt(160),
    h: mmFromPt(12),
    band: 'body',
    flow: 'fixed',
    style: textStyle({ size: 7.5, colour: '#666666' }),
  });

  cursor.y = Math.max(cursor.y, top + mmFromPt(62));
}

/**
 * Narrow a stored layout to version 2, converting a version 1 blob on the way.
 *
 * Permanent, not a migration helper. It runs at the repository mapper and in
 * `materialise`, so a row restored from an old backup, or one an Office panel
 * is still holding, renders correctly rather than throwing — and nothing above
 * the mapper ever has to know version 1 existed.
 */
export function normaliseLayout(
  raw: unknown,
  geometry: PageGeometry,
  options: { hasLogo?: boolean; hasSignature?: boolean } = {},
): DocumentLayoutV2 {
  if (raw === null || typeof raw !== 'object') return { version: 2, elements: [] };

  const candidate = raw as Partial<DocumentLayoutV2> & Partial<DocumentLayoutV1>;

  if (candidate.version === 2 && Array.isArray(candidate.elements)) {
    return { version: 2, elements: candidate.elements };
  }

  if (Array.isArray(candidate.blocks)) {
    return { version: 2, elements: blocksToElements(candidate.blocks, geometry, options) };
  }

  // Neither shape. An empty layout still renders — the page comes out with its
  // watermark and footer and nothing else, which is a better answer for a
  // corrupt row than refusing to produce the document at all.
  return { version: 2, elements: [] };
}

export const isLayoutV2 = (layout: StoredDocumentLayout): layout is DocumentLayoutV2 =>
  (layout as DocumentLayoutV2).version === 2;
