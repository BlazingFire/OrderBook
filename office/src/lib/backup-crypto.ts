/**
 * The storage export file's envelope (`docs/7-STORAGE-BACKUP-RESTORE.md` §4.2,
 * §4.3): an unencrypted manifest header, followed by an AES-256-GCM-encrypted
 * payload keyed by a passphrase-derived scrypt key — same primitive family as
 * `hashPassword`/`verifyPassword` in this file's sibling `password.ts`, not the
 * page-level primitive the live database uses, since an export is a portable
 * file, not a disk page.
 *
 * File layout, in order:
 *   [4 bytes: manifest length, uint32 LE] [manifest JSON, utf8]
 *   [16 bytes: KDF salt] [12 bytes: AES-GCM IV] [16 bytes: auth tag] [ciphertext]
 *
 * `manifest.contentHash` is the sha256 of everything from the KDF salt onward,
 * so a truncated or corrupted file is caught by a plain hash comparison before
 * a passphrase is ever tried against it (§4.2, §7 "Export file truncated").
 *
 * This module is deliberately duplicated, near-verbatim, from
 * `master/src/lib/backup-crypto.ts` rather than shared — `@orderbook/shared` is
 * consumed by the browser bundles too, and `node:crypto` cannot go there. Keep
 * the two in sync by hand; they implement the one export/import format both
 * panels read and write.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { BackupManifest } from '@orderbook/shared';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scrypt(passphrase, salt, KEY_LENGTH);
}

export async function encryptBackup(
  manifestWithoutHash: Omit<BackupManifest, 'contentHash'>,
  payload: Buffer,
  passphrase: string,
): Promise<Buffer> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const encryptedBlock = Buffer.concat([salt, iv, authTag, ciphertext]);
  const contentHash = createHash('sha256').update(encryptedBlock).digest('hex');

  const manifest: BackupManifest = { ...manifestWithoutHash, contentHash };
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(manifestJson.length, 0);

  return Buffer.concat([lengthPrefix, manifestJson, encryptedBlock]);
}

export interface ParsedBackupFile {
  manifest: BackupManifest;
  encryptedBlock: Buffer;
}

/** Reads only the unencrypted header — no passphrase needed (§4.2, §5.1 step 3). */
export function readManifest(file: Buffer): ParsedBackupFile {
  if (file.length < 4) throw new BackupFileError('corrupt_file');

  const manifestLength = file.readUInt32LE(0);
  const manifestStart = 4;
  const manifestEnd = manifestStart + manifestLength;
  if (manifestEnd > file.length) throw new BackupFileError('corrupt_file');

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(file.subarray(manifestStart, manifestEnd).toString('utf8')) as BackupManifest;
  } catch {
    throw new BackupFileError('corrupt_file');
  }

  const encryptedBlock = file.subarray(manifestEnd);
  if (encryptedBlock.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new BackupFileError('corrupt_file');
  }

  return { manifest, encryptedBlock };
}

export class BackupFileError extends Error {
  constructor(readonly reason: 'corrupt_file' | 'wrong_passphrase') {
    super(reason);
  }
}

/**
 * Verifies `contentHash` before touching the passphrase — a corrupt file is a
 * different failure than a wrong passphrase, and the caller needs to tell them
 * apart (§7).
 */
export function verifyContentHash({ manifest, encryptedBlock }: ParsedBackupFile): void {
  const actual = createHash('sha256').update(encryptedBlock).digest('hex');
  const expected = Buffer.from(manifest.contentHash, 'hex');
  const actualBuf = Buffer.from(actual, 'hex');

  if (expected.length !== actualBuf.length || !timingSafeEqual(expected, actualBuf)) {
    throw new BackupFileError('corrupt_file');
  }
}

export async function decryptBackup(parsed: ParsedBackupFile, passphrase: string): Promise<Buffer> {
  verifyContentHash(parsed);

  const { encryptedBlock } = parsed;
  const salt = encryptedBlock.subarray(0, SALT_LENGTH);
  const iv = encryptedBlock.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = encryptedBlock.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encryptedBlock.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // AES-GCM's auth tag check fails the same way for a wrong key as for
    // tampered ciphertext; `contentHash` already ruled out the latter above,
    // so anything reaching here is a wrong passphrase.
    throw new BackupFileError('wrong_passphrase');
  }
}
