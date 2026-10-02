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

import type { MessageParams, PartyImportColumn, PartyImportIssue, PartyImportMode, PartyInput } from '@orderbook/shared';
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
      ['phone', ['phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber']],
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
  input: PartyInput;
}

/** A row is blank when every cell is — those are skipped without a word. */
export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((cell) => (cell ?? '').trim() === '');
}

/**
 * One row → one `ParsedPartyRow`, or the issues that stop it. Checks the
 * mode's rules on the code and the name; the format of a pincode, GSTIN or
 * email is `partyFieldIssues`, which the service runs once it knows the party
 * a row would change.
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
  let code: string | null = null;

  const indexOf = (field: Field): number => match.byIndex.findIndex((column) => column?.field === field);
  const headerOf = (field: Field): string | undefined => {
    const at = indexOf(field);
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

    if (column.field === 'partyCode') code = raw;
    // Inner runs of whitespace (a pasted line break, a double space, a
    // non-breaking space) would make "Shah  Ceramics" a second party beside
    // "Shah Ceramics"; notes are free text and keep theirs.
    else input[column.field] = column.field === 'notes' ? raw : raw.replace(/\s+/g, ' ');
  });

  if (mode === 'create') {
    if (code !== null) issue('partyCode', 'validation.import.partyCodeNotAllowed');
    if (!input.name) issue('name', 'validation.party.nameRequired');
  } else if (code === null) {
    issue('partyCode', 'validation.import.partyCodeRequired');
  }

  return issues.length > 0 ? { parsed: null, issues } : { parsed: { row, code, input: input as unknown as PartyInput }, issues };
}

const PINCODE = /^\d{6}$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Format problems in what a row asserts, and the same row with the values
 * tidied (a GSTIN in upper case, a pincode without a space inside it).
 *
 * A value equal to what the party already holds is not looked at: an export
 * uploaded back must not fail on an old party whose pincode was typed loosely
 * years ago, when the person changed nothing in that cell.
 */
export function checkPartyFields(
  parsed: ParsedPartyRow,
  existing: Partial<Record<'pincode' | 'gstNumber' | 'email', string | null>> | null,
  headerFor: (field: Field) => string,
): { input: PartyInput; issues: PartyImportIssue[] } {
  const issues: PartyImportIssue[] = [];
  const input: PartyInput = { ...parsed.input };

  const check = (
    key: 'pincode' | 'gstNumber' | 'email',
    tidy: (value: string) => string,
    valid: (value: string) => boolean,
    messageKey: PartyImportIssue['messageKey'],
  ): void => {
    const value = input[key];
    if (typeof value !== 'string') return;
    if (value === (existing?.[key] ?? null)) return;
    const tidied = tidy(value);
    if (!valid(tidied)) {
      issues.push({ row: parsed.row, kind: 'error', column: headerFor(key), messageKey });
      return;
    }
    input[key] = tidied;
  };

  check('pincode', (value) => value.replace(/\s/g, ''), (value) => PINCODE.test(value), 'validation.party.pincodeInvalid');
  check('gstNumber', (value) => value.replace(/\s/g, '').toUpperCase(), (value) => GSTIN.test(value), 'validation.party.gstInvalid');
  check('email', (value) => value, (value) => EMAIL.test(value), 'validation.party.emailInvalid');

  return { input, issues };
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
