/**
 * The seam where rate redaction becomes a **layout** fact
 * (`docs/backend-modules/10-TESTING.md` §6.7). Pure — no database, no PDF
 * library, no cluster, so this suite cannot silently skip.
 *
 * The distinction every assertion here defends: a redacted money field must be
 * **absent**, not present-and-zero and not present-and-null. A `0` on a
 * document handed to a customer is a claim about the price; a blank is a claim
 * about the reader. Only one of those is true.
 */

import { describe, expect, it } from 'vitest';
import type { Lead, LineItem, MasterIdentity, Party } from '@orderbook/shared';

import { buildDocumentModel } from '../src/domain/document-model.js';
import {
  containsDevanagari,
  formatDateForDocument,
  formatMinorUnits,
  splitByScript,
} from '../src/domain/document-text.js';
import { TEMPLATE_DEFAULTS, normaliseLayout, textStyle } from '@orderbook/shared';

const IDENTITY: MasterIdentity = {
  masterUniqueId: 'm1',
  tenantId: 't1',
  companyName: 'Sharma Tiles',
  lanIps: [],
  port: 4100,
  setupCompletedAt: '2026-01-01T00:00:00.000Z',
};

const PARTY = {
  id: 'PT1',
  name: 'Patel Ceramics',
  addressLine1: 'Plot 14',
  addressLine2: null,
  city: 'Morbi',
  state: 'Gujarat',
  pincode: '363641',
  gstNumber: '24ABCDE1234F1Z5',
  phone: '9876543210',
} as unknown as Party;

function lineItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: 'LI1',
    tenantId: 't1',
    parentType: 'lead',
    parentId: 'LD1',
    productId: 'PR1',
    productName: 'Ivory Basin',
    alias: null,
    rate: 125_000,
    code: 'C-100',
    sin: null,
    size: '600x600',
    weightKg: null,
    grade: null,
    productType: null,
    packaging: 'Box',
    sequence: 1,
    fromPartyVariant: false,
    imagePath: null,
    notes: null,
    quantities: [{ id: 'q1', colour: 'Ivory', quantity: 12 }],
    totalQuantity: 12,
    lineTotal: 1_500_000,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'LD0000000001',
    tenantId: 't1',
    partyId: 'PT1',
    partyName: 'Patel Ceramics',
    ownerId: 'u1',
    ownerName: null,
    stageId: 's1',
    stageName: 'New',
    stageSequence: 1,
    sourcePlatform: null,
    followUpDate: null,
    partyWiseMode: false,
    notes: null,
    customFields: {},
    incomplete: false,
    missingFields: [],
    convertedOrderId: null,
    convertedAt: null,
    totalAmount: 1_500_000,
    sourcePanelId: null,
    createdByUserId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    sync: { version: 1, hlc: 'h', fieldHlc: {}, temporaryId: null },
    items: [lineItem()],
    timeline: [],
    ...overrides,
  };
}

const GEOMETRY = {
  paperSize: TEMPLATE_DEFAULTS.quotation.paperSize,
  orientation: TEMPLATE_DEFAULTS.quotation.orientation,
  margins: TEMPLATE_DEFAULTS.quotation.margins,
};

/** The shipped default, converted to placed elements the way the mapper does. */
const LAYOUT = normaliseLayout(TEMPLATE_DEFAULTS.quotation.layout, GEOMETRY);

const TEMPLATE = {
  ...TEMPLATE_DEFAULTS.quotation,
  layout: LAYOUT,
  logoAssetId: null,
  signatureAssetId: null,
};

function build(ratesIncluded: boolean, subject = lead()) {
  return buildDocumentModel({
    subject,
    subjectKind: 'lead',
    party: PARTY,
    template: TEMPLATE,
    identity: IDENTITY,
    ratesIncluded,
    colourHex: new Map([['Ivory', '#F5F0E1']]),
    issuedOn: '2026-08-20',
    layout: LAYOUT,
  });
}

describe('document model — rate redaction is a layout fact', () => {
  it('PDF-6: rate and line-total columns are ABSENT from the model when rates are out', () => {
    const model = build(false);
    const keys = model.columns.map((column) => column.key);

    expect(keys).not.toContain('rate');
    expect(keys).not.toContain('lineTotal');
    // And not merely hidden — the row cells carry no such key either.
    expect('rate' in model.rows[0]!.cells).toBe(false);
    expect('lineTotal' in model.rows[0]!.cells).toBe(false);
  });

  it('PDF-7: the totals block is omitted entirely, not rendered as zero', () => {
    const model = build(false);

    expect(model.totals).toBeNull();
    // The totals block used to be filtered out of a list of blocks. It is now
    // a pair of elements that were never built, because the binding they name
    // is money and this reader is not seeing money.
    expect(
      model.elements.some((element) => element.kind === 'text' && element.label === 'Total'),
    ).toBe(false);
  });

  it('PDF-8: both columns and the totals block are present when rates are included', () => {
    const model = build(true);
    const keys = model.columns.map((column) => column.key);

    expect(keys).toContain('rate');
    expect(keys).toContain('lineTotal');
    expect(model.totals?.grandTotal).toBe('15,000.00');
    expect(
      model.elements.some((element) => element.kind === 'text' && element.label === 'Total'),
    ).toBe(true);
  });

  it('PDF-9: a template with showRates=false drops rates even for a rate-permitted actor', () => {
    // `ratesIncluded` is `template.showRates && canSeeRates(actor)`, decided by
    // the caller — this asserts the model honours a `false` whatever its source.
    const model = buildDocumentModel({
      subject: lead(),
      subjectKind: 'lead',
      party: PARTY,
      template: { ...TEMPLATE, showRates: false },
      identity: IDENTITY,
      ratesIncluded: false,
      colourHex: new Map(),
      issuedOn: '2026-08-20',
      layout: LAYOUT,
    });

    expect(model.columns.map((c) => c.key)).not.toContain('rate');
    expect(model.totals).toBeNull();
  });

  it('PDF-10: an already-masked subject carries no rate key into the model', () => {
    // This is what `maskLead` produces for a rate-blind actor: the keys are
    // deleted, not nulled. The model must not resurrect them as zeros.
    const masked = lead({ items: [lineItem({ rate: undefined, lineTotal: undefined })] });
    delete (masked as { totalAmount?: number }).totalAmount;

    const model = build(false, masked);

    expect('rate' in model.rows[0]!.cells).toBe(false);
    expect(model.totals).toBeNull();
  });

  it('PDF-11: colour chips carry the hex from the option list, and null when a colour has none', () => {
    const subject = lead({
      items: [
        lineItem({
          quantities: [
            { id: 'q1', colour: 'Ivory', quantity: 12 },
            { id: 'q2', colour: 'Cobalt', quantity: 3 },
          ],
        }),
      ],
    });

    const model = build(true, subject);
    const chips = model.rows[0]!.chips;

    expect(chips[0]).toMatchObject({ colour: 'Ivory', hex: '#F5F0E1' });
    // Absent from the map, so null — the renderer draws a lettered ring rather
    // than inventing a grey swatch, which would state the tile is grey.
    expect(chips[1]).toMatchObject({ colour: 'Cobalt', hex: null });
  });

  it('PDF-12: the party block is dropped when the template turns it off', () => {
    const model = buildDocumentModel({
      subject: lead(),
      subjectKind: 'lead',
      party: PARTY,
      template: { ...TEMPLATE, showPartyBlock: false },
      identity: IDENTITY,
      ratesIncluded: true,
      colourHex: new Map(),
      issuedOn: '2026-08-20',
      layout: LAYOUT,
    });

    expect(model.party).toBeNull();

    // The switch used to filter a block out of the list; it now stops every
    // element bound to the party from being built at all. Same guarantee, one
    // level finer — the text is not on the page because it was never resolved.
    const text = model.elements
      .filter((element) => element.kind === 'text')
      .map((element) => (element.kind === 'text' ? element.text : ''));

    expect(text).not.toContain(PARTY.name);
  });

  it('PDF-78: an element bound to money is ABSENT for a rate-blind reader', () => {
    const withRates = build(true);
    const withoutRates = build(false);

    const totalOf = (model: ReturnType<typeof build>): string[] =>
      model.elements
        .filter((element) => element.kind === 'text')
        .map((element) => (element.kind === 'text' ? element.text : ''))
        .filter((value) => value.includes('₹'));

    expect(totalOf(withRates).length).toBeGreaterThan(0);

    // Absent, not blanked and not zeroed. There is no element in the list for
    // the renderer to draw, which is the same guarantee the rate column has.
    expect(totalOf(withoutRates)).toEqual([]);
    expect(
      withoutRates.elements.some((element) => element.kind === 'text' && element.label === 'Total'),
    ).toBe(false);
  });

  it('PDF-81: a character limit is applied before anything measures the text', () => {
    const model = buildDocumentModel({
      subject: lead(),
      subjectKind: 'lead',
      party: { ...PARTY, name: 'A very long trading name that would burst its box' },
      template: TEMPLATE,
      identity: IDENTITY,
      ratesIncluded: true,
      colourHex: new Map(),
      issuedOn: '2026-08-20',
      layout: {
        version: 2,
        elements: [
          ...LAYOUT.elements.filter((element) => element.kind === 'table'),
          {
            id: 'capped',
            kind: 'field',
            binding: { source: 'catalogue', binding: 'party.name' },
            label: null,
            labelPlacement: 'none',
            x: 15,
            y: 40,
            w: 40,
            h: 10,
            z: 1,
            band: 'body',
            flow: 'fixed',
            style: { ...textStyle(), maxChars: 10 },
          },
        ],
      },
    });

    const capped = model.elements.find((element) => element.id === 'capped');
    expect(capped?.kind === 'text' && capped.text).toBe('A very lon');
  });
});

describe('document text — script splitting and date safety', () => {
  it('PDF-13: a mixed line splits into runs so each can be drawn in its own face', () => {
    const runs = splitByScript('शर्मा टाइल्स (Sharma Tiles)');

    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0]!.script).toBe('devanagari');
    expect(runs.some((run) => run.script === 'body')).toBe(true);
    // Nothing is lost or duplicated in the split.
    expect(runs.map((run) => run.text).join('')).toBe('शर्मा टाइल्स (Sharma Tiles)');
  });

  it('PDF-14: a space between two Devanagari words does not start a Latin run', () => {
    const runs = splitByScript('शर्मा टाइल्स');

    expect(runs).toHaveLength(1);
    expect(runs[0]!.script).toBe('devanagari');
  });

  it('PDF-15: a pure-Latin string in a mono column stays one mono run', () => {
    const runs = splitByScript('LD0000000042', 'mono');

    expect(runs).toHaveLength(1);
    expect(runs[0]!.script).toBe('mono');
  });

  it('PDF-16: containsDevanagari answers honestly for both scripts', () => {
    expect(containsDevanagari('Sharma Tiles')).toBe(false);
    expect(containsDevanagari('शर्मा')).toBe(true);
  });

  it('PDF-17: a date formats from its components — the day never shifts east of UTC', () => {
    // `new Date('2026-08-01')` is midnight UTC; `toISOString()` on an IST
    // machine hands back 2026-07-31. This function never constructs a Date, so
    // the 1st is the 1st regardless of where the server sits.
    expect(formatDateForDocument('2026-08-01')).toBe('1 Aug 2026');
    expect(formatDateForDocument('2026-01-01')).toBe('1 Jan 2026');
    expect(formatDateForDocument('2026-12-31')).toBe('31 Dec 2026');
  });

  it('PDF-18: an unparseable date prints verbatim rather than as "Invalid Date"', () => {
    expect(formatDateForDocument('not-a-date')).toBe('not-a-date');
    expect(formatDateForDocument(null)).toBe('');
  });

  it('PDF-19: money groups the Indian way, in Western Arabic digits', () => {
    // Devanagari digits are correct Hindi orthography and completely wrong on
    // a document that has to be checked against a bank statement.
    expect(formatMinorUnits(1_500_000)).toBe('15,000.00');
    expect(formatMinorUnits(123_456_789)).toBe('12,34,567.89');
    expect(formatMinorUnits(99)).toBe('0.99');
    expect(formatMinorUnits(-50_000)).toBe('-500.00');
  });

  it('PDF-20: a redacted money value formats to an empty cell, never to 0.00', () => {
    expect(formatMinorUnits(null)).toBe('');
    expect(formatMinorUnits(undefined)).toBe('');
  });
});
