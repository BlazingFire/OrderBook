/**
 * Sheet row parsing through the Rust sidecar, with the TypeScript twin as fallback.
 *
 * One spawn parses the whole sheet: the helper re-matches the header row and
 * parses every data row with the ported `parseImportRow`, so a sheet pays the
 * spawn cost once no matter its row count. Any helper failure answers the
 * TypeScript loop row by row instead, so the import reads identically with or
 * without a Rust build. The caller filters blank and out-of-scope rows first,
 * exactly as the inline loop did — the helper never invents a row number.
 */

import type { ProductImportIssue } from '@orderbook/shared';

import {
  matchHeaders,
  parseImportRow,
  type ImportRow,
} from '../domain/product-import.js';
import { tryHelper } from './rust-bridge.js';

export interface ImportSheetBatchRow {
  cells: string[];
  row: number;
}

export interface ParsedImportSheetRow {
  input: ImportRow | null;
  issues: ProductImportIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A helper row is accepted only when it has the twin's shape. */
function isParsedRow(value: unknown): value is ParsedImportSheetRow {
  if (!isRecord(value) || !Array.isArray((value as { issues?: unknown }).issues)) return false;
  const input = (value as { input?: unknown }).input;
  if (input !== null && !isRecord(input)) return false;
  if (isRecord(input)) {
    const product = (input as { product?: unknown }).product;
    const variant = (input as { variant?: unknown }).variant;
    if (!isRecord(product) || !isRecord(variant)) return false;
    if (typeof (variant as { code?: unknown }).code !== 'string') return false;
  }
  const issues = (value as { issues: unknown[] }).issues;
  return issues.every(
    (issue): issue is ProductImportIssue =>
      isRecord(issue) &&
      typeof (issue as { row?: unknown }).row === 'number' &&
      typeof (issue as { messageKey?: unknown }).messageKey === 'string',
  );
}

/**
 * Every row parsed, via the helper when it answers, else the TypeScript twin
 * row by row. Output order matches input order.
 */
export async function parseImportSheetViaRust(
  headerRow: readonly string[],
  rows: ReadonlyArray<ImportSheetBatchRow>,
  options: { restore: boolean; updateOnly: boolean },
): Promise<ParsedImportSheetRow[]> {
  const fallback = (): ParsedImportSheetRow[] => {
    const match = matchHeaders(headerRow);
    return rows.map(({ cells, row }) => {
      const outcome = parseImportRow(cells, match, headerRow, row, options);
      return { input: outcome.input, issues: outcome.issues };
    });
  };
  if (rows.length === 0) return [];
  const value = await tryHelper({
    op: 'parseImportSheet',
    headerRow: [...headerRow],
    rows: rows.map(({ cells }) => cells),
    rowNumbers: rows.map(({ row }) => String(row)),
    restore: String(options.restore),
    updateOnly: String(options.updateOnly),
  });
  if (!Array.isArray(value) || value.length !== rows.length || !value.every(isParsedRow)) {
    return fallback();
  }
  return value as ParsedImportSheetRow[];
}
