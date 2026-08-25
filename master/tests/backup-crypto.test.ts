/**
 * The storage export/import envelope (docs/7-STORAGE-BACKUP-RESTORE.md §4,
 * §7): a plaintext manifest header, an AES-256-GCM-encrypted payload keyed by
 * a passphrase-derived scrypt key, and a `contentHash` that must be checked
 * before decryption is even attempted.
 */

import { describe, expect, it } from 'vitest';
import type { BackupManifest } from '@orderbook/shared';
import { BACKUP_FORMAT_VERSION } from '@orderbook/shared';

import {
  BackupFileError,
  decryptBackup,
  encryptBackup,
  readManifest,
  verifyContentHash,
} from '../src/lib/backup-crypto.js';

function baseManifest(): Omit<BackupManifest, 'contentHash'> {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    sourcePanelType: 'master',
    sourcePanelId: 'test-master-id',
    scope: 'whole',
    scopeDetail: ['tenant-1'],
    createdAt: '2026-08-25T00:00:00.000Z',
    appVersion: '0.1.0',
  };
}

describe('backup export/import envelope', () => {
  it('round-trips the payload through encrypt then decrypt', async () => {
    const payload = Buffer.from(JSON.stringify({ tables: { tenants: [{ id: 't1' }] } }), 'utf8');
    const file = await encryptBackup(baseManifest(), payload, 'a-strong-passphrase');

    const parsed = readManifest(file);
    expect(parsed.manifest.sourcePanelId).toBe('test-master-id');
    expect(parsed.manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);

    const decrypted = await decryptBackup(parsed, 'a-strong-passphrase');
    expect(decrypted.toString('utf8')).toBe(payload.toString('utf8'));
  });

  it('reads the manifest without needing the passphrase at all', async () => {
    const payload = Buffer.from('irrelevant', 'utf8');
    const file = await encryptBackup(baseManifest(), payload, 'a-strong-passphrase');

    // No passphrase is passed here — the manifest header is plaintext by design.
    const { manifest } = readManifest(file);
    expect(manifest.scope).toBe('whole');
    expect(manifest.scopeDetail).toEqual(['tenant-1']);
  });

  it('rejects the wrong passphrase distinctly from a corrupt file', async () => {
    const payload = Buffer.from('secret data', 'utf8');
    const file = await encryptBackup(baseManifest(), payload, 'correct-passphrase');
    const parsed = readManifest(file);

    await expect(decryptBackup(parsed, 'wrong-passphrase-here')).rejects.toSatisfy(
      (error) => error instanceof BackupFileError && error.reason === 'wrong_passphrase',
    );
  });

  it('catches a truncated file via contentHash before decryption is attempted', async () => {
    const payload = Buffer.from('secret data', 'utf8');
    const file = await encryptBackup(baseManifest(), payload, 'a-strong-passphrase');
    const truncated = file.subarray(0, file.length - 10);

    const parsed = readManifest(truncated);
    expect(() => verifyContentHash(parsed)).toThrow(BackupFileError);

    await expect(decryptBackup(parsed, 'a-strong-passphrase')).rejects.toSatisfy(
      (error) => error instanceof BackupFileError && error.reason === 'corrupt_file',
    );
  });

  it('catches a bit-flipped ciphertext the same way, not as a silent wrong answer', async () => {
    const payload = Buffer.from('secret data', 'utf8');
    const file = await encryptBackup(baseManifest(), payload, 'a-strong-passphrase');

    // Flip one byte well inside the ciphertext region (past the 4-byte length
    // prefix, the manifest JSON, the salt, the IV and the auth tag).
    const tampered = Buffer.from(file);
    const flipIndex = tampered.length - 1;
    tampered[flipIndex] = (tampered[flipIndex] ?? 0) ^ 0xff;

    const parsed = readManifest(tampered);
    expect(() => verifyContentHash(parsed)).toThrow(BackupFileError);
  });

  it('rejects a file too short to even hold a manifest', () => {
    expect(() => readManifest(Buffer.from([1, 2]))).toThrow(BackupFileError);
  });
});
