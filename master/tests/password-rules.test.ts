/**
 * The password minimum, and the one thing that lets three call sites share it.
 *
 * Pure — `assertPasswordLongEnough` and `generateTemporaryPassword` touch no
 * database. `credential-invariants.test.ts` proves every path that hashes a
 * caller-supplied password calls the assertion; this proves the assertion is
 * worth calling, and that the generated fallback the admin paths use is
 * genuinely exempt rather than exempt by assumption.
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/lib/errors.js';
import {
  PASSWORD_MIN_LENGTH,
  assertPasswordLongEnough,
  generateTemporaryPassword,
} from '../src/lib/password.js';

describe('assertPasswordLongEnough', () => {
  it('accepts a password exactly at the minimum and refuses one a character short', () => {
    expect(() => assertPasswordLongEnough('a'.repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
    expect(() => assertPasswordLongEnough('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toThrow(
      ValidationError,
    );
  });

  it('refuses an empty password, which is what a bare `||` fallback used to hash', () => {
    expect(() => assertPasswordLongEnough('')).toThrow(ValidationError);
  });

  it('says the number the constant declares, so the rule and the sentence cannot drift', () => {
    // `validation.password.tooShort` spells the minimum out in both
    // catalogues. Raising the constant without touching them would leave the
    // product refusing a password while telling somebody it is long enough.
    expect(() => assertPasswordLongEnough('short')).toThrow(
      new RegExp(`\\b${PASSWORD_MIN_LENGTH}\\b`),
    );
  });
});

describe('generateTemporaryPassword', () => {
  it('always clears the minimum, which is why the admin paths may skip the check on it', () => {
    // The exemption in `createUser` and `resetPassword` rests on this. If the
    // default length ever dropped below the minimum, those paths would mint
    // accounts the product refuses to let anyone set by hand.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(() => assertPasswordLongEnough(generateTemporaryPassword())).not.toThrow();
    }
  });

  it('omits characters that are misread when a password is read aloud', () => {
    const generated = generateTemporaryPassword(200);
    expect(generated).not.toMatch(/[0O1lI]/);
  });
});
