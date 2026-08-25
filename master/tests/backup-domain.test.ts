/**
 * Pure validation rules for the storage export/import format
 * (docs/7-STORAGE-BACKUP-RESTORE.md §4.3, §7).
 */

import { describe, expect, it } from 'vitest';
import type { BackupManifest } from '@orderbook/shared';
import { BACKUP_FORMAT_VERSION } from '@orderbook/shared';

import { assertImportableFormatVersion, assertPassphraseStrong, summarizeManifest } from '../src/domain/backup.js';
import { BackupError, ValidationError } from '../src/lib/errors.js';

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    sourcePanelType: 'master',
    sourcePanelId: 'm1',
    scope: 'whole',
    scopeDetail: ['t1'],
    createdAt: '2026-08-25T00:00:00.000Z',
    appVersion: '0.1.0',
    contentHash: 'deadbeef',
    ...overrides,
  };
}

describe('assertImportableFormatVersion', () => {
  it('accepts the current format version', () => {
    expect(() => assertImportableFormatVersion(manifest())).not.toThrow();
  });

  it('accepts an older format version — the payload targets today’s schema regardless', () => {
    expect(() => assertImportableFormatVersion(manifest({ formatVersion: BACKUP_FORMAT_VERSION - 1 || 0 }))).not.toThrow();
  });

  it('refuses a newer format version by name, per §7', () => {
    const tooNew = manifest({ formatVersion: BACKUP_FORMAT_VERSION + 1, appVersion: '9.9.9' });
    expect(() => assertImportableFormatVersion(tooNew)).toThrow(BackupError);

    try {
      assertImportableFormatVersion(tooNew);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).reason).toBe('migration_too_new');
      expect((error as BackupError).statusCode).toBe(400);
    }
  });
});

describe('assertPassphraseStrong', () => {
  it('accepts a passphrase at the minimum length', () => {
    expect(() => assertPassphraseStrong('1234567890')).not.toThrow();
  });

  it('refuses anything shorter, as a validation error', () => {
    expect(() => assertPassphraseStrong('short')).toThrow(ValidationError);
  });
});

describe('summarizeManifest', () => {
  it('names the source panel type and scope for the restore confirmation screen', () => {
    const lines = summarizeManifest(manifest({ sourcePanelType: 'office', scope: 'selected', scopeDetail: ['a', 'b'] }));
    expect(lines[0]).toContain('Office Panel');
    expect(lines[1]).toContain('2 compan');
  });
});
