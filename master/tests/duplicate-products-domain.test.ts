/** The duplicate finder's grouping rules, without a database. */

import { describe, expect, it } from 'vitest';
import { duplicateKey } from '@orderbook/shared';

import { findDuplicateGroups, type DuplicateCandidate } from '../src/domain/duplicate-products.js';

let next = 0;
function row(overrides: Partial<DuplicateCandidate>): DuplicateCandidate {
  next += 1;
  return {
    id: `R${next}`,
    name: `Row ${next}`,
    codes: [],
    brand: 'Swisware+',
    categoryId: null,
    productName: null,
    size: null,
    subProductCount: 0,
    lineCount: 0,
    createdAt: `2026-01-0${next % 9 || 9}T00:00:00.000Z`,
    ...overrides,
  };
}

describe('duplicateKey', () => {
  it('ignores case, spacing, punctuation and accents', () => {
    expect(duplicateKey('Wash  Basin.')).toBe(duplicateKey('wash-basin'));
    expect(duplicateKey('OPT-0001')).toBe(duplicateKey('opt0001'));
    expect(duplicateKey('Café')).toBe(duplicateKey('cafe'));
  });

  it('is empty when nothing is left, so an empty key never groups', () => {
    expect(duplicateKey(' -- ')).toBe('');
    expect(duplicateKey(null)).toBe('');
  });
});

describe('findDuplicateGroups', () => {
  it('groups Products of one brand by name and code, and not across brands', () => {
    const groups = findDuplicateGroups('product', [
      row({ id: 'A', name: 'Wash Basin', codes: ['WB'] }),
      row({ id: 'B', name: 'wash-basin', codes: ['WB2'] }),
      row({ id: 'C', name: 'Wash Basin', brand: 'Other', codes: ['WB3'] }),
      row({ id: 'D', name: 'Pedestal', codes: ['wb2'] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.id).sort()).toEqual(['A', 'B', 'D']);
    expect(groups[0]?.matchedOn).toEqual(['name', 'code']);
  });

  it('keeps same-named sub products of different Products apart', () => {
    const groups = findDuplicateGroups('subProduct', [
      row({ id: 'A', name: '1111', categoryId: 'P1', codes: ['A-1'] }),
      row({ id: 'B', name: '1111', categoryId: 'P2', codes: ['B-1'] }),
      row({ id: 'C', name: '41', categoryId: 'P1', codes: ['A-2'] }),
      row({ id: 'D', name: '41.', categoryId: 'P1', codes: ['A-3'] }),
    ]);

    expect(groups.map((group) => group.members.map((member) => member.id).sort())).toEqual([['C', 'D']]);
    expect(groups[0]?.matchedOn).toEqual(['name']);
  });

  it('puts the oldest first and blocks what is in use', () => {
    const [group] = findDuplicateGroups('subProduct', [
      row({ id: 'NEW', name: 'Magenta', categoryId: 'P', createdAt: '2026-03-01T00:00:00.000Z', lineCount: 2 }),
      row({ id: 'OLD', name: 'MAGENTA', categoryId: 'P', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    expect(group?.members.map((member) => [member.id, member.blockedBy])).toEqual([
      ['OLD', null],
      ['NEW', 'liveReferences'],
    ]);
  });

  it('blocks a Product that still holds sub products', () => {
    const [group] = findDuplicateGroups('product', [
      row({ id: 'A', name: 'Basin', subProductCount: 3, createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'B', name: 'BASIN', createdAt: '2026-02-01T00:00:00.000Z' }),
    ]);

    expect(group?.members.map((member) => [member.id, member.blockedBy])).toEqual([
      ['A', 'subProducts'],
      ['B', null],
    ]);
  });

  it('finds nothing when every name and code differs', () => {
    expect(
      findDuplicateGroups('product', [row({ name: 'A', codes: ['X1'] }), row({ name: 'B', codes: ['X2'] })]),
    ).toEqual([]);
  });

  it('groups near-name suspects without merging them into exact matches', () => {
    const groups = findDuplicateGroups('product', [
      row({ id: 'A', name: 'DAMRU', codes: ['X1'] }),
      row({ id: 'B', name: 'DAMRUU', codes: ['X2'] }),
      row({ id: 'C', name: 'Pedestal', codes: ['Y1'] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.id).sort()).toEqual(['A', 'B']);
    expect(groups[0]?.matchedOn).toEqual(['near-name']);
  });

  it('groups code-variant suspects within a brand', () => {
    const groups = findDuplicateGroups('subProduct', [
      row({ id: 'A', name: 'Basin', categoryId: 'P', codes: ['OPT-0001'] }),
      row({ id: 'B', name: 'Basin Pro', categoryId: 'P', codes: ['OPT-001'] }),
      row({ id: 'C', name: 'Basin', categoryId: 'Q', codes: ['OPT-0002'] }),
    ]);

    // A~B differ only by zero padding (variant); C is unrelated.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.id).sort()).toEqual(['A', 'B']);
    expect(groups[0]?.matchedOn).toEqual(['code-variant']);
  });

  it('does not raise a suspect for an exact match or a far name', () => {
    const groups = findDuplicateGroups('product', [
      row({ id: 'A', name: 'Wash Basin', codes: ['WB'] }),
      row({ id: 'B', name: 'wash-basin', codes: ['WB2'] }),
      row({ id: 'C', name: 'Washing Machine Deluxe', codes: ['W1'] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.matchedOn).toEqual(['name']);
  });
});
