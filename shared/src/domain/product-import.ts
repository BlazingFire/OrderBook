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
  /**
   * SHA-256 of the uploaded file bytes. The review sends it back with a
   * per-row apply so a re-uploaded file cannot silently move the row numbers
   * the review approved; a mismatch is refused with
   * `validation.import.fileChanged`.
   */
  fileHash?: string;
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
  rowPreviews?: ProductImportRowPreview[];
  rowPreviewsTruncated?: boolean;
}

// --- The product backup zip -------------------------------------------------

export type ProductImportRowKind =
  | 'new'
  | 'update'
  | 'unchanged'
  | 'clash'
  | 'invalid'
  | 'rename-suspect'
  | 'move-suspect';
export type ProductImportRowDecision = 'create' | 'update' | 'skip';

export interface ProductImportRowPreview {
  row: number;
  kind: ProductImportRowKind;
  decision: ProductImportRowDecision;
  fileName: string;
  fileCode: string;
  existingName: string | null;
  existingCode: string | null;
  cells: ProductCellChange[];
  reasonKey: MessageKey;
  reasonParams?: MessageParams;
}

//
// `OrderBook-Products-<company>-<date>.zip`: `products.csv` (the export above),
// `main-products.csv`, `colours.csv`, `brands.csv`, `images/<CODE>.<ext>`, one
// file per photo, and `photos.csv`, their captions
// (`docs/PRODUCT_IMPORT_FORMAT.md`, "The product backup zip").
// Restored on the Master only, by `master/src/services/product-zip.service.ts`.

/** Refused above this before the zip is opened: it carries every photo. */
export const MAX_PRODUCT_ZIP_BYTES = 1024 * 1024 * 1024;

/** One changed cell, by the file's own column name. */
export interface ProductCellChange {
  column: string;
  from: string;
  to: string;
}

/** One `products.csv` row the restore adds or changes, by its code. */
export interface ProductRowChange {
  code: string;
  name: string;
  /** Empty for an added row. */
  fields: ProductCellChange[];
}

/** Something the restore could not do, named by what it was about (a code, a file name). */
export interface ProductZipProblem {
  subject: string;
  messageKey: MessageKey;
  params?: MessageParams;
}

/** The opt-ins on the preview; all off unless the person ticks them. */
export interface ProductRestoreOptions {
  /** Move sub products whose codes are missing from `products.csv` to the Recycle Bin. */
  binMissingProducts?: boolean;
  /** Delete photos of the file's sub products that have no file in `images/`. */
  removeMissingPhotos?: boolean;
  /**
   * Make the catalogue exactly this file: both of the above, and every other
   * `notInFile` of the report acted on. Main products, colours and brands go
   * to the Recycle Bin (colours are switched off instead where
   * `colours.switchedOff`); `rows.variantsNotInFile` are removed for good,
   * deactivated where history quotes one.
   */
  exactCatalogue?: boolean;
  /**
   * Update only: add what is new and apply each non-blank cell that differs,
   * keep everything else. A blank cell never clears; a row of a live code may
   * leave Sub product and Main product blank; a new code is added beside a sub
   * product's codes; nothing is removed, relabelled or renumbered; a photo in
   * the zip is added or replaces its slot's, the others stay where they are.
   * The three above are off under it, whatever they say.
   */
  updateOnly?: boolean;
}

/**
 * What `colours.csv` or `brands.csv` does to its list. A change's `column` is
 * the value and the file's column, `White — Label`.
 */
export interface ProductZipList {
  added: string[];
  changed: ProductCellChange[];
  /** True when the list is put in the file's order; absent when it is in it already. */
  reordered?: boolean;
  /**
   * Values the list holds that the file does not list (brands without
   * `brands.csv`: that no main product uses after the run), which
   * `exactCatalogue` moves to the Recycle Bin. Colours switched off already
   * are left out where `switchedOff`. Absent when there are none.
   */
  notInFile?: string[];
  /** Colours: `exactCatalogue` switches `notInFile` off instead, for a person who may not delete a colour (`fields.manage`). */
  switchedOff?: boolean;
  /** Colours: the zip has no `colours.csv` (or none with a Colour column), so the colour list stays as it is, `exactCatalogue` or not. */
  noFile?: boolean;
}

/**
 * What a product zip would do (a dry run) or did. Photos are named by their
 * file name in the zip; a photo in the catalogue with no file is named by the
 * file name an export would give it (`OPT-0001_2`).
 */
export interface ProductZipReport {
  dryRun: boolean;
  fileName: string;
  mainProducts: {
    added: Array<{ code: string; name: string; brand: string | null }>;
    /** Main products whose name, brand, code or Order the file changes, by their code (a code-less one by its name). */
    renamed: Array<{ code: string; fields: ProductCellChange[] }>;
    /** Main products in the Recycle Bin the file names by code: brought back. Absent when there are none. */
    restoredFromBin?: Array<{ code: string; name: string; brand: string | null }>;
    /**
     * Live main products neither file names, with no sub product the run
     * leaves under them, which `exactCatalogue` moves to the Recycle Bin.
     * Absent when there are none.
     */
    notInFile?: Array<{ code: string; name: string; brand: string | null }>;
  };
  /** `products.csv` through the ordinary upsert import: counts, issues, ignored columns. */
  products: ProductImportResult;
  rows: {
    added: ProductRowChange[];
    changed: ProductRowChange[];
    /** Live sub products none of whose codes the file names and that no row read by its name. */
    notInFile: Array<{ code: string; name: string }>;
    /** Live codes of a file sub product that its rows leave out: kept, or removed by `exactCatalogue`. Absent when there are none. */
    variantsNotInFile?: Array<{ code: string; name: string }>;
    /** Sub products a code brings back from the Recycle Bin, with the cells the file changes; counted in `products.updated`. Absent when there are none. */
    restoredFromBin?: ProductRowChange[];
    /** Main products whose sub products are put in the file's order. Absent when there are none. */
    reordered?: Array<{ code: string; name: string }>;
  };
  colours: ProductZipList;
  /** `brands.csv`, empty for a zip without one. Absent from a Master older than 1.4.7. */
  brands?: ProductZipList;
  photos: {
    added: string[];
    replaced: string[];
    unchanged: number;
    /**
     * Unchanged photos whose caption `photos.csv` gives otherwise: the restore
     * puts that caption back. Absent from a Master older than 1.4.7.
     */
    recaptioned?: string[];
    /**
     * Sub products, by their first live code, whose main photo or photo order
     * the restore puts back to the zip's. Absent from a Master older than 1.4.7.
     */
    reordered?: string[];
    unmatched: string[];
    duplicate: string[];
    notImage: string[];
    notInZip: string[];
    /** The file holds no photo at all: none is missing from it, and the photos stay as they are. */
    noFile?: boolean;
  };
  /** After a real run with the opt-ins: what went to the Recycle Bin and what was deleted. */
  binned?: number;
  photosRemoved?: number;
  /** After a real run with `exactCatalogue`: the main products, colours and brands it took out. */
  exactRemoved?: { mainProducts: number; colours: number; brands: number };
  /**
   * A preview for a person without `catalog.lists.manage`: `exactCatalogue`
   * would take colours or brands out, which needs it, so that run is refused.
   */
  exactNeedsLists?: boolean;
  problems: ProductZipProblem[];
}

/** The one product restore the Master runs at a time, polled by the screen. */
export interface ProductRestoreJob {
  id: string;
  phase: 'checking' | 'products' | 'photos' | 'removing' | 'done' | 'failed';
  /** Photos uploaded so far, of `total`, in the `photos` phase. */
  done: number;
  total: number;
  startedAt: string;
  finishedAt?: string;
  /** The finished report, when `phase` is `done`. */
  result?: ProductZipReport;
  /** Why it failed. Only when `phase` is `failed`. */
  message?: { messageKey: MessageKey; params?: MessageParams };
}
