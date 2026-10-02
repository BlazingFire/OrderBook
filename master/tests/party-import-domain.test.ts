/**
 * The pure half of the bulk party import: how a header row is understood, how
 * one row of text becomes a party or a list of numbered problems, and how the
 * format checks and duplicate rules behave. Pure, so it always runs — a
 * `describe.skipIf` suite that skips looks exactly like one that passes.
 */

import { PARTY_IMPORT_COLUMNS, PARTY_IMPORT_HEADERS } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

import {
  checkPartyFields,
  findDuplicatesInFile,
  isBlankRow,
  matchPartyHeaders,
  normalizeHeader,
  parsePartyRow,
  partyKey,
  templateGuideRows,
  type ParsedPartyRow,
} from '../src/domain/party-import.js';

const label = (field: string): string => PARTY_IMPORT_COLUMNS.find((column) => column.field === field)?.label ?? field;

function parse(headers: string[], cells: string[], mode: 'create' | 'updateByCode' = 'create', row = 2) {
  return parsePartyRow(cells, matchPartyHeaders(headers, mode), headers, row, mode);
}

describe('the template', () => {
  it('has the twelve columns in the documented order', () => {
    expect(PARTY_IMPORT_HEADERS).toEqual([
      'Party Code',
      'Name',
      'Phone',
      'Alt Phone',
      'Email',
      'Address Line 1',
      'Address Line 2',
      'City',
      'State',
      'Pincode',
      'GST Number',
      'Notes',
    ]);
  });

  it('writes one guide row per column, marking only Name required', () => {
    const rows = templateGuideRows();
    expect(rows).toHaveLength(12);
    expect(rows.filter((row) => row[1] === 'yes').map((row) => row[0])).toEqual(['Name']);
  });
});

describe('header matching', () => {
  it('ignores case, spaces and punctuation', () => {
    expect(normalizeHeader('Alt. Phone')).toBe('altphone');
    expect(normalizeHeader('GST  Number')).toBe('gstnumber');
  });

  it('maps every template header, and the usual office words, to the same fields', () => {
    const own = matchPartyHeaders([...PARTY_IMPORT_HEADERS], 'create');
    expect(own.byIndex.map((column) => column?.field)).toEqual(PARTY_IMPORT_COLUMNS.map((column) => column.field));
    expect(own.ignored).toEqual([]);

    const trade = matchPartyHeaders(['Customer', 'Mobile', 'GSTIN', 'PIN', 'Remarks', 'Town'], 'create');
    expect(trade.byIndex.map((column) => column?.field)).toEqual(['name', 'phone', 'gstNumber', 'pincode', 'notes', 'city']);
  });

  it('ignores a column nothing knows, and a header that repeats a field already claimed', () => {
    const match = matchPartyHeaders(['Name', 'Favourite colour', 'Customer'], 'create');
    expect(match.byIndex.map((column) => column?.field ?? null)).toEqual(['name', null, null]);
    expect(match.ignored).toEqual(['Favourite colour', 'Customer']);
  });

  it('needs Name to add parties and Party Code to update them', () => {
    expect(matchPartyHeaders(['Phone'], 'create').missing).toEqual(['name']);
    expect(matchPartyHeaders(['Name'], 'updateByCode').missing).toEqual(['partyCode']);
    expect(matchPartyHeaders(['Name', 'Party Code'], 'updateByCode').missing).toEqual([]);
  });
});

describe('one row, creating', () => {
  const HEAD = ['Party Code', 'Name', 'City', 'Phone', 'Notes'];

  it('keeps only the cells that were filled and collapses inner whitespace', () => {
    const { parsed, issues } = parse(HEAD, ['', '  Shah   Ceramics ', 'Morbi', '', 'two\nlines'], 'create', 7);
    expect(issues).toEqual([]);
    expect(parsed).toEqual({ row: 7, code: null, input: { name: 'Shah Ceramics', city: 'Morbi', notes: 'two\nlines' } });
    expect(parsed?.input).not.toHaveProperty('phone');
  });

  it('refuses a row that carries a Party Code, naming the header as written', () => {
    const { parsed, issues } = parse(['code', 'Name'], ['P-0001', 'Shah'], 'create', 3);
    expect(parsed).toBeNull();
    expect(issues).toEqual([
      { row: 3, kind: 'error', column: 'code', messageKey: 'validation.import.partyCodeNotAllowed', params: undefined },
    ]);
  });

  it('refuses a row with no name', () => {
    const { parsed, issues } = parse(HEAD, ['', '', 'Morbi', '', ''], 'create', 4);
    expect(parsed).toBeNull();
    expect(issues.map((issue) => [issue.row, issue.column, issue.messageKey])).toEqual([
      [4, 'Name', 'validation.party.nameRequired'],
    ]);
  });
});

describe('one row, updating by code', () => {
  const HEAD = ['Party Code', 'Name', 'Phone'];

  it('needs a code, but not a name — a blank cell leaves the field alone', () => {
    const { parsed, issues } = parse(HEAD, ['P-0007', '', '98250 00000'], 'updateByCode');
    expect(issues).toEqual([]);
    expect(parsed).toEqual({ row: 2, code: 'P-0007', input: { phone: '98250 00000' } });
  });

  it('refuses a row with no code', () => {
    const { parsed, issues } = parse(HEAD, ['', 'Shah', ''], 'updateByCode');
    expect(parsed).toBeNull();
    expect(issues[0]?.messageKey).toBe('validation.import.partyCodeRequired');
  });
});

describe('format checks', () => {
  const headerFor = label;
  const row = (input: Record<string, string>): ParsedPartyRow => ({ row: 5, code: null, input: input as never });

  it('accepts a good pincode, GSTIN and email, tidying the first two', () => {
    const { input, issues } = checkPartyFields(
      row({ name: 'A', pincode: '363 641', gstNumber: '24abcde1234f1z5', email: 'a@b.in' }),
      null,
      headerFor,
    );
    expect(issues).toEqual([]);
    expect(input).toMatchObject({ pincode: '363641', gstNumber: '24ABCDE1234F1Z5', email: 'a@b.in' });
  });

  it('refuses each bad value on its own cell, with the column named', () => {
    const { issues } = checkPartyFields(
      row({ name: 'A', pincode: '3636', gstNumber: 'NOTAGSTIN', email: 'nope' }),
      null,
      headerFor,
    );
    expect(issues.map((issue) => [issue.column, issue.messageKey])).toEqual([
      ['Pincode', 'validation.party.pincodeInvalid'],
      ['GST Number', 'validation.party.gstInvalid'],
      ['Email', 'validation.party.emailInvalid'],
    ]);
  });

  it('does not re-judge a value that is exactly what the party already holds', () => {
    const { issues } = checkPartyFields(row({ pincode: '3636' }), { pincode: '3636' }, headerFor);
    expect(issues).toEqual([]);
  });
});

describe('duplicates in the file', () => {
  const headerFor = label;
  const entry = (rowNumber: number, code: string | null, name: string, city?: string): ParsedPartyRow => ({
    row: rowNumber,
    code,
    input: { name, ...(city ? { city } : {}) } as never,
  });

  it('flags a repeated name and city, case and spacing aside, against the first row', () => {
    const issues = findDuplicatesInFile(
      [entry(2, null, 'Shah Ceramics', 'Morbi'), entry(3, null, 'shah  ceramics', ' MORBI'), entry(4, null, 'Shah Ceramics', 'Rajkot')],
      'create',
      headerFor,
    );
    expect(issues).toEqual([
      { row: 3, kind: 'error', column: 'Name', messageKey: 'validation.import.duplicateInFile', params: { column: 'Name', firstRow: 2 } },
    ]);
  });

  it('flags a repeated Party Code when updating', () => {
    const issues = findDuplicatesInFile([entry(2, 'P-0001', 'A'), entry(3, 'p-0001', 'B')], 'updateByCode', headerFor);
    expect(issues.map((issue) => [issue.row, issue.params])).toEqual([[3, { column: 'Party Code', firstRow: 2 }]]);
  });

  it('treats a missing city and a blank one as the same city', () => {
    expect(partyKey('A', null)).toBe(partyKey('a', '  '));
    expect(partyKey('A', 'x')).not.toBe(partyKey('A', null));
  });
});

describe('blank rows', () => {
  it('are rows of empty cells only', () => {
    expect(isBlankRow(['', '  ', ''])).toBe(true);
    expect(isBlankRow(['', 'x'])).toBe(false);
  });
});
