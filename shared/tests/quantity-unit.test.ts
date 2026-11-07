// @vitest-environment node
/**
 * A quantity is always pieces (owner, 2026-10-07: "box means box packing, only pcs are quantity"). "Box" is a
 * Packaging value, like Grass and Paper, never a unit of quantity, so no label may call a count of things
 * "box" or "boxes". The few messages below use the word for something else (an input box).
 */

import { describe, expect, it } from 'vitest';

import { EN_MESSAGES } from '../src/i18n/en.js';
import { REPORT_COLUMNS, t, type MessageKey } from '../src/index.js';

/** Messages where "box" is a field on the screen, not a quantity. */
const NOT_A_QUANTITY = new Set([
  'lead.add.products.productHint',
  'lead.add.flow.colourKeys',
]);

/** A heading as the English catalogue words it. */
const heading = (token: MessageKey): string => (t as (locale: string, key: MessageKey) => string)('en', token);

describe('the report columns', () => {
  it('never call a quantity box: no key and no heading, so the CSV header, the sheet and the screen say pieces', () => {
    for (const [kind, columns] of Object.entries(REPORT_COLUMNS)) {
      for (const column of columns) {
        expect(column.key, `${kind}.${column.key}`).not.toMatch(/box/i);
        expect(heading(column.labelToken), `${kind}.${column.key}`).not.toMatch(/\bboxe?s?\b/i);
      }
    }
    // The Dispatches report counts pieces under a key that is also its CSV header.
    expect(REPORT_COLUMNS.dispatches.map((column) => column.key)).toEqual(['month', 'orderCount', 'pieces']);
    expect(t('en', 'reports.column.pieces')).toBe('Pieces');
  });
});

describe('the quantity unit', () => {
  it('is pieces on the printed notes, the dispatch tile, the reports and the activity feed', () => {
    expect(EN_MESSAGES['orderNote.unit']).toBe('pcs');
    expect(EN_MESSAGES['dashboard.orders.boxesOpen']).toBe('{count} pcs still to dispatch');
    expect(EN_MESSAGES['reports.column.pieces']).toBe('Pieces');
    expect(EN_MESSAGES['activity.stock.inbound']).toContain('pcs');
  });

  it('is never called box or boxes anywhere else in the catalogue', () => {
    const offenders = Object.entries(EN_MESSAGES)
      .filter(([key, text]) => /\bboxe?s?\b/i.test(String(text)) && !NOT_A_QUANTITY.has(key))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
