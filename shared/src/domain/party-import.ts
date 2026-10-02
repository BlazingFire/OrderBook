/**
 * The wire shape of a bulk party import and export — what a panel uploads and
 * what the Master answers with. The file format is `docs/PARTY_IMPORT_FORMAT.md`.
 *
 * Types, the column list and limits only. The parser lives on the Master
 * (`master/src/domain/party-import.ts`): this package is bundled into both
 * browsers, and a browser never parses the file — it uploads it and shows the
 * row-numbered report that comes back (the model is `product-import.ts`).
 */

import type { MessageKey, MessageParams } from '../i18n/keys.js';
import type { PartyInput } from './inputs.js';

/** Refused above this before the file is parsed. */
export const MAX_PARTY_IMPORT_BYTES = 5 * 1024 * 1024;

/** Data rows past which a file is refused whole, before any row is read. */
export const MAX_PARTY_IMPORT_ROWS = 5000;

/** Row issues reported per import; the screen says when the list was cut. */
export const MAX_PARTY_IMPORT_ISSUES = 1000;

/**
 * The first `protocol` a panel reports that understands the `party_bulk`
 * change. A panel below it is sent a fresh snapshot instead, or it would keep
 * showing the parties it had.
 */
export const PARTY_BULK_MIN_PROTOCOL = 5;

/**
 * `create` adds new parties: a row that carries a Party Code is an error (codes
 * are the Master's to give), and a row whose name and city already exist is
 * skipped. `updateByCode` changes the parties the codes name: an unknown code
 * is an error and a blank cell leaves that field as it is.
 */
export type PartyImportMode = 'create' | 'updateByCode';

export type PartyImportFormat = 'csv' | 'xlsx';

/** The sheet name of the XLSX template and export. */
export const PARTY_SHEET_NAME = 'Parties';

/** A party field a sheet may carry, besides the Party Code. */
export type PartyImportField = Exclude<keyof PartyInput, 'customFields'>;

export interface PartyImportColumn {
  /** `partyCode` is the one column that is not a `PartyInput` field. */
  field: PartyImportField | 'partyCode';
  /** The header the template and the export write. */
  label: string;
  required?: true;
  /** Longest cell accepted, in characters. */
  max: number;
  /** One line for the template's Guide sheet. */
  note: string;
}

/** Template and export order. */
export const PARTY_IMPORT_COLUMNS: readonly PartyImportColumn[] = [
  { field: 'partyCode', label: 'Party Code', max: 20, note: 'Leave blank to add a party. To update one, give its code, e.g. P-0001.' },
  { field: 'name', label: 'Name', required: true, max: 120, note: 'Required. The party as it is called in the office.' },
  { field: 'phone', label: 'Phone', max: 20, note: 'Main phone number.' },
  { field: 'altPhone', label: 'Alt Phone', max: 20, note: 'A second phone number.' },
  { field: 'email', label: 'Email', max: 120, note: 'Email address.' },
  { field: 'addressLine1', label: 'Address Line 1', max: 200, note: 'First line of the address.' },
  { field: 'addressLine2', label: 'Address Line 2', max: 200, note: 'Second line of the address.' },
  { field: 'city', label: 'City', max: 80, note: 'With the name, tells two parties apart: the same name in the same city is one party.' },
  { field: 'state', label: 'State', max: 80, note: 'State.' },
  { field: 'pincode', label: 'Pincode', max: 10, note: 'Six digits.' },
  { field: 'gstNumber', label: 'GST Number', max: 15, note: 'The 15-character GSTIN, e.g. 24ABCDE1234F1Z5.' },
  { field: 'notes', label: 'Notes', max: 1000, note: 'Anything staff should know.' },
];

/** The header row, in order. */
export const PARTY_IMPORT_HEADERS: readonly string[] = PARTY_IMPORT_COLUMNS.map((column) => column.label);

export interface PartyImportIssue {
  /** The spreadsheet row as Excel shows it: the header is row 1. */
  row: number;
  /** `skipped` is not a failure — the row was recognised and left alone. */
  kind: 'error' | 'skipped';
  /** The header text as written in the file, when one column is to blame. */
  column?: string;
  messageKey: MessageKey;
  params?: MessageParams;
}

/**
 * One row of the preview as it would read once imported: for an update, the
 * party's own values with the sheet's changes laid over them, so the person
 * sees the party they are changing and not just the cells they touched. `row`
 * is the sheet row and the key.
 */
export interface PartyImportSampleRow extends PartyInput {
  row: number;
  /** The party's code on an update; null on a row that adds one. */
  partyCode: string | null;
}

export interface PartyImportResult {
  dryRun: boolean;
  mode: PartyImportMode;
  fileName: string;
  /** Data rows in the file, blank rows excluded. */
  totalRows: number;
  /** Parties added — or, on a dry run, that would be. */
  created: number;
  updated: number;
  /** Rows `updateByCode` matched to a party that already says exactly this. */
  unchanged: number;
  skipped: number;
  failed: number;
  issues: PartyImportIssue[];
  /** True when `issues` was cut at `MAX_PARTY_IMPORT_ISSUES`. */
  issuesTruncated: boolean;
  /** Header cells that matched no known column, as written. */
  ignoredColumns: string[];
  /** The first few rows as they were understood, for the preview. */
  sample: PartyImportSampleRow[];
}
