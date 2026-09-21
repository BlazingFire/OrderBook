/**
 * The pure half of the connector: pointers, transforms, hashing and diffing.
 *
 * No database and no network, because this is where a mapping either does what
 * the person who filled in the form expected or quietly corrupts the catalogue
 * — and a live remote system is the worst possible place to find that out.
 */

import { describe, expect, it } from 'vitest';

import { flattenPointers, readPointer } from '../src/domain/json-pointer.js';
import {
  applyTransform,
  changedFields,
  hashInput,
  mapRow,
} from '../src/domain/connector-mapping.js';
import type { ConnectorFieldMap } from '@orderbook/shared';

function fieldMap(
  overrides: Partial<ConnectorFieldMap> & { localField: string; remotePointer: string },
): ConnectorFieldMap {
  return {
    id: 'x',
    resourceId: 'r',
    transform: null,
    onConflict: 'remote_wins',
    isRequired: false,
    ...overrides,
  };
}

describe('JSON pointers', () => {
  const document = { data: [{ id: 7, address: { city: 'Morbi' }, 'a/b': 1 }] };

  it('reads through objects and arrays', () => {
    expect(readPointer(document, '/data/0/address/city')).toBe('Morbi');
  });

  it('treats the empty pointer as the whole document', () => {
    // Which is what an `items_pointer` of `''` means for an API that answers
    // with a bare array rather than an envelope.
    expect(readPointer([1, 2], '')).toEqual([1, 2]);
  });

  it('decodes the two escapes', () => {
    expect(readPointer(document, '/data/0/a~1b')).toBe(1);
  });

  it('returns undefined rather than throwing on a path that does not resolve', () => {
    // Absent, not null: the mapper leaves the field out entirely, which is what
    // keeps an import a patch rather than a replace.
    expect(readPointer(document, '/data/5/city')).toBeUndefined();
    expect(readPointer(document, 'data')).toBeUndefined();
  });

  it('lists a sample row’s pointers, walking an array at index zero only', () => {
    // Two hundred line items would otherwise produce two hundred near-identical
    // pointers, and the shape is what the picker is showing.
    expect(flattenPointers({ lines: [{ sku: 'A' }, { sku: 'B' }] })).toEqual(['/lines/0/sku']);
  });
});

describe('transforms', () => {
  it('keeps only digits for a phone number', () => {
    expect(applyTransform('+91 98250-11111', 'digits')).toBe('919825011111');
  });

  it('trims, uppercases and lowercases text', () => {
    expect(applyTransform('  Shree ', 'trim')).toBe('Shree');
    expect(applyTransform('rst-300', 'upper')).toBe('RST-300');
    expect(applyTransform('RST-300', 'lower')).toBe('rst-300');
  });

  it('passes null through untouched, whatever the transform', () => {
    expect(applyTransform(null, 'upper')).toBeNull();
  });
});

describe('mapping a row', () => {
  const maps = [
    fieldMap({ localField: 'name', remotePointer: '/name', transform: 'trim', isRequired: true }),
    fieldMap({ localField: 'phone', remotePointer: '/mobile', transform: 'digits' }),
    fieldMap({ localField: 'size', remotePointer: '/size', transform: 'trim' }),
  ];

  it('leaves an unresolved field absent rather than null', () => {
    const mapped = mapRow({ name: '  Shree  ' }, maps);

    expect(mapped.input).toEqual({ name: 'Shree' });
    // Not `phone: null` — a remote system that does not carry a phone column
    // must not blank the number somebody typed here.
    expect('phone' in mapped.input).toBe(false);
  });

  it('names the required fields the remote did not supply', () => {
    expect(mapRow({ mobile: '98250' }, maps).missing).toEqual(['name']);
  });

  it('hashes what would be written, not what arrived', () => {
    // Same mapped result from two differently-shaped remote rows: a remote that
    // reformats a field it does not otherwise change must not make every row
    // look modified.
    const a = mapRow({ name: 'Shree', size: '18x12' }, maps);
    const b = mapRow({ name: '  Shree ', size: ' 18x12 ' }, maps);
    expect(a.hash).toBe(b.hash);
  });

  it('hashes independently of key order', () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  });
});

describe('what would change', () => {
  it('compares loosely, so a stringified number is not a change', () => {
    // Reporting `"12.5"` against a stored `12.5` as a difference would make
    // every run rewrite every row, and every rewrite is an audit entry.
    expect(changedFields({ weightKg: 12.5 }, { weightKg: '12.5' })).toEqual([]);
  });

  it('reports a real change, and a field going from empty to set', () => {
    expect(changedFields({ name: 'Old', phone: null }, { name: 'New', phone: '98250' })).toEqual([
      'name',
      'phone',
    ]);
  });

  it('ignores fields the remote did not send', () => {
    expect(changedFields({ name: 'Old', notes: 'kept' }, { name: 'Old' })).toEqual([]);
  });
});
