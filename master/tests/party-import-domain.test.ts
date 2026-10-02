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
  PARTY_CODE_PATTERN,
  parsePartyRow,
  partyKey,
  templateGuideRows,
  type ParsedPartyRow,
} from '../src/domain/party-import.js';

const label = (field: string): string => PARTY_IMPORT_COLUMNS.find((column) => column.field === field)?.label ?? field;

function parse(headers: string[], cells: string[], mode: 'create' | 'updateByCode' = 'create', row = 2) {
  return parsePartyRow(cells, matchPartyHeaders(headers, mode), headers, row, mode);
}

/** A parsed row built the way `parsePartyRow` would, from what was typed. */
function typed(rowNumber: number, raw: Record<string, string>, code: string | null = null): ParsedPartyRow {
  const input = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, key === 'notes' ? value : value.replace(/\s+/g, ' ')]),
  );
  return { row: rowNumber, code, raw: raw as never, input: input as never };
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

  it('keeps only the cells that were filled, and both what was typed and the whitespace-collapsed value', () => {
    const { parsed, issues } = parse(HEAD, ['', '  Shah   Ceramics ', 'Morbi', '', 'two\nlines'], 'create', 7);
    expect(issues).toEqual([]);
    expect(parsed).toEqual({
      row: 7,
      code: null,
      raw: { name: 'Shah   Ceramics', city: 'Morbi', notes: 'two\nlines' },
      input: { name: 'Shah Ceramics', city: 'Morbi', notes: 'two\nlines' },
    });
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
    expect(parsed).toMatchObject({ row: 2, code: 'P-0007', input: { phone: '98250 00000' } });
  });

  it('refuses a row with no code', () => {
    const { parsed, issues } = parse(HEAD, ['', 'Shah', ''], 'updateByCode');
    expect(parsed).toBeNull();
    expect(issues[0]?.messageKey).toBe('validation.import.partyCodeRequired');
  });

  it('reads a code shaped like the Master gives them as ours, and anything else as not', () => {
    expect(PARTY_CODE_PATTERN.test('P-0001')).toBe(true);
    expect(PARTY_CODE_PATTERN.test('p-12345')).toBe(true);
    expect(PARTY_CODE_PATTERN.test('P-1')).toBe(false);
    expect(PARTY_CODE_PATTERN.test('Shah')).toBe(false);
  });
});

describe('format checks on a row that adds a party', () => {
  const headerFor = label;

  it('accepts a good pincode, GSTIN, email and phone, tidying the first two', () => {
    const { input, issues } = checkPartyFields(
      typed(5, { name: 'A', pincode: '363 641', gstNumber: '24abcde1234f1z5', email: 'a@b.in', phone: '+91 (281) 222-3333' }),
      null,
      headerFor,
    );
    expect(issues).toEqual([]);
    expect(input).toMatchObject({ pincode: '363641', gstNumber: '24ABCDE1234F1Z5', email: 'a@b.in', phone: '+91 (281) 222-3333' });
  });

  it('refuses each bad value on its own cell, with the column named', () => {
    const { issues } = checkPartyFields(
      typed(5, { name: 'A', pincode: '3636', gstNumber: 'NOTAGSTIN', email: 'nope', phone: '12ab', altPhone: '12345' }),
      null,
      headerFor,
    );
    expect(issues.map((issue) => [issue.column, issue.messageKey]).sort()).toEqual(
      [
        ['Phone', 'validation.party.phoneInvalid'],
        ['Alt Phone', 'validation.party.phoneInvalid'],
        ['Email', 'validation.party.emailInvalid'],
        ['Pincode', 'validation.party.pincodeInvalid'],
        ['GST Number', 'validation.party.gstInvalid'],
      ].sort(),
    );
  });

  it('accepts a phone with six digits and refuses one with five, whatever else is in it', () => {
    const run = (phone: string) => checkPartyFields(typed(2, { name: 'A', phone }), null, headerFor).issues.length;
    expect(run('98250 11')).toBe(0);
    expect(run('0281-22')).toBe(0);
    expect(run('98250')).toBe(1);
    expect(run('98250 11 ext')).toBe(1);
  });
});

describe('what an update changes', () => {
  const headerFor = label;
  const held = {
    name: 'Shah  Ceramics',
    city: 'Morbi',
    pincode: '3636',
    phone: '98250 11111',
    addressLine1: 'x'.repeat(250),
  };

  it('is only the cells that differ from what the party holds', () => {
    const { input, issues } = checkPartyFields(typed(2, { name: 'Shah  Ceramics', city: 'Rajkot', phone: '98250 11111' }, 'P-0001'), held, headerFor);
    expect(issues).toEqual([]);
    expect(input).toEqual({ city: 'Rajkot' });
  });

  it('reads a value equal to the stored one — typed or tidied — as no change, even past the cap or in a loose shape', () => {
    // The stored name has a double space and the export writes it as it is, so it comes back as it is.
    expect(checkPartyFields(typed(2, { name: 'Shah  Ceramics' }, 'P-0001'), held, headerFor).input).toEqual({});
    // The stored address is longer than any column allows; handing it back is not a change and not an error.
    expect(checkPartyFields(typed(2, { addressLine1: 'x'.repeat(250) }, 'P-0001'), held, headerFor)).toEqual({ input: {}, issues: [] });
    // A pincode typed loosely years ago.
    expect(checkPartyFields(typed(2, { pincode: '3636' }, 'P-0001'), held, headerFor)).toEqual({ input: {}, issues: [] });
  });

  it('checks a value that does differ, however loose the stored one was', () => {
    const { issues } = checkPartyFields(typed(2, { pincode: '3637' }, 'P-0001'), held, headerFor);
    expect(issues.map((issue) => issue.messageKey)).toEqual(['validation.party.pincodeInvalid']);
  });

  it('treats a stored empty value and a missing one alike, so filling a blank is a change', () => {
    expect(checkPartyFields(typed(2, { email: 'a@b.in' }, 'P-0001'), { name: 'A', email: null }, headerFor).input).toEqual({ email: 'a@b.in' });
  });
});

describe('column lengths', () => {
  it('refuses a changed cell longer than its column allows, once, naming the header', () => {
    const { input, issues } = checkPartyFields(typed(6, { name: 'x'.repeat(121) }), null, (field) => (field === 'name' ? 'Customer' : label(field)));
    expect(input).toEqual({});
    expect(issues).toEqual([
      { row: 6, kind: 'error', column: 'Customer', messageKey: 'validation.party.tooLong', params: { column: 'Customer', max: 120 } },
    ]);
  });

  it('accepts a cell exactly at the limit, and reads Phone 1 as the main phone', () => {
    const { parsed } = parse(['Name', 'Phone 1'], ['x'.repeat(120), '9'.repeat(20)]);
    expect(parsed?.input).toEqual({ name: 'x'.repeat(120), phone: '9'.repeat(20) });
    expect(checkPartyFields(parsed as ParsedPartyRow, null, label).issues).toEqual([]);
  });
});

describe('duplicates in the file', () => {
  const headerFor = label;
  const entry = (rowNumber: number, code: string | null, name: string, city?: string): ParsedPartyRow =>
    typed(rowNumber, { name, ...(city ? { city } : {}) }, code);

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
