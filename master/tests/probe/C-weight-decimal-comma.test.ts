/**
 * Probe, lens C (number formats): an old export opened and saved again by a
 * decimal-comma Excel ("CSV (semicolon delimited)", which the import reads:
 * `detectDelimiter`, `parseNumber`'s decimal comma) writes a 3-decimal weight
 * as `1,125`. The weight column is NUMERIC(10,3), so 1.125 kg is a weight the
 * catalogue holds. `parseNumber` reads a decimal comma only with one or two
 * digits after it, so `1,125` is taken as a thousands separator: 1125 kg.
 */

import { describe, expect, it } from 'vitest';

import { matchHeaders, parseImportRow } from '../../src/domain/product-import.js';
import { readSheetRows } from '../../src/lib/spreadsheet.js';

describe('lens C: weights in a decimal-comma resave of an export', () => {
  it('C10 demonstrates: a semicolon CSV weight of 1,125 is read as 1125 kg, not 1.125', async () => {
    const text = [
      'Brand;Main product code;Main product;Sub product;Size;Colour rule;Colour;Code;Weight (kg);Alias',
      'Swisware+;WB;Wash Basin;DAMRU;;dedicated;;WB-0001;1,125;',
      'Swisware+;WB;Wash Basin;SMALL;;dedicated;;WB-0002;1,25;',
    ].join('\r\n');
    const [header, ...rows] = await readSheetRows(Buffer.from(text, 'utf8'));
    const match = matchHeaders(header!);
    const weights = rows.map((cells, index) => parseImportRow(cells, match, header!, index + 2).input?.variant.weightKg);
    expect(weights).toEqual([1.125, 1.25]);
  });
});
