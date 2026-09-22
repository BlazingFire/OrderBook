/**
 * Password hashing (docs/ROLES_AND_USERS.md §4, §9).
 *
 * scrypt, in the documented `scrypt$N$r$p$salt$hash` form. Node ships it, so
 * this adds no dependency — which matters for software that must install on a
 * shop PC with no internet.
 *
 * Existing installations were created with bcrypt. Rather than invalidating
 * every password, `verify` accepts either form and reports whether the stored
 * hash should be upgraded; the sign-in path rewrites it to scrypt on the next
 * successful sign-in, so the migration completes itself without anyone being
 * locked out.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

import { ValidationError } from './errors.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Cost parameters. N=16384 keeps a single hash in the tens of milliseconds on a
 * shop-floor PC — slow enough to make offline guessing expensive, fast enough
 * that a person signing in does not notice.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const SCRYPT_PREFIX = 'scrypt$';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH);

  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export interface VerifyResult {
  matches: boolean;
  /** True when the stored hash is an older format worth rewriting on sign-in. */
  needsUpgrade: boolean;
}

export async function verifyPassword(
  password: string,
  storedHash: string | null,
): Promise<VerifyResult> {
  // A missing user still costs a hash comparison, so a wrong username and a
  // wrong password take the same time to answer and the endpoint is not a
  // username oracle.
  if (!storedHash) {
    await hashPassword(password);
    return { matches: false, needsUpgrade: false };
  }

  if (storedHash.startsWith(SCRYPT_PREFIX)) {
    return { matches: await verifyScrypt(password, storedHash), needsUpgrade: false };
  }

  // Legacy bcrypt from before this module existed.
  const matches = await bcrypt.compare(password, storedHash);
  return { matches, needsUpgrade: matches };
}

async function verifyScrypt(password: string, storedHash: string): Promise<boolean> {
  // `scrypt$16384$8$1$<salt>$<hash>` splits into six parts, the first being the
  // bare tag. An earlier version destructured five and read the cost parameter
  // out of the tag itself, which made every verification fail — the parse and
  // the format have to be read together, so they are written together.
  const [tag, cost, r, p, salt, expected] = storedHash.split('$');
  const n = Number(cost);

  if (tag !== 'scrypt' || !Number.isFinite(n) || !r || !p || !salt || !expected) return false;

  const derived = await scrypt(password, Buffer.from(salt, 'base64'), KEY_LENGTH);
  const expectedBuffer = Buffer.from(expected, 'base64');

  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a thrown error would read as a server fault.
  if (derived.length !== expectedBuffer.length) return false;

  return timingSafeEqual(derived, expectedBuffer);
}

/**
 * A temporary password an operator will read aloud and type once.
 *
 * The alphabet omits characters that are misread on paper or down a phone line
 * — no 0/O, no 1/l/I — because this password's whole life is being transcribed
 * exactly once.
 */
export function generateTemporaryPassword(length = 12): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

/**
 * The shortest password anybody may *choose*.
 *
 * Kept here with the hashing rather than beside one of the three callers,
 * because it was beside one of them: `changeOwnPassword` enforced eight
 * characters on somebody changing their own password, while an administrator
 * creating a user or resetting theirs could set a password of one character
 * and the server took it. The weaker path was the one that mints accounts.
 *
 * `validation.password.tooShort` names the number in both catalogues, so the
 * two move together.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Applies to a password somebody typed, never to `generateTemporaryPassword()`
 * — a generated secret is already longer than this and is not the caller's to
 * get wrong. Callers that fall back to a generated one therefore check the
 * supplied value first and only then fall back, rather than checking the
 * result, which would make the minimum look enforced while never seeing an
 * unsafe input at all.
 */
export function assertPasswordLongEnough(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError('validation.password.tooShort');
  }
}
