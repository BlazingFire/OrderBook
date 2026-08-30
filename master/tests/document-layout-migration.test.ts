/**
 * The migration's frozen converter and the live one agree (`docs/backend-modules/10-TESTING.md` §6.7).
 *
 * `20260318000000_document_layout_v2` carries its own copy of
 * `blocksToElements`, inlined and frozen, because a migration is a fixed
 * historical fact — `20260301` imported the live permission catalogue and
 * editing that catalogue later silently changed what an already-applied
 * migration had done.
 *
 * Deliberate duplication still has to start out correct, and it has to stay
 * *knowingly* divergent rather than accidentally so. This pins the two together
 * as of today: a change to the shared converter that is not mirrored here fails,
 * and whoever made it then decides on purpose whether the frozen copy should
 * move. That decision is the point. Usually the answer is no.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  blocksToElements,
  resetElementIds,
  TEMPLATE_DEFAULTS,
  type DocumentBlock,
  type PageGeometry,
} from '@orderbook/shared';

import { __frozenConvert } from '../src/db/migrations/20260318000000_document_layout_v2.js';

const GEOMETRY: PageGeometry = {
  paperSize: 'A4',
  orientation: 'portrait',
  margins: { top: 18, right: 15, bottom: 18, left: 15 },
};

/**
 * The two differ in exactly one respect by design: the frozen copy mints ids
 * from its own counter, so ids are compared for shape rather than equality.
 */
function comparable(elements: readonly object[]): unknown[] {
  return elements.map((element) => {
    const { id, ...rest } = element as Record<string, unknown>;

    expect(typeof id, 'every element carries an id').toBe('string');
    expect(String(id).length, 'an id is not empty').toBeGreaterThan(0);

    return rest;
  });
}

beforeEach(resetElementIds);

describe('the frozen migration converter', () => {
  it('PDF-75: agrees with the live converter on every shipped default', () => {
    for (const [documentType, defaults] of Object.entries(TEMPLATE_DEFAULTS)) {
      resetElementIds();

      const live = blocksToElements(defaults.layout.blocks, GEOMETRY, {
        hasLogo: defaults.showLogo,
        hasSignature: defaults.showSignature,
      });

      const frozen = __frozenConvert(defaults.layout.blocks as never, {
        paperSize: defaults.paperSize,
        orientation: defaults.orientation,
        margins: defaults.margins,
        hasLogo: defaults.showLogo,
        hasSignature: defaults.showSignature,
      });

      expect(comparable(frozen), documentType).toEqual(comparable(live));
    }
  });

  it('PDF-75: agrees on a layout carrying all six block kinds at once', () => {
    // The defaults between them do not exercise every kind in one pass, and the
    // cursor arithmetic is where a divergence would hide.
    const blocks: DocumentBlock[] = [
      { kind: 'header', align: 'left' },
      { kind: 'party' },
      { kind: 'lines', groupByProduct: true },
      { kind: 'totals', showBoxCount: true },
      { kind: 'terms', text: 'ignored by both' },
      { kind: 'signature', label: 'Authorised Signatory' },
    ];

    resetElementIds();
    const live = blocksToElements(blocks, GEOMETRY, { hasLogo: true, hasSignature: true });
    const frozen = __frozenConvert(blocks as never, {
      ...GEOMETRY,
      hasLogo: true,
      hasSignature: true,
    });

    expect(comparable(frozen)).toEqual(comparable(live));
  });

  it('PDF-75: agrees on a centred header, and on every paper size', () => {
    for (const paperSize of ['A4', 'A5', 'Letter'] as const) {
      for (const orientation of ['portrait', 'landscape'] as const) {
        const geometry: PageGeometry = { ...GEOMETRY, paperSize, orientation };
        const blocks: DocumentBlock[] = [
          { kind: 'header', align: 'centre' },
          { kind: 'lines', groupByProduct: false },
        ];

        resetElementIds();
        const live = blocksToElements(blocks, geometry, { hasLogo: false });
        const frozen = __frozenConvert(blocks as never, {
          paperSize,
          orientation,
          margins: geometry.margins,
          hasLogo: false,
          hasSignature: false,
        });

        expect(comparable(frozen), `${paperSize} ${orientation}`).toEqual(comparable(live));
      }
    }
  });

  it('PDF-75: neither converter carries the terms block’s dead text', () => {
    const blocks: DocumentBlock[] = [
      { kind: 'lines', groupByProduct: false },
      { kind: 'terms', text: 'this string has never been drawn' },
    ];

    resetElementIds();
    const live = JSON.stringify(blocksToElements(blocks, GEOMETRY));
    const frozen = JSON.stringify(
      __frozenConvert(blocks as never, { ...GEOMETRY, hasLogo: false, hasSignature: false }),
    );

    expect(live).not.toContain('never been drawn');
    expect(frozen).not.toContain('never been drawn');
  });

  it('PDF-75: an unknown block kind is skipped by both rather than throwing', () => {
    // A row hand-edited in the database must not stop the migration dead: the
    // rest of that template converts, and validation catches the gap later.
    const blocks = [
      { kind: 'lines', groupByProduct: false },
      { kind: 'barcode' },
    ] as unknown as DocumentBlock[];

    resetElementIds();
    const live = blocksToElements(blocks, GEOMETRY);
    const frozen = __frozenConvert(blocks as never, {
      ...GEOMETRY,
      hasLogo: false,
      hasSignature: false,
    });

    expect(comparable(frozen)).toEqual(comparable(live));
    expect(frozen).toHaveLength(1);
  });
});
