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

/**
 * `create` adds new products and reports a row whose code already exists as
 * skipped. `upsert` also updates those rows in place, by product code — the
 * bulk price-list edit — and needs `products.edit` on top of `products.bulk`.
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
  skipped: number;
  failed: number;
  issues: ProductImportIssue[];
  /** True when `issues` was cut at `MAX_PRODUCT_IMPORT_ISSUES`. */
  issuesTruncated: boolean;
  /** Header cells that matched no known column, as written. */
  ignoredColumns: string[];
  /** The first few rows as they were understood, for the preview. */
  sample: ProductInput[];
}
