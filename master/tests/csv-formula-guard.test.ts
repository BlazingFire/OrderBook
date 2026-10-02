/**
 * The CSV writer's formula guard (`lib/csv.ts`): a cell Excel would read as a
 * formula is written with a leading apostrophe, and the importer takes that
 * apostrophe off again. `=` `+` `-` `@` were always guarded; a TAB or a carriage
 * return in front of one is how a cell gets past a check that looks only at the
 * first character, so they are guarded too.
 */

import { describe, expect, it } from 'vitest';

import { toCsv } from '../src/lib/csv.js';
import { parseCsv } from '../src/lib/spreadsheet.js';

describe('the formula guard', () => {
  it.each(['=SUM(A1)', '+1+1', '-2+3', '@SUM(1)', '\t=cmd', '\r=cmd'])('guards %j', (value) => {
    const written = toCsv(['x'], [[value]]).split('\r\n')[1] as string;
    // A cell with a carriage return is quoted; the apostrophe is the first character inside.
    expect(written.replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves an ordinary cell, and one with a formula character inside it, alone', () => {
    expect(toCsv(['x'], [['Shah'], ['a=b'], ['6" pipe']])).toBe('x\r\nShah\r\na=b\r\n"6"" pipe"\r\n');
  });

  it('is taken off again by the importer, so an export reads back as it was written', () => {
    const csv = toCsv(['x'], [['=SUM(A1)'], ['@home'], ['-5'], ['+91 98250']]);
    expect(parseCsv(csv).slice(1)).toEqual([['=SUM(A1)'], ['@home'], ['-5'], ['+91 98250']]);
  });
});
