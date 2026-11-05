/**
 * Reading a product sheet as text — CSV dialects and Excel cell types — with
 * no database. What matters is that every row number the import report quotes
 * is the one Excel shows, and that nothing is "helpfully" coerced.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { toCsv } from '../src/lib/csv.js';
import { decodeCsv, parseCsv, readSheetRows } from '../src/lib/spreadsheet.js';

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('CSV reading', () => {
  it('strips a BOM, reads CRLF, quoted commas, doubled quotes and line breaks inside quotes', async () => {
    const rows = await readSheetRows(
      bytes('﻿Name,Code\r\n"DAMRU, big","D-1"\r\n"9"" bowl","D-2"\r\n"two\r\nlines",D-3\r\n'),
    );
    expect(rows).toEqual([
      ['Name', 'Code'],
      ['DAMRU, big', 'D-1'],
      ['9" bowl', 'D-2'],
      ['two\r\nlines', 'D-3'],
    ]);
  });

  it('keeps blank lines as rows, so a reported row number is the one Excel shows', () => {
    const rows = parseCsv('a,b\n1,2\n\n3,4\n');
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual(['']);
    expect(rows[3]).toEqual(['3', '4']);
  });

  it('reads semicolon- and tab-separated files, as a non-English Excel writes them', () => {
    expect(parseCsv('Code;Weight (kg)\r\nA-1;12,5\r\n')).toEqual([
      ['Code', 'Weight (kg)'],
      ['A-1', '12,5'],
    ]);
    expect(parseCsv('Code\tSize\nA-1\t18x12\n')[1]).toEqual(['A-1', '18x12']);
  });

  it('leaves leading zeros, sizes and dates exactly as typed', () => {
    expect(parseCsv('Code,Size,Date\n0012,18x12,3/4/2026\n')[1]).toEqual(['0012', '18x12', '3/4/2026']);
  });

  it('decodes UTF-8 accents, UTF-16 "Unicode Text" and Windows-1252 saves', () => {
    expect(decodeCsv(bytes('Zoë,Café'))).toBe('Zoë,Café');
    expect(decodeCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Code,Café', 'utf16le')]))).toBe(
      'Code,Café',
    );
    // 0xE9 alone is "é" in Windows-1252 and invalid UTF-8.
    expect(decodeCsv(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
  });

  it('takes the export\'s formula-guard apostrophe off again', () => {
    const csv = toCsv(['Name'], [['=SUM(A1)'], ['-6" pipe'], ["O'Neil"]]);
    expect(parseCsv(csv).slice(1)).toEqual([['=SUM(A1)'], ['-6" pipe'], ["O'Neil"]]);
  });
});

describe('Excel reading', () => {
  it('returns every cell as text: numbers, dates, rich text, formulas and hyperlinks', async () => {
    const workbook = new ExcelJS.Workbook();
    // A Guide sheet in front of the data must not hide it.
    workbook.addWorksheet('Empty');
    const sheet = workbook.addWorksheet('Products');
    sheet.addRow(['Code', 'Sub product', 'Size', 'Weight (kg)', 'Alias']);
    sheet.addRow([12, 'DAMRU', '18x12', 18.5, new Date(Date.UTC(2026, 2, 4))]);
    sheet.addRow([
      '0012',
      { richText: [{ text: 'ONE ' }, { text: 'PIECE' }] },
      { formula: 'A1', result: 'L-27' },
      '1,200.5',
      { text: 'ali', hyperlink: 'http://x' },
    ]);
    const out = await workbook.xlsx.writeBuffer();

    const rows = await readSheetRows(Buffer.from(out as ArrayBuffer));
    expect(rows[1]).toEqual(['12', 'DAMRU', '18x12', '18.5', '2026-03-04']);
    expect(rows[2]).toEqual(['0012', 'ONE PIECE', 'L-27', '1,200.5', 'ali']);
  });
});
