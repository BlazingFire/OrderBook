/**
 * Spreadsheet bytes in, rows of text out — and the blank template the other way.
 *
 * `exceljs` reads both `.xlsx` and `.csv` and writes the template with the
 * things a CSV cannot carry: a frozen header row, column widths, text format
 * on the code columns (so Excel does not turn `00123` into `123`) and a
 * dropdown on each closed-set column. It is the one spreadsheet dependency in
 * the product; SheetJS was rejected (`docs/overhaul/README.md`, frozen at
 * 0.18.5 with two CVEs) and this decision is recorded in `HANDOFF.md`.
 *
 * Every cell comes back as a **string**, deliberately. The reader does not know
 * a product code from a weight, and a CSV parser that "helpfully" coerces
 * `00123` to a number has already lost the leading zeros by the time anybody
 * can object. `master/src/domain/product-import.ts` decides what each column
 * means.
 */

import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';

import { toCsv } from './csv.js';

export type SheetKind = 'csv' | 'xlsx';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** How many rows the template's dropdowns cover. Past this Excel simply offers free text. */
const VALIDATION_ROWS = 5000;

/** A zip's local-file signature — every `.xlsx` starts with it; no CSV does. */
export function sheetKindOf(buffer: Buffer): SheetKind {
  return buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
    ? 'xlsx'
    : 'csv';
}

function stripBom(buffer: Buffer): string {
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** One cell's text, whatever exceljs decoded it as. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((run) => run.text).join('');
    if ('result' in value) return cellText((value.result ?? null) as ExcelJS.CellValue);
    if ('text' in value) {
      return typeof value.text === 'string' ? value.text : cellText(value.text as ExcelJS.CellValue);
    }
    if ('error' in value) return '';
    return String(value);
  }
  return String(value);
}

/**
 * Every row of the first sheet, **indexed by spreadsheet row**: `rows[0]` is
 * row 1. A row the sheet skipped is an empty array, so a row number reported
 * back to the person matches what Excel shows down the left-hand edge.
 */
export async function readSheetRows(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet | undefined;

  if (sheetKindOf(buffer) === 'xlsx') {
    await workbook.xlsx.read(Readable.from([buffer]));
    sheet = workbook.worksheets[0];
  } else {
    // The identity `map` is the whole point: without it exceljs turns every
    // numeric-looking cell into a number and a date-looking one into a Date.
    sheet = await workbook.csv.read(Readable.from([stripBom(buffer)]), { map: (value) => value });
  }

  if (!sheet) return [];

  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cells[column - 1] = cellText(cell.value).trim();
    });
    rows[rowNumber - 1] = Array.from(cells, (cell) => cell ?? '');
  });

  return Array.from(rows, (row) => row ?? []);
}

export interface TemplateColumn {
  header: string;
  width: number;
  /** Text format, so a leading zero survives Excel. */
  text?: boolean;
  /** A dropdown of exactly these values. */
  values?: readonly string[];
}

export async function buildXlsxTemplate(spec: {
  columns: readonly TemplateColumn[];
  /** The Guide sheet, header row first. */
  guide: readonly (readonly string[])[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrderBook';

  const sheet = workbook.addWorksheet('Products', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = spec.columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width,
  }));
  sheet.getRow(1).font = { bold: true };

  spec.columns.forEach((column, index) => {
    const at = index + 1;
    if (column.text) sheet.getColumn(at).numFmt = '@';
    if (column.values) {
      // Per cell rather than a range: that is the API exceljs types, and the
      // template is written once per download, not once per row.
      for (let row = 2; row <= VALIDATION_ROWS; row += 1) {
        sheet.getCell(row, at).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`"${column.values.join(',')}"`],
        };
      }
    }
  });

  const guide = workbook.addWorksheet('Guide');
  for (const row of spec.guide) guide.addRow([...row]);
  guide.getRow(1).font = { bold: true };
  guide.columns = [{ width: 22 }, { width: 10 }, { width: 10 }, { width: 34 }, { width: 60 }];

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

export function buildCsvTemplate(headers: readonly string[]): string {
  return toCsv(headers, []);
}
