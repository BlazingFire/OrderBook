/**
 * Fields' pure invariants — no case-folding, the only-on-change rule, the
 * permutation check, hex normalisation. Deliberately database-free, per
 * `docs/backend-modules/10-TESTING.md` §6.4 (`FLD-1`…`FLD-4`).
 */

import { describe, expect, it } from 'vitest';

import {
  assertCompleteReorder,
  assertHexColour,
  assertOptionValueChange,
  normaliseOptionValue,
  resequence,
} from '../src/domain/field-values.js';
import { ValidationError } from '../src/lib/errors.js';

describe('normaliseOptionValue', () => {
  it('trims surrounding whitespace', () => {
    expect(normaliseOptionValue('  Ivory  ')).toBe('Ivory');
  });

  it('never case-folds — "White" and "white" are two distinct values', () => {
    expect(normaliseOptionValue('White')).toBe('White');
    expect(normaliseOptionValue('white')).toBe('white');
    expect(normaliseOptionValue('White')).not.toBe(normaliseOptionValue('white'));
  });
});

describe('assertHexColour', () => {
  it('normalises to lowercase', () => {
    expect(assertHexColour('#ABCDEF')).toBe('#abcdef');
  });

  it('accepts an already-lowercase hex unchanged', () => {
    expect(assertHexColour('#a1b2c3')).toBe('#a1b2c3');
  });

  it.each(['abcdef', '#abcd', '#ggg', '#12345g', 'red', ''])(
    'rejects a malformed hex: %s',
    (bad) => {
      expect(() => assertHexColour(bad)).toThrow(ValidationError);
    },
  );
});

describe('assertOptionValueChange', () => {
  it('passes quietly when the value is unchanged, even when invalid', () => {
    expect(() => assertOptionValueChange('Ivory', 'Ivory', false)).not.toThrow();
  });

  it('passes a value a record already holds, even after the option was removed', () => {
    // `isValid` is false (the option is gone), but the value did not change —
    // resubmitting the record must not be punished for a removal it did not cause.
    expect(() => assertOptionValueChange('Ivory', 'Ivory', false)).not.toThrow();
  });

  it('throws when the value changes to something invalid', () => {
    expect(() => assertOptionValueChange('Ivory', 'Ebony', false)).toThrow(ValidationError);
  });

  it('passes when the value changes to something valid', () => {
    expect(() => assertOptionValueChange('Ivory', 'Ebony', true)).not.toThrow();
  });
});

describe('assertCompleteReorder', () => {
  it('accepts a full permutation', () => {
    expect(() => assertCompleteReorder(['a', 'b', 'c'], ['c', 'a', 'b'])).not.toThrow();
  });

  it('rejects a list missing an id', () => {
    expect(() => assertCompleteReorder(['a', 'b', 'c'], ['a', 'b'])).toThrow(ValidationError);
  });

  it('rejects a list carrying an unexpected id', () => {
    expect(() => assertCompleteReorder(['a', 'b'], ['a', 'b', 'z'])).toThrow(ValidationError);
  });

  it('names the missing and unexpected ids in details', () => {
    expect.assertions(2);
    try {
      assertCompleteReorder(['a', 'b', 'c'], ['a', 'b', 'z']);
    } catch (error) {
      const details = (error as ValidationError).details as { missing: string[]; unexpected: string[] };
      expect(details.missing).toEqual(['c']);
      expect(details.unexpected).toEqual(['z']);
    }
  });

  it('rejects a duplicate standing in for a missing id, even at the same length', () => {
    expect(() => assertCompleteReorder(['a', 'b', 'c'], ['a', 'b', 'b'])).toThrow(ValidationError);
  });
});

describe('resequence', () => {
  it('renumbers a permutation 1..N in the order given', () => {
    expect(resequence(['c', 'a', 'b'])).toEqual(
      new Map([
        ['c', 1],
        ['a', 2],
        ['b', 3],
      ]),
    );
  });
});
