/**
 * The one opaque cursor codec four modules build on
 * (`docs/backend-modules/01-ARCHITECTURE.md` §4.2). Pure — no database — so
 * this gate cannot silently skip the way an integration suite can.
 */

import { describe, expect, it } from 'vitest';

import { clampCursorLimit, decodeCursor, encodeCursor } from '../src/domain/cursor.js';
import { ValidationError } from '../src/lib/errors.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a simple payload', () => {
    const payload = { id: '42', createdAt: '2026-08-24T10:00:00Z' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('round-trips a BIGINT id past 2^53 as a string without losing precision', () => {
    // node-postgres returns BIGINT as text; 2^53 is where `Number()` starts
    // silently losing precision, which is exactly the failure this codec
    // exists to make impossible.
    const bigId = '9007199254740993'; // 2^53 + 1
    const payload = { id: bigId };
    const decoded = decodeCursor<{ id: string }>(encodeCursor(payload));
    expect(decoded.id).toBe(bigId);
    expect(typeof decoded.id).toBe('string');
  });

  it('produces an opaque, URL-safe token', () => {
    const token = encodeCursor({ id: '1' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a malformed cursor rather than silently restarting at the newest page', () => {
    expect(() => decodeCursor('not-a-real-cursor!!!')).toThrow(ValidationError);
  });

  it('rejects a cursor that decodes to a non-object', () => {
    const arrayCursor = Buffer.from('[1,2,3]', 'utf8').toString('base64url');
    expect(() => decodeCursor(arrayCursor)).toThrow(ValidationError);

    const stringCursor = Buffer.from('"hello"', 'utf8').toString('base64url');
    expect(() => decodeCursor(stringCursor)).toThrow(ValidationError);
  });

  it('rejects a cursor minted for a structurally different payload only if it is not valid JSON at all', () => {
    // Cross-module payload confusion is a semantic bug the type system, not
    // this codec, is responsible for; the codec's only job is well-formedness.
    const otherModulesShape = encodeCursor({ deletedAt: '2026-01-01', entityType: 'lead', id: '1' });
    expect(() => decodeCursor(otherModulesShape)).not.toThrow();
  });

  it('the malformed-cursor error names the offending token in details', () => {
    expect.assertions(3);
    try {
      decodeCursor('%%%not-base64url%%%');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ cursor: '%%%not-base64url%%%' });
      expect((error as ValidationError).messageKey).toBe('validation.cursor.malformed');
    }
  });
});

describe('clampCursorLimit', () => {
  it('defaults when the limit is absent', () => {
    expect(clampCursorLimit(undefined)).toBe(50);
  });

  it('defaults when the limit is zero, negative, or non-finite', () => {
    expect(clampCursorLimit(0)).toBe(50);
    expect(clampCursorLimit(-5)).toBe(50);
    expect(clampCursorLimit(Number.NaN)).toBe(50);
    expect(clampCursorLimit(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it('truncates a fractional limit', () => {
    expect(clampCursorLimit(10.9)).toBe(10);
  });

  it('caps at the maximum', () => {
    expect(clampCursorLimit(10_000)).toBe(200);
  });

  it('honours a custom fallback and max', () => {
    expect(clampCursorLimit(undefined, 25, 100)).toBe(25);
    expect(clampCursorLimit(500, 25, 100)).toBe(100);
  });

  it('passes a within-range value through unchanged', () => {
    expect(clampCursorLimit(30)).toBe(30);
  });
});
