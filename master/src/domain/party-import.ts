/**
 * Reading a spreadsheet as parties — pure, so the same functions answer "what
 * would this file do" and "do it", and a unit test can drive them with a
 * two-dimensional array (the model is `product-import.ts`).
 *
 * **One row is one party.** The 12 columns and their order are
 * `PARTY_IMPORT_COLUMNS`; `docs/PARTY_IMPORT_FORMAT.md` is the format a person
 * reads. Header matching ignores case, spaces and punctuation and knows the
 * usual office words (`Mobile`, `GSTIN`, `PIN`), and an issue echoes back the
 * header exactly as the person wrote it.
 *
 * Reads only what a row asserts: a blank cell leaves the key absent, so an
 * `updateByCode` file leaves every field it does not fill exactly as it was
 * (`columnPatch` reads an absent key as "untouched", `null` as "clear" — an
 * import never clears).
 */

import type {
  MessageParams,
  PartyImportColumn,
  PartyImportField,
  PartyImportIssue,
  PartyImportMode,
  PartyInput,
} from '@orderbook/shared';
import { PARTY_IMPORT_COLUMNS } from '@orderbook/shared';

type Field = PartyImportColumn['field'];

const COLUMN_BY_FIELD = new Map(PARTY_IMPORT_COLUMNS.map((column) => [column.field, column]));

/** Lower-case letters and digits only: "Alt. Phone" and "alt_phone" are the same header. */
export function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** What a header cell may say for each field, besides its own label and key, by `normalizeHeader` form. */
const HEADER_ALIASES: Record<string, Field> = Object.fromEntries(
  (
    [
      ['partyCode', ['code', 'customercode', 'partyid']],
      ['name', ['partyname', 'party', 'customer', 'customername', 'dealer', 'dealername']],
      ['phone', ['phone1', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber']],
      ['altPhone', ['alternatephone', 'alternatemobile', 'altmobile', 'phone2', 'secondaryphone']],
      ['email', ['emailid', 'emailaddress', 'mail']],
      ['addressLine1', ['address1', 'address', 'addr1', 'street']],
      ['addressLine2', ['address2', 'addr2', 'area']],
      ['city', ['town']],
      ['state', ['province']],
      ['pincode', ['pin', 'pinno', 'pincodeno', 'postalcode', 'zip', 'zipcode']],
      ['gstNumber', ['gst', 'gstin', 'gstno']],
      ['notes', ['note', 'remarks', 'remark', 'comments']],
    ] as Array<[Field, string[]]>
  ).flatMap(([field, aliases]) =>
    [field, COLUMN_BY_FIELD.get(field)?.label ?? field, ...aliases].map((alias): [string, Field] => [
      normalizeHeader(alias),
      field,
    ]),
  ),
);

export interface PartyHeaderMatch {
  /** The column each header cell maps to, or null for one nothing knows. */
  byIndex: Array<PartyImportColumn | null>;
  /** Header cells that matched nothing, or matched a field already claimed. */
  ignored: string[];
  /** Fields the chosen mode needs that no header cell supplies. */
  missing: Field[];
}

/** The columns a file must have: Name to add a party, Party Code to update one. */
export function requiredFields(mode: PartyImportMode): Field[] {
  return mode === 'create' ? ['name'] : ['partyCode'];
}

export function matchPartyHeaders(headerRow: readonly string[], mode: PartyImportMode): PartyHeaderMatch {
  const byIndex: Array<PartyImportColumn | null> = [];
  const ignored: string[] = [];
  const claimed = new Set<Field>();

  for (const cell of headerRow) {
    const text = (cell ?? '').trim();
    const field = HEADER_ALIASES[normalizeHeader(text)];
    const column = field ? COLUMN_BY_FIELD.get(field) : undefined;

    if (!column || claimed.has(column.field)) {
      byIndex.push(null);
      if (text) ignored.push(text);
      continue;
    }

    claimed.add(column.field);
    byIndex.push(column);
  }

  return { byIndex, ignored, missing: requiredFields(mode).filter((field) => !claimed.has(field)) };
}

/** One sheet row, understood. `input` carries only the keys the row filled. */
export interface ParsedPartyRow {
  /** Spreadsheet row number: the header is row 1. */
  row: number;
  /** The Party Code cell, or null when it was blank. */
  code: string | null;
  /**
   * The cells as typed, trimmed and nothing more, by field. Kept so an update
   * can tell "the sheet says what the party already holds" from "the sheet
   * changed it" *before* any tidying: an export of a party whose name has a
   * double space must read back as no change.
   */
  raw: Partial<Record<PartyImportField, string>>;
  /** The same cells with inner whitespace collapsed (notes keep theirs) — what a save would write. */
  input: PartyInput;
}

/** A row is blank when every cell is — those are skipped without a word. */
export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((cell) => (cell ?? '').trim() === '');
}

/**
 * One row → one `ParsedPartyRow`, or the issues that stop it. Checks only the
 * mode's rules on the code and the name. Lengths and formats are
 * `checkPartyFields`, which runs once the service knows which party a row would
 * change — a value the party already holds must not be refused for being long
 * or loosely typed when the person did not touch it.
 */
export function parsePartyRow(
  cells: readonly string[],
  match: PartyHeaderMatch,
  headerRow: readonly string[],
  row: number,
  mode: PartyImportMode,
): { parsed: ParsedPartyRow | null; issues: PartyImportIssue[] } {
  const issues: PartyImportIssue[] = [];
  const input: Record<string, string> = {};
  const raws: Record<string, string> = {};
  let code: string | null = null;

  const headerOf = (field: Field): string | undefined => {
    const at = match.byIndex.findIndex((column) => column?.field === field);
    const text = at >= 0 ? (headerRow[at] ?? '').trim() : '';
    return text || COLUMN_BY_FIELD.get(field)?.label;
  };
  const issue = (field: Field, messageKey: PartyImportIssue['messageKey'], params?: MessageParams): void => {
    issues.push({ row, kind: 'error', column: headerOf(field), messageKey, params });
  };

  match.byIndex.forEach((column, index) => {
    if (!column) return;
    const raw = (cells[index] ?? '').trim();
    if (raw === '') return;

    if (column.field === 'partyCode') {
      code = raw;
      return;
    }
    raws[column.field] = raw;
    // Inner runs of whitespace (a pasted line break, a double space, a
    // non-breaking space) would make "Shah  Ceramics" a second party beside
    // "Shah Ceramics"; notes are free text and keep theirs.
    input[column.field] = column.field === 'notes' ? raw : raw.replace(/\s+/g, ' ');
  });

  if (mode === 'create') {
    if (code !== null) issue('partyCode', 'validation.import.partyCodeNotAllowed');
    if (!input.name) issue('name', 'validation.party.nameRequired');
  } else if (code === null) {
    issue('partyCode', 'validation.import.partyCodeRequired');
  }

  if (issues.length > 0) return { parsed: null, issues };
  return {
    parsed: { row, code, raw: raws as ParsedPartyRow['raw'], input: input as unknown as PartyInput },
    issues,
  };
}

const PINCODE = /^\d{6}$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Digits and the punctuation people put in a number; not a validator of a country's numbering plan. */
const PHONE_CHARS = /^[0-9+\-() ]+$/;
const PHONE_MIN_DIGITS = 6;

/** What Party Codes look like when the Master gives them (`P-0001`); a code in another shape cannot be one of ours. */
export const PARTY_CODE_PATTERN = /^P-\d{4,}$/i;

/** The fields whose value is a phone number. */
const PHONE_FIELDS = new Set<PartyImportField>(['phone', 'altPhone']);

/** What a stored party holds in a field, as the sheet would show it. */
function heldValue(existing: Record<string, unknown>, field: string): string {
  const value = existing[field];
  return value === null || value === undefined ? '' : String(value);
}

/**
 * What a row would change, and what is wrong with it.
 *
 * `existing` is the party an `updateByCode` row names, or `null` when a row
 * adds one. For an update the result holds **only the fields that differ**: a
 * cell equal to what the party already holds — as typed, or once tidied the way
 * a save would tidy it — is not a change, is not length-checked and is not
 * format-checked. An export uploaded back must read "no change", and must not
 * fail on a legacy party whose address is longer than the cap or whose pincode
 * was typed loosely years ago, when nobody touched that cell.
 *
 * A changed value is checked (its length, then its format where it has one)
 * and tidied: a GSTIN in upper case, a pincode with no space inside it.
 */
export function checkPartyFields(
  parsed: ParsedPartyRow,
  existing: Record<string, unknown> | null,
  headerFor: (field: Field) => string,
): { input: PartyInput; issues: PartyImportIssue[] } {
  const issues: PartyImportIssue[] = [];
  const input: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed.input) as Array<[PartyImportField, string]>) {
    const column = COLUMN_BY_FIELD.get(key);
    if (!column) continue;

    if (existing) {
      const held = heldValue(existing, key);
      if (parsed.raw[key] === held || value === held) continue;
    }

    const problem = (messageKey: PartyImportIssue['messageKey'], params?: MessageParams): void => {
      issues.push({ row: parsed.row, kind: 'error', column: headerFor(key), messageKey, params });
    };

    if (value.length > column.max) {
      problem('validation.party.tooLong', { column: headerFor(key), max: column.max });
      continue;
    }

    if (key === 'pincode') {
      const tidied = value.replace(/\s/g, '');
      if (!PINCODE.test(tidied)) problem('validation.party.pincodeInvalid');
      else input[key] = tidied;
    } else if (key === 'gstNumber') {
      const tidied = value.replace(/\s/g, '').toUpperCase();
      if (!GSTIN.test(tidied)) problem('validation.party.gstInvalid');
      else input[key] = tidied;
    } else if (key === 'email') {
      if (!EMAIL.test(value)) problem('validation.party.emailInvalid');
      else input[key] = value;
    } else if (PHONE_FIELDS.has(key)) {
      if (!PHONE_CHARS.test(value) || value.replace(/\D/g, '').length < PHONE_MIN_DIGITS) problem('validation.party.phoneInvalid');
      else input[key] = value;
    } else {
      input[key] = value;
    }
  }

  return { input: input as unknown as PartyInput, issues };
}

/** The same party, as far as a sheet can tell: name and city, ignoring case and spacing. */
export function partyKey(name: string, city: string | null | undefined): string {
  const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  return `${tidy(name)}\u0001${tidy(city ?? '')}`;
}

/**
 * Second and later occurrences, within the file, of a Party Code (`updateByCode`)
 * or of a name and city (`create`). Reported against the *later* row and
 * pointing at the first, so the person fixes the duplicate, not the original.
 */
export function findDuplicatesInFile(
  rows: readonly ParsedPartyRow[],
  mode: PartyImportMode,
  headerFor: (field: Field) => string,
): PartyImportIssue[] {
  const issues: PartyImportIssue[] = [];
  const first = new Map<string, number>();
  const field: Field = mode === 'create' ? 'name' : 'partyCode';

  for (const entry of rows) {
    const key = mode === 'create' ? partyKey(entry.input.name, entry.input.city) : (entry.code ?? '').toLowerCase();
    const at = first.get(key);
    if (at === undefined) {
      first.set(key, entry.row);
      continue;
    }
    issues.push({
      row: entry.row,
      kind: 'error',
      column: headerFor(field),
      messageKey: 'validation.import.duplicateInFile',
      params: { column: headerFor(field), firstRow: at },
    });
  }

  return issues;
}

/** The guide sheet's rows, below its `column, required, kind, note` header. */
export function templateGuideRows(): string[][] {
  return PARTY_IMPORT_COLUMNS.map((column) => [column.label, column.required ? 'yes' : '', 'text', column.note]);
}
