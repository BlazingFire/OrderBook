/**
 * The Office Panel's *local* password verifier (docs/ROLES_AND_USERS.md §4).
 *
 * This exists so a person can sign in with the Master switched off. It is
 * deliberately **not** a copy of the Master's stored hash: the Master strips
 * `password_hash` from everything it serves a panel, so a replica holds a
 * verifier "only where it was set locally".
 *
 * Here, "set locally" means the moment somebody successfully signed in *on this
 * panel* while the link was up. At that instant the panel is holding their
 * plaintext, which is the only moment it can mint a verifier of its own. It
 * derives one, stores it, and forgets the plaintext.
 *
 * The consequence is the security property worth having: this panel's disk says
 * nothing about anybody who has never signed in here, and nothing about the
 * Master's own hashes even for those who have.
 *
 * scrypt only — no bcrypt fallback, because no verifier here predates this file.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

// Same cost as the Master (master/src/lib/password.ts): tens of milliseconds on
// a shop-floor PC. Deriving a verifier happens once per online sign-in and
// checking one happens once per offline sign-in, so nobody waits on it.
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function mintVerifier(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH);

  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyAgainst(password: string, verifier: string | null): Promise<boolean> {
  // An unknown user still costs a derivation, so "never signed in here" and
  // "wrong password" take the same time to answer.
  if (!verifier) {
    await mintVerifier(password);
    return false;
  }

  // `scrypt$16384$8$1$<salt>$<hash>` is six parts, the first being the bare tag.
  // The Master had a defect here from reading five and taking the cost out of
  // the tag — the parse and the format have to be written together.
  const [tag, cost, r, p, salt, expected] = verifier.split('$');

  if (tag !== 'scrypt' || !Number.isFinite(Number(cost)) || !r || !p || !salt || !expected) {
    return false;
  }

  const derived = await scrypt(password, Buffer.from(salt, 'base64'), KEY_LENGTH);
  const expectedBuffer = Buffer.from(expected, 'base64');

  // Length first: timingSafeEqual throws on a mismatch rather than returning
  // false, and a thrown error would read as a server fault.
  if (derived.length !== expectedBuffer.length) return false;

  return timingSafeEqual(derived, expectedBuffer);
}
