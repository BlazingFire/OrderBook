/**
 * Sealing a secret that has to stay readable by this Master, and by nothing
 * else that leaves the building.
 *
 * Sibling to `lib/backup-crypto.ts`, and deliberately not a caller of it: a
 * backup is a portable file, so its key must be derived from a passphrase a
 * person carries; these values never leave this machine, so the key is a
 * resident file and there is no passphrase to derive from. Same primitive
 * (AES-256-GCM), same IV/tag/ciphertext layout, different key story.
 *
 * **What this honestly protects.** The Master boots unattended on a shop PC, so
 * the key sits on the same disk as the data it protects. Anyone with
 * Administrator on that PC can read `dataDir\secrets\vault.key` and
 * `dataDir\postgres\` together — this is obfuscation against copying, not
 * protection against possession. What the separation does buy, and all it buys:
 * a stolen `.obbackup` yields nothing (the key is excluded from every export),
 * a raw `pg_dump` or query-log read sees ciphertext, and the key never leaves
 * `master/`.
 *
 * **AAD, not a per-row derived key.** Every call passes an `aad` naming what the
 * value belongs to (`vault:<tenant>:<user>`, `setting:<tenant>:<key>`). GCM
 * authenticates it, so a ciphertext copied from one user's row onto another's
 * fails to open rather than revealing the first user's password under the
 * second's name.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from '../config/index.js';

export interface SealedValue {
  v: 1;
  /** base64 */
  iv: string;
  /** base64 */
  tag: string;
  /** base64 */
  ct: string;
}

export class SecretBoxError extends Error {
  constructor(readonly reason: 'no_key' | 'unreadable') {
    super(reason);
    this.name = 'SecretBoxError';
  }
}

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const KEY_VERSION = 1;

interface KeyFile {
  version: number;
  key: string;
  createdAt: string;
}

/** In-process cache. The file is read once; it never changes while we run. */
let cachedKey: Buffer | null = null;

function keyPath(): string {
  return path.join(config.dataDir, 'secrets', 'vault.key');
}

/**
 * Read the key, creating it if this installation has never had one.
 *
 * Called from the boot sequence purely so a permissions failure is loud on the
 * boot screen — it is a **pre-flight, not the only initialiser**. Sealing and
 * opening both call it too, because no integration suite runs `main()`: a
 * boot-only initialiser would make every vault test throw `no_key`.
 */
export function loadOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;

  const file = keyPath();

  if (!existsSync(file)) {
    const key = randomBytes(KEY_LENGTH);
    const contents: KeyFile = {
      version: KEY_VERSION,
      key: key.toString('base64'),
      createdAt: new Date().toISOString(),
    };

    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // 0600 is honoured on POSIX and is a no-op on Windows, where the
      // directory's inherited ACL is what actually restricts it. Written
      // anyway: the file is copied between machines by people, and a mode that
      // travels is better than one that does not exist.
      writeFileSync(file, JSON.stringify(contents), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      // `wx` loses a race to another process that created it first, which is
      // not a failure — fall through and read what they wrote.
      if (!existsSync(file)) throw new SecretBoxError('no_key');
      void error;
    }
  }

  let parsed: KeyFile;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyFile;
  } catch {
    throw new SecretBoxError('unreadable');
  }

  const key = Buffer.from(parsed.key ?? '', 'base64');
  if (key.length !== KEY_LENGTH) throw new SecretBoxError('unreadable');

  cachedKey = key;
  return key;
}

export function seal(plaintext: string, aad: string): SealedValue {
  const key = loadOrCreateKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Open a sealed value, or throw `SecretBoxError`.
 *
 * Throws rather than returning null on purpose: "could not decrypt" and "the
 * value was empty" are different facts, and a caller that conflates them shows
 * somebody a blank password instead of an error.
 */
export function open(sealed: SealedValue, aad: string): string {
  const key = loadOrCreateKey();

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A wrong key, a tampered ciphertext and a mismatched AAD all fail the
    // same way, and the caller must not be told which — the message it turns
    // into is echoed to a browser.
    throw new SecretBoxError('unreadable');
  }
}

/** Test seam: forget the cached key so a suite can point `dataDir` elsewhere. */
export function resetSecretBox(): void {
  cachedKey = null;
}

/** The key version stamped on rows sealed by this module. */
export const CURRENT_KEY_VERSION = KEY_VERSION;

export function isSealedValue(raw: unknown): raw is SealedValue {
  if (typeof raw !== 'object' || raw === null) return false;
  const value = raw as Partial<SealedValue>;
  return (
    value.v === 1 &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.ct === 'string'
  );
}
