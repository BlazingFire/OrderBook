/**
 * The template invariants and the `layout` block grammar — pure, so no
 * cluster and no skip (`docs/backend-modules/04-API-CONTRACT.md` §6.1).
 *
 * These rules cannot live in a SQL `CHECK`: "header must be first" is a
 * statement about an array's order, which a per-row constraint cannot see.
 * That is precisely why they need a test — nothing in the database will catch
 * a regression here.
 */

import { describe, expect, it } from 'vitest';
import { TEMPLATE_DEFAULTS } from '@orderbook/shared';

import {
  assertDefaultSwap,
  assertLayoutValid,
  assertTemplateAppliesTo,
  assertTemplateValid,
  nameTakenError,
  type TemplateShape,
} from '../src/domain/document-template.js';
import { ConflictError, ValidationError } from '../src/lib/errors.js';
import {
  normaliseLayout,
  textStyle,
  type DocumentElement,
  type DocumentLayoutV2,
} from '@orderbook/shared';

const GEOMETRY = {
  paperSize: TEMPLATE_DEFAULTS.quotation.paperSize,
  orientation: TEMPLATE_DEFAULTS.quotation.orientation,
  margins: TEMPLATE_DEFAULTS.quotation.margins,
};

function template(overrides: Partial<TemplateShape> = {}): TemplateShape {
  return {
    ...TEMPLATE_DEFAULTS.quotation,
    layout: normaliseLayout(TEMPLATE_DEFAULTS.quotation.layout, GEOMETRY),
    ...overrides,
  };
}

/** A version 2 layout carrying the one mandatory table, plus whatever else. */
function layout(...elements: DocumentElement[]): DocumentLayoutV2 {
  return {
    version: 2,
    elements: [
      {
        id: 'table',
        kind: 'table',
        columns: [],
        rowHeightMm: 5.6,
        headingHeightMm: 6.3,
        repeatHeadingOnBreak: true,
        headingFill: '#F4F4F5',
        groupByProduct: false,
        headingStyle: textStyle(),
        cellStyle: textStyle(),
        x: 15,
        y: 60,
        w: 180,
        h: 100,
        z: 0,
        band: 'body',
        flow: 'fixed',
      },
      ...elements,
    ],
  };
}

/** A text element with sensible geometry, so each test names only what it tests. */
function text(overrides: Record<string, unknown> = {}): DocumentElement {
  return {
    id: 'label',
    kind: 'text',
    text: 'Hello',
    x: 15,
    y: 20,
    w: 60,
    h: 10,
    z: 1,
    band: 'body',
    flow: 'fixed',
    style: textStyle(),
    ...overrides,
  } as DocumentElement;
}

/** Pulls the structured `details` off a thrown ValidationError. */
function detailsOf(run: () => void): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error.details ?? {};
    throw error;
  }
  throw new Error('expected a ValidationError, nothing was thrown');
}

describe('template invariants', () => {
  it('PDF-21: every shipped default validates — a default that fails its own validator is unsaveable', () => {
    for (const documentType of ['quotation', 'order_confirmation', 'dispatch_note'] as const) {
      // Converted first, the way the service does before it validates: a
      // default describes a document as blocks, and gains geometry against the
      // paper it is about to be printed on.
      const defaults = TEMPLATE_DEFAULTS[documentType];
      const shape = {
        ...defaults,
        layout: normaliseLayout(defaults.layout, {
          paperSize: defaults.paperSize,
          orientation: defaults.orientation,
          margins: defaults.margins,
        }),
      };

      expect(() => assertTemplateValid(shape), documentType).not.toThrow();
    }
  });

  it('PDF-22: a blank name is refused', () => {
    expect(detailsOf(() => assertTemplateValid(template({ name: '   ' })))).toMatchObject({
      field: 'name',
    });
  });

  it('PDF-23: an unknown paper size names what is allowed rather than failing silently', () => {
    const details = detailsOf(() => assertTemplateValid(template({ paperSize: 'Legal' as never })));
    expect(details.field).toBe('paperSize');
    expect(details.allowed).toEqual(['A4', 'A5', 'Letter']);
  });

  it('PDF-24: margins outside 5–50mm are refused, naming the edge', () => {
    const details = detailsOf(() =>
      assertTemplateValid(template({ margins: { top: 2, right: 15, bottom: 18, left: 15 } })),
    );
    expect(details).toMatchObject({ field: 'margins', edge: 'top', min: 5, max: 50 });
  });

  it('PDF-25: margins that leave no printable body are refused as exceeds_page', () => {
    const details = detailsOf(() =>
      assertTemplateValid(template({ margins: { top: 45, right: 15, bottom: 45, left: 15 } })),
    );
    expect(details).toMatchObject({ field: 'margins', reason: 'exceeds_page' });
  });

  it('PDF-26: an accent colour must be #RRGGBB', () => {
    expect(detailsOf(() => assertTemplateValid(template({ accentColour: 'teal' })))).toMatchObject({
      field: 'accentColour',
    });
    expect(() => assertTemplateValid(template({ accentColour: '#0F766E' }))).not.toThrow();
  });

  it('PDF-27: a watermark switched on with no text is refused — it would draw nothing', () => {
    expect(
      detailsOf(() => assertTemplateValid(template({ showWatermark: true, watermarkText: '  ' }))),
    ).toMatchObject({ field: 'watermarkText' });

    expect(() =>
      assertTemplateValid(template({ showWatermark: true, watermarkText: 'DRAFT' })),
    ).not.toThrow();
  });
});

describe('layout element rules', () => {
  it('PDF-28: exactly one table — a second has no defined behaviour when rows flow', () => {
    const base = layout().elements[0] as DocumentElement;
    const twice = layout({ ...base, id: 'table-2' });

    expect(detailsOf(() => assertLayoutValid(twice))).toMatchObject({
      field: 'layout',
      element: null,
      reason: 'duplicate_table',
    });
  });

  it('PDF-29: a document with nowhere to put line items is refused', () => {
    // Version 1's rule 2, unchanged in substance: `element` is null because the
    // offender is the layout rather than any one item in it.
    expect(detailsOf(() => assertLayoutValid({ version: 2, elements: [] }))).toMatchObject({
      field: 'layout',
      element: null,
      reason: 'missing_lines',
    });
  });

  it('PDF-30: an element that falls off the paper is refused, not nudged', () => {
    // Moving somebody's design for them without saying so is worse than telling
    // them the page got smaller. The designer offers Fit to page instead.
    const offPage = layout(text({ id: 'wide', x: 190, w: 60 }));

    expect(detailsOf(() => assertLayoutValid(offPage, GEOMETRY))).toMatchObject({
      element: 'wide',
      reason: 'element_off_page',
    });

    expect(() => assertLayoutValid(layout(text()), GEOMETRY)).not.toThrow();
  });

  it('PDF-31: an element with no width or height is refused; a rule may be flat', () => {
    expect(detailsOf(() => assertLayoutValid(layout(text({ w: 0 }))))).toMatchObject({
      reason: 'element_empty',
    });

    // A rule is a line. Demanding height of it would be demanding a thick line.
    const flat = layout({
      id: 'hr',
      kind: 'rule',
      colour: null,
      thickness: 0.5,
      x: 15,
      y: 30,
      w: 180,
      h: 0,
      z: 1,
      band: 'body',
      flow: 'fixed',
    } as DocumentElement);

    expect(() => assertLayoutValid(flat)).not.toThrow();
  });

  it('PDF-32: a text length and a character limit both have ceilings', () => {
    expect(
      detailsOf(() => assertLayoutValid(layout(text({ text: 'x'.repeat(2001) })))),
    ).toMatchObject({ reason: 'text_too_long', max: 2000 });

    expect(
      detailsOf(() =>
        assertLayoutValid(layout(text({ style: { ...textStyle(), maxChars: 9999 } }))),
      ),
    ).toMatchObject({ reason: 'max_chars_out_of_range' });
  });

  it('PDF-33: an unknown element kind is refused rather than silently skipped', () => {
    const details = detailsOf(() =>
      assertLayoutValid(layout({ ...text(), kind: 'barcode' } as never)),
    );

    expect(details).toMatchObject({ reason: 'unknown_kind' });
    expect(details.allowed).toContain('table');
  });

  it('PDF-34: every shipped default converts to a layout that passes validation', () => {
    // The version 1 equivalent asserted the database column default was legal.
    // The same promise has to hold: a template nobody has edited is saveable.
    for (const documentType of ['quotation', 'order_confirmation', 'dispatch_note'] as const) {
      const defaults = TEMPLATE_DEFAULTS[documentType];
      const converted = normaliseLayout(defaults.layout, {
        paperSize: defaults.paperSize,
        orientation: defaults.orientation,
        margins: defaults.margins,
      });

      expect(() => assertLayoutValid(converted, GEOMETRY), documentType).not.toThrow();
    }
  });

  it('PDF-34: a version 1 blob still validates once the normaliser has seen it', () => {
    // The legacy path must not rot. A row written before the designer existed
    // goes through the mapper and comes out valid.
    const legacy = JSON.parse('{"blocks":[{"kind":"lines","groupByProduct":false}]}') as unknown;

    expect(() => assertLayoutValid(normaliseLayout(legacy, GEOMETRY), GEOMETRY)).not.toThrow();
  });

  it('PDF-76: two elements cannot share one identifier', () => {
    expect(
      detailsOf(() => assertLayoutValid(layout(text({ id: 'dup' }), text({ id: 'dup' })))),
    ).toMatchObject({ element: 'dup', reason: 'duplicate_id' });
  });

  it('PDF-76: a layout may not carry more than two hundred items', () => {
    const many = Array.from({ length: 200 }, (_, index) => text({ id: `t${index}` }));

    expect(detailsOf(() => assertLayoutValid(layout(...many)))).toMatchObject({
      reason: 'too_many_elements',
      max: 200,
    });
  });

  it('PDF-76: a literal that looks like a merge token is refused', () => {
    // Nothing substitutes into static text today, so this prints verbatim and is
    // merely odd. The day somebody adds substitution it becomes a way to name
    // data the binding catalogue would have permission-checked.
    expect(
      detailsOf(() => assertLayoutValid(layout(text({ text: 'Dear {party.name}' })))),
    ).toMatchObject({ reason: 'placeholder_in_literal' });

    // A brace that is not a token is ordinary punctuation and stays legal.
    expect(() => assertLayoutValid(layout(text({ text: 'Sizes {300x600}' })))).not.toThrow();
  });

  it('PDF-76: an unreadable size and a malformed colour are both refused', () => {
    expect(
      detailsOf(() => assertLayoutValid(layout(text({ style: { ...textStyle(), size: 0 } })))),
    ).toMatchObject({ reason: 'font_size_out_of_range' });

    expect(
      detailsOf(() =>
        assertLayoutValid(layout(text({ style: { ...textStyle(), colour: 'teal' } }))),
      ),
    ).toMatchObject({ reason: 'colour_invalid' });
  });
});
describe('applicability and the default swap', () => {
  it('PDF-35: a dispatch note cannot be rendered for a lead — nothing has been dispatched', () => {
    expect(() => assertTemplateAppliesTo('dispatch_note', 'order')).not.toThrow();
    expect(() => assertTemplateAppliesTo('dispatch_note', 'lead')).toThrow(ValidationError);
    expect(() => assertTemplateAppliesTo('order_confirmation', 'lead')).toThrow(ValidationError);
    // A quotation reads correctly for either.
    expect(() => assertTemplateAppliesTo('quotation', 'lead')).not.toThrow();
    expect(() => assertTemplateAppliesTo('quotation', 'order')).not.toThrow();
  });

  it('PDF-36: promoting a default names the one to demote, and demotes nothing when it is already default', () => {
    expect(assertDefaultSwap('T2', 'T1')).toEqual({ demote: 'T1' });
    expect(assertDefaultSwap('T1', 'T1')).toEqual({ demote: null });
    expect(assertDefaultSwap('T1', null)).toEqual({ demote: null });
  });
});

describe('duplicate names', () => {
  it('PDF-37: a taken name is a ConflictError carrying the value, not a bare 400', () => {
    // 409 rather than 400: the request was well-formed, it just collided.
    const error = nameTakenError('Quotation');

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.details).toMatchObject({ field: 'name', value: 'Quotation' });
  });
});
