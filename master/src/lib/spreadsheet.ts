/**
 * Spreadsheet bytes in, rows of text out — and the blank template the other way.
 *
 * `exceljs` reads `.xlsx` (a CSV is parsed by `parseCsv` below) and writes the template with the
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

import { PassThrough, Readable } from 'node:stream';
import ExcelJS from 'exceljs';

import { toCsv } from './csv.js';

export type SheetKind = 'csv' | 'xlsx';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Rows written between two turns of the event loop when a workbook is streamed. */
const YIELD_EVERY_ROWS = 2000;

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

/**
 * A CSV's text, whatever Excel saved it as: UTF-8 (with or without a BOM),
 * UTF-16 ("Unicode Text"), or — when the bytes are not valid UTF-8 — the
 * Windows-1252 that "CSV (Comma delimited)" writes on an English-locale PC.
 */
export function decodeCsv(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buffer);
    } catch {
      return buffer.toString('latin1');
    }
  }
}

/** The separator the first line uses: a comma, or the semicolon / tab a non-English Excel writes. */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (Object.values(counts).some((n) => n > 0)) break;
    } else if (!quoted && char in counts) counts[char] = (counts[char] ?? 0) + 1;
  }
  return Object.keys(counts).reduce((best, key) => ((counts[key] ?? 0) > (counts[best] ?? 0) ? key : best), ',');
}

/**
 * RFC 4180 records, one array per line **including blank ones**, so the index
 * is the row number Excel shows. Quoted fields may hold the delimiter, quotes
 * (`""`) and line breaks. A leading apostrophe on a `=`/`+`/`-`/`@` cell is the
 * export's formula guard (`lib/csv.ts`) and is taken off again, so an export
 * re-imports unchanged.
 */
export function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let touched = false;

  const endCell = (): void => {
    row.push(cell.trim().replace(/^'(?=[=+\-@\t\r])/, ''));
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    rows.push(row);
    row = [];
    touched = false;
  };

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else quoted = false;
    } else if (char === '"' && cell.trim() === '') {
      quoted = true;
      touched = true;
    } else if (char === delimiter) {
      endCell();
      touched = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[at + 1] === '\n') at += 1;
      endRow();
    } else {
      cell += char;
      touched = true;
    }
  }
  if (touched || cell !== '') endRow();

  return rows;
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
  // A CSV is parsed here, not by exceljs: that reader coerces numbers and
  // dates, assumes a comma, and drops blank lines — shifting every row number
  // the report quotes.
  if (sheetKindOf(buffer) === 'csv') return parseCsv(decodeCsv(buffer));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.read(Readable.from([buffer]));
  // The first sheet that holds anything: a workbook saved with the Guide
  // sheet in front still imports.
  const sheet = workbook.worksheets.find((candidate) => candidate.actualRowCount > 0);
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
  /** The data sheet's name; the products template is the default. */
  sheetName?: string;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrderBook';

  const sheet = workbook.addWorksheet(spec.sheetName ?? 'Products', {
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

/**
 * A filled sheet — the export. Same look as the template (frozen bold header,
 * widths, text format on the code column) so what is exported opens and
 * re-imports exactly like a template someone filled in.
 */
export async function buildXlsxTable(spec: {
  columns: readonly TemplateColumn[];
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>;
  sheetName: string;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrderBook';

  const sheet = workbook.addWorksheet(spec.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = spec.columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width,
  }));
  sheet.getRow(1).font = { bold: true };
  spec.columns.forEach((column, index) => {
    if (column.text) sheet.getColumn(index + 1).numFmt = '@';
  });
  for (const row of spec.rows) sheet.addRow([...row]);

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

/**
 * A report as a workbook, written row by row so a hundred thousand rows never
 * sit in ExcelJS's in-memory model, and yielding to the event loop every few
 * thousand so the Master keeps answering while it works.
 *
 * Header first (bold, frozen), then the rows, each committed as it goes; the
 * finished file is collected into one buffer. A cell that is a number stays a
 * number (a pivot table can sum it), anything else is text.
 */
export async function streamXlsxTable(spec: {
  sheetName: string;
  columns: ReadonlyArray<{ header: string; width: number }>;
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>;
}): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise<void>((resolve, reject) => {
    sink.on('end', () => resolve());
    sink.on('error', reject);
  });

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true });
  workbook.creator = 'OrderBook';

  const sheet = workbook.addWorksheet(spec.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = spec.columns.map((column) => ({ width: column.width }));

  const header = sheet.addRow(spec.columns.map((column) => column.header));
  header.font = { bold: true };
  header.commit();

  for (const [index, row] of spec.rows.entries()) {
    sheet.addRow([...row]).commit();
    if (index % YIELD_EVERY_ROWS === YIELD_EVERY_ROWS - 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  sheet.commit();
  await workbook.commit();
  await closed;
  return Buffer.concat(chunks);
}

export function buildCsvTemplate(headers: readonly string[]): string {
  return toCsv(headers, []);
}
