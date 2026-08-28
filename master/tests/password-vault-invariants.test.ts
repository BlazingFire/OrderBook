/**
 * The password vault's containment, stated as things a `grep` proves.
 *
 * Written in `credential-invariants.test.ts`'s style and for the same reason:
 * the guarantees that make a recoverable-password feature shippable are all
 * "this string appears in exactly these files", and a guarantee of that shape
 * needs something mechanical checking it. Every one of these has a matching
 * sentence in `docs/overhaul/workstream-F.md` §1.6 — if you are changing one,
 * change that too, and be sure you can defend the change out loud.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MASTER_SRC = path.join(REPO, 'master', 'src');

function read(absolute: string): string {
  return readFileSync(absolute, 'utf8');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Files under a root whose text contains `needle`, as repo-relative paths. */
function filesContaining(root: string, needle: string): string[] {
  return walk(root)
    .filter((file) => read(file).includes(needle))
    .map((file) => path.relative(REPO, file).split(path.sep).join('/'))
    .sort();
}

describe('the sealed value never leaves its module', () => {
  it('is opened in exactly one place outside lib/', () => {
    // `open(` is deliberately a generic name, so the search is for the import
    // rather than the call: any module that can name the function can read a
    // password back, and there must be exactly one that can.
    const importers = filesContaining(MASTER_SRC, "from '../lib/secret-box.js'").filter(
      (file) => !file.startsWith('master/src/lib/'),
    );

    expect(importers).toEqual([
      // Type-only: the row shape. It cannot call anything.
      'master/src/repositories/password-vault.repository.ts',
      'master/src/services/password-vault.service.ts',
      'master/src/services/settings.service.ts',
    ]);

    const repository = read(path.join(MASTER_SRC, 'repositories', 'password-vault.repository.ts'));
    expect(repository).toContain("import type { SealedValue } from '../lib/secret-box.js'");

    // …and of those three, only the vault service actually decrypts a
    // password; the settings service opens its own sealed values, never a row
    // from the vault.
    const vault = read(path.join(MASTER_SRC, 'services', 'password-vault.service.ts'));
    const opens = vault
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .filter((line) => /(?<![\w.])open\(/.test(line));
    expect(opens).toHaveLength(1);
  });
});

describe('the table is named in exactly three files', () => {
  it('the migration that creates it, its repository, and the backup exclusion', () => {
    expect(filesContaining(MASTER_SRC, 'user_password_vault')).toEqual([
      'master/src/db/migrations/20260314000000_settings_and_password_vault.ts',
      'master/src/repositories/backup.repository.ts',
      'master/src/repositories/password-vault.repository.ts',
    ]);
  });
});

describe('nothing about the vault exists on the Office side', () => {
  it.each(['user_password_vault', 'revealPassword', 'reveal-password', 'secret-box'])(
    '"%s" appears nowhere in office/src or office/web/src',
    (needle) => {
      const hits = [
        ...filesContaining(path.join(REPO, 'office', 'src'), needle),
        ...filesContaining(path.join(REPO, 'office', 'web', 'src'), needle),
      ];
      expect(hits).toEqual([]);
    },
  );
});

describe('no password ever becomes a property of a shared entity', () => {
  it('entities.ts declares no password field', () => {
    const entities = read(path.join(REPO, 'shared', 'src', 'domain', 'entities.ts'));
    expect(entities).not.toMatch(/^\s*password\??:/m);
  });
});

describe('a backup carries neither the ciphertext nor a live row after restore', () => {
  it('the export excludes the table and the restore clears it', () => {
    const backupRepo = read(path.join(MASTER_SRC, 'repositories', 'backup.repository.ts'));
    expect(backupRepo).toContain('EXCLUDED_TABLES');
    expect(backupRepo).toContain("'user_password_vault'");

    const restore = read(path.join(MASTER_SRC, 'services', 'backup-restore.service.ts'));
    expect(restore).toContain('clearVault(trx, tenantIds)');
    expect(restore).toContain('invalidateSettingsCache()');
  });
});

describe('the audit trail records the act, never the secret', () => {
  it('no details object in the vault service carries a password or a plaintext', () => {
    const vault = read(path.join(MASTER_SRC, 'services', 'password-vault.service.ts'));

    // The `details:` lines specifically. The window around a `recordActivity`
    // call legitimately contains the word "password" — the action itself is
    // `password_revealed` — so a whole-window search would only be able to
    // pass by accident.
    const detailLines = vault.split('\n').filter((line) => /^\s*details:/.test(line));
    expect(detailLines.length).toBeGreaterThan(0);
    for (const line of detailLines) {
      expect(line.toLowerCase()).not.toContain('password');
      expect(line.toLowerCase()).not.toContain('plaintext');
      expect(line.toLowerCase()).not.toContain('sealed');
    }
  });
});

describe('the reveal route cannot end up in a log or a cache', () => {
  it('is a POST and sets no-store', () => {
    const routes = read(path.join(MASTER_SRC, 'http', 'routes', 'access.routes.ts'));

    const block = routes
      .split(/(?=accessRoutes\.)/)
      .find((section) => section.includes("'/users/:id/reveal-password'"));

    expect(block).toBeDefined();
    expect(block).toMatch(/^accessRoutes\.post\(/);
    expect(block).toContain("res.set('Cache-Control', 'no-store')");
    expect(block).toContain("needs('users.viewPassword')");
  });
});
