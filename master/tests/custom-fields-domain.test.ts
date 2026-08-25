/**
 * The zero case. A numeric custom field whose value is `0` — "Advance
 * received", "Samples sent" — is a filled-in field, not an empty one, and the
 * panels rely on that: they post whatever was typed and leave the coercion
 * here, so anything this pair treats as blank is silently lost on the way in
 * and comes back wearing an "incomplete" badge. Database-free by design.
 */

import { describe, expect, it } from 'vitest';
import type { CustomFieldDefinition } from '@orderbook/shared';

import { evaluateCompleteness, normalizeCustomFields } from '../src/domain/custom-fields.js';

function definition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-0000000000ff',
    entity: 'lead',
    key: 'advanceReceived',
    label: 'Advance received',
    fieldType: 'number',
    isRequired: true,
    options: [],
    sequence: 1,
    isActive: true,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('normalizeCustomFields', () => {
  it('keeps a zero typed into a numeric field', () => {
    expect(normalizeCustomFields({ advanceReceived: '0' }, [definition()])).toEqual({
      advanceReceived: 0,
    });
  });

  it('parses the number out of the string the panels send', () => {
    expect(normalizeCustomFields({ advanceReceived: '0.5' }, [definition()])).toEqual({
      advanceReceived: 0.5,
    });
  });

  it('drops a field the user left empty', () => {
    expect(normalizeCustomFields({ advanceReceived: '' }, [definition()])).toEqual({});
  });
});

describe('evaluateCompleteness', () => {
  it('does not call a required numeric field missing when it holds zero', () => {
    expect(evaluateCompleteness({ advanceReceived: 0 }, [definition()])).toEqual({
      incomplete: false,
      missingFields: [],
    });
  });

  it('names a required field that was never filled in', () => {
    expect(evaluateCompleteness({}, [definition()])).toEqual({
      incomplete: true,
      missingFields: ['Advance received'],
    });
  });
});
