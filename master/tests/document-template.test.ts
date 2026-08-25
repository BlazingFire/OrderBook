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
import { TEMPLATE_DEFAULTS, type DocumentLayout } from '@orderbook/shared';

import {
  assertDefaultSwap,
  assertLayoutValid,
  assertTemplateAppliesTo,
  assertTemplateValid,
  nameTakenError,
  type TemplateShape,
} from '../src/domain/document-template.js';
import { ConflictError, ValidationError } from '../src/lib/errors.js';

function template(overrides: Partial<TemplateShape> = {}): TemplateShape {
  return { ...TEMPLATE_DEFAULTS.quotation, ...overrides };
}

function layout(...blocks: DocumentLayout['blocks']): DocumentLayout {
  return { blocks };
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
      expect(() => assertTemplateValid(TEMPLATE_DEFAULTS[documentType])).not.toThrow();
    }
  });

  it('PDF-22: a blank name is refused', () => {
    expect(detailsOf(() => assertTemplateValid(template({ name: '   ' })))).toMatchObject({
      field: 'name',
    });
  });

  it('PDF-23: an unknown paper size names what is allowed rather than failing silently', () => {
    const details = detailsOf(() =>
      assertTemplateValid(template({ paperSize: 'Legal' as never })),
    );
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

describe('layout block grammar', () => {
  it('PDF-28: rule 1 — a kind may appear at most once, and the offending index is named', () => {
    const details = detailsOf(() =>
      assertLayoutValid(
        layout(
          { kind: 'lines', groupByProduct: false },
          { kind: 'totals', showBoxCount: true },
          { kind: 'totals', showBoxCount: false },
        ),
      ),
    );
    expect(details).toMatchObject({ field: 'layout', block: 2, reason: 'duplicate_kind' });
  });

  it('PDF-29: rule 2 — a lines block is mandatory, and block is null because nothing is the offender', () => {
    const details = detailsOf(() => assertLayoutValid(layout({ kind: 'party' })));
    expect(details).toMatchObject({ field: 'layout', block: null, reason: 'missing_lines' });
  });

  it('PDF-30: rule 3 — a header, if present, must come first', () => {
    const details = detailsOf(() =>
      assertLayoutValid(
        layout({ kind: 'lines', groupByProduct: false }, { kind: 'header', align: 'left' }),
      ),
    );
    expect(details).toMatchObject({ block: 1, reason: 'header_not_first' });
  });

  it('PDF-31: rule 4 — a signature, if present, must come last', () => {
    const details = detailsOf(() =>
      assertLayoutValid(
        layout(
          { kind: 'signature', label: 'Sig' },
          { kind: 'lines', groupByProduct: false },
        ),
      ),
    );
    expect(details).toMatchObject({ block: 0, reason: 'signature_not_last' });
  });

  it('PDF-32: rule 5 — terms cap at 500 characters', () => {
    const details = detailsOf(() =>
      assertLayoutValid(
        layout(
          { kind: 'lines', groupByProduct: false },
          { kind: 'terms', text: 'x'.repeat(501) },
        ),
      ),
    );
    expect(details).toMatchObject({ reason: 'terms_too_long', max: 500 });

    expect(() =>
      assertLayoutValid(
        layout({ kind: 'lines', groupByProduct: false }, { kind: 'terms', text: 'x'.repeat(500) }),
      ),
    ).not.toThrow();
  });

  it('PDF-33: an unknown block kind is refused rather than silently skipped by the renderer', () => {
    const details = detailsOf(() =>
      assertLayoutValid(
        layout({ kind: 'lines', groupByProduct: false }, { kind: 'barcode' } as never),
      ),
    );
    expect(details).toMatchObject({ block: 1, reason: 'unknown_kind' });
  });

  it('PDF-34: the database column default is itself a legal layout', () => {
    // `document_templates.layout` defaults to this literal. A default that
    // fails the grammar would make an INSERT that omits the column unsaveable.
    expect(() =>
      assertLayoutValid(JSON.parse('{"blocks":[{"kind":"lines","groupByProduct":false}]}')),
    ).not.toThrow();
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
