/**
 * Pure Fields invariants — no database, no transaction, run anywhere.
 * `docs/backend-modules/10-TESTING.md` §"Stage 3 — Fields": FLD-1 through
 * FLD-4.
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
  it('trims leading and trailing whitespace', () => {
    expect(normaliseOptionValue('  White  ')).toBe('White');
  });

  it('FLD-1: never case-folds — "White" and "white" stay two distinct values', () => {
    expect(normaliseOptionValue('White')).toBe('White');
    expect(normaliseOptionValue('white')).toBe('white');
    expect(normaliseOptionValue('White')).not.toBe(normaliseOptionValue('white'));
  });
});

describe('assertHexColour', () => {
  it('FLD-4: normalises a valid hex to lowercase', () => {
    expect(assertHexColour('#ABCDEF')).toBe('#abcdef');
    expect(assertHexColour('#abcdef')).toBe('#abcdef');
  });

  it('FLD-4: rejects a malformed hex', () => {
    expect(() => assertHexColour('abcdef')).toThrow(ValidationError);
    expect(() => assertHexColour('#abc')).toThrow(ValidationError);
    expect(() => assertHexColour('#gggggg')).toThrow(ValidationError);
    expect(() => assertHexColour('#abcdefg')).toThrow(ValidationError);
  });

  it('is null for null, undefined, or empty — a set with no colour to render', () => {
    expect(assertHexColour(null)).toBeNull();
    expect(assertHexColour(undefined)).toBeNull();
    expect(assertHexColour('')).toBeNull();
  });

  it('names the field the caller asked about, in the details', () => {
    try {
      assertHexColour('nope', 'colourHex');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: 'colourHex' });
    }
  });
});

describe('assertOptionValueChange', () => {
  it('FLD-2: passes a value a record already holds, even when the option is no longer valid', () => {
    expect(() =>
      assertOptionValueChange('WhatsApp', 'WhatsApp', false, 'validation.lead.sourceInvalid'),
    ).not.toThrow();
  });

  it('rejects a new value that is not currently valid', () => {
    expect(() =>
      assertOptionValueChange('Carrier Pigeon', 'WhatsApp', false, 'validation.lead.sourceInvalid'),
    ).toThrow(ValidationError);
  });

  it('accepts a new value that is currently valid', () => {
    expect(() =>
      assertOptionValueChange('Website', 'WhatsApp', true, 'validation.lead.sourceInvalid'),
    ).not.toThrow();
  });

  it('accepts a first-time value (no previous) when currently valid', () => {
    expect(() => assertOptionValueChange('Website', null, true, 'validation.lead.sourceInvalid')).not.toThrow();
  });
});

describe('assertCompleteReorder', () => {
  const live = ['a', 'b', 'c'];

  it('FLD-3: accepts an exact permutation', () => {
    expect(() => assertCompleteReorder(['c', 'a', 'b'], live)).not.toThrow();
  });

  it('FLD-3: rejects a list missing a live id', () => {
    expect(() => assertCompleteReorder(['a', 'b'], live)).toThrow(ValidationError);
  });

  it('FLD-3: rejects a list naming an id that is not live', () => {
    expect(() => assertCompleteReorder(['a', 'b', 'c', 'z'], live)).toThrow(ValidationError);
  });

  it('FLD-3: rejects a list with a duplicate', () => {
    expect(() => assertCompleteReorder(['a', 'a', 'b'], ['a', 'b'])).toThrow(ValidationError);
  });

  it('carries extra context (e.g. listKey, pipelineId) in the error details', () => {
    try {
      assertCompleteReorder(['a'], live, { listKey: 'stock.colour' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: 'ids', listKey: 'stock.colour' });
    }
  });
});

describe('resequence', () => {
  it('numbers an ordered id list 1..N', () => {
    expect(resequence(['x', 'y', 'z'])).toEqual([
      { id: 'x', sequence: 1 },
      { id: 'y', sequence: 2 },
      { id: 'z', sequence: 3 },
    ]);
  });

  it('is empty for an empty list', () => {
    expect(resequence([])).toEqual([]);
  });
});
