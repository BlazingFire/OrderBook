/**
 * The wire shape of a bulk product import — what the Office panel uploads and
 * what the Master answers with.
 *
 * Types and limits only. The parser lives on the Master
 * (`master/src/domain/product-import.ts`): this package is bundled into both
 * browsers, and a browser never parses the file — it uploads it and shows the
 * row-numbered report that comes back.
 */

import type { ProductInput } from './inputs.js';
import type { MessageKey, MessageParams } from '../i18n/keys.js';

/** Refused above this before the file is parsed — a sanity ceiling, not a design limit. */
export const MAX_PRODUCT_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * Row issues reported back per import. A five-thousand-row file with every row
 * wrong produces five thousand issues; the screen shows the first thousand and
 * says the list was cut, which is enough to see the shape of the mistake.
 */
export const MAX_PRODUCT_IMPORT_ISSUES = 1000;

/** Data rows past which a file is refused whole, before any row is read — a typo'd range, not a catalogue. */
export const MAX_PRODUCT_IMPORT_ROWS = 20000;

/**
 * The product file format. **1** is every file the product screens wrote before
 * 1.4 (1.2.x and 1.3): the columns of `IMPORT_COLUMNS`, no marker. **2** is the same
 * columns with a marker in the workbook's Subject (`PRODUCT_FORMAT_SUBJECT`); a
 * CSV has no place for one, and carries none. The columns did not change between
 * the two, which is the point: a 1.2.5 reader reads a 2 file, and this reader
 * reads a 1 file. Raise it only when a column's meaning changes.
 * `docs/PRODUCT_IMPORT_FORMAT.md` is the contract.
 */
export const PRODUCT_FORMAT_VERSION = 2;
export const PRODUCT_FORMAT_SUBJECT = 'OrderBook products format';

/** The version a workbook's Subject declares, or null (no marker: a pre-1.4 file, or a CSV). */
export function productFormatOf(subject: string | null | undefined): number | null {
  const text = subject ?? '';
  if (!text.startsWith(`${PRODUCT_FORMAT_SUBJECT} `)) return null;
  const version = Number(text.slice(PRODUCT_FORMAT_SUBJECT.length + 1).trim());
  return Number.isInteger(version) && version > 0 ? version : null;
}

/**
 * `create` adds new products and reports a row whose code already exists as
 * skipped. `upsert` also updates those rows in place, by code — how a whole
 * catalogue is corrected from one sheet — and needs `products.edit` on top of
 * `products.bulk`.
 */
export type ProductImportMode = 'create' | 'upsert';

export type ProductImportFormat = 'csv' | 'xlsx';

export interface ProductImportIssue {
  /**
   * The spreadsheet row, as the person sees it in Excel: the header is row 1,
   * so the first data row is row 2.
   */
  row: number;
  /** `skipped` is not a failure — the row was recognised and deliberately left alone. */
  kind: 'error' | 'skipped';
  /** The header text exactly as written in the file, when one column is to blame. */
  column?: string;
  messageKey: MessageKey;
  params?: MessageParams;
}

export interface ProductImportResult {
  dryRun: boolean;
  mode: ProductImportMode;
  fileName: string;
  /** Data rows in the file, blank rows excluded. */
  totalRows: number;
  /** Rows created — or, on a dry run, rows that would be. */
  created: number;
  updated: number;
  /**
   * Rows an `upsert` matched to a product that already says exactly this —
   * nothing to change, so not counted in `updated`. An export uploaded back
   * unedited is all `unchanged`. Absent from a Master older than 1.2.5.
   */
  unchanged?: number;
  skipped: number;
  failed: number;
  issues: ProductImportIssue[];
  /** True when `issues` was cut at `MAX_PRODUCT_IMPORT_ISSUES`. */
  issuesTruncated: boolean;
  /** Header cells that matched no known column, as written. */
  ignoredColumns: string[];
  /**
   * The format version the file declared (`PRODUCT_FORMAT_VERSION`), or null when it
   * declared none: a file from before 1.4, or a CSV. Absent from an older Master.
   */
  formatVersion?: number | null;
  /** The first few rows as they were understood, for the preview. */
  sample: ProductInput[];
}
