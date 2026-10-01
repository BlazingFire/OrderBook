/**
 * Bytes in, strings out — the reader must not "help". A CSV parser that turns
 * `00123` into `123` has thrown away a product code before anybody can say so,
 * and the template must come back through the reader as exactly the headers
 * it was built from.
 */

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import {
  buildCsvTemplate,
  buildXlsxTemplate,
  readSheetRows,
  sheetKindOf,
} from '../src/lib/spreadsheet.js';

describe('sheetKindOf', () => {
  it('tells a zip (xlsx) from anything else', () => {
    expect(sheetKindOf(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe('xlsx');
    expect(sheetKindOf(Buffer.from('a,b,c'))).toBe('csv');
    expect(sheetKindOf(Buffer.alloc(0))).toBe('csv');
  });
});

describe('reading CSV', () => {
  it('keeps every cell as text, including leading zeros and quoted commas', async () => {
    const csv = '﻿productCode,name,weightKg\r\n00123,"Ivory, Glossy",12.5\r\n';
    const rows = await readSheetRows(Buffer.from(csv, 'utf8'));

    expect(rows).toEqual([
      ['productCode', 'name', 'weightKg'],
      ['00123', 'Ivory, Glossy', '12.5'],
    ]);
  });

  it('carries an embedded newline inside a quoted cell and trims the rest', async () => {
    const csv = 'name,alias\n"Two\nlines",  padded  \n';
    const rows = await readSheetRows(Buffer.from(csv, 'utf8'));

    expect(rows[1]).toEqual(['Two\nlines', 'padded']);
  });

  it('indexes rows by their spreadsheet row number, leaving a skipped row blank', async () => {
    const csv = 'name\nfirst\n\nthird\n';
    const rows = await readSheetRows(Buffer.from(csv, 'utf8'));

    expect(rows).toEqual([['name'], ['first'], [''], ['third']]);
  });
});

describe('reading xlsx', () => {
  it('reads numbers, dates, formulas and rich text back as strings', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['productCode', 'name', 'weightKg', 'date', 'sum']);
    sheet.addRow(['00123', { richText: [{ text: 'Ivory ' }, { text: 'Glossy' }] }, 12.5, new Date(Date.UTC(2026, 0, 2)), { formula: '1+1', result: 2 }]);
    sheet.getCell('A2').numFmt = '@';
    const bytes = await workbook.xlsx.writeBuffer();

    const rows = await readSheetRows(Buffer.from(bytes as ArrayBuffer));

    expect(rows[0]).toEqual(['productCode', 'name', 'weightKg', 'date', 'sum']);
    expect(rows[1]).toEqual(['00123', 'Ivory Glossy', '12.5', '2026-01-02', '2']);
  });

  it('round-trips the template: its header row comes back verbatim', async () => {
    const columns = [
      { header: 'productCode', width: 14, text: true },
      { header: 'name', width: 30 },
      { header: 'multiColour', width: 10, values: ['yes', 'no'] },
    ];
    const bytes = await buildXlsxTemplate({
      columns,
      guide: [
        ['column', 'note'],
        ['productCode', 'Unique'],
      ],
    });

    expect(sheetKindOf(bytes)).toBe('xlsx');
    const rows = await readSheetRows(bytes);
    expect(rows).toEqual([['productCode', 'name', 'multiColour']]);

    // The dropdown is what the template exists for; check it was written.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as never);
    const sheet = workbook.getWorksheet('Products');
    expect(sheet?.getCell('C2').dataValidation).toMatchObject({
      type: 'list',
      formulae: ['"yes,no"'],
    });
    expect(sheet?.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(workbook.getWorksheet('Guide')?.getRow(2).values).toEqual([undefined, 'productCode', 'Unique']);
  });
});

describe('the CSV template', () => {
  it('is one header line with CRLF, and nothing else', () => {
    expect(buildCsvTemplate(['productCode', 'name'])).toBe('productCode,name\r\n');
  });
});
