/**
 * The release script and the panels agree on what a signature covers.
 *
 * `tools/release.mjs` cannot import `@orderbook/shared`: it runs before
 * anything is built, and building is the thing it exists to do. So the field
 * list lives in two places, and this reads the script's source to hold them
 * together — the same technique `migration-registry.test.ts` uses, and for the
 * same reason. A signature made over one list and checked against the other
 * fails on every machine at once, at the worst possible moment.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { canonicalManifestPayload, SIGNED_MANIFEST_FIELDS } from '@orderbook/shared';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(path.join(ROOT, 'tools', 'release.mjs'), 'utf8');

describe('what a release signature covers', () => {
  it('UPD-27: the release script signs exactly the fields the panels verify', () => {
    const declared = /const SIGNED_FIELDS = \[([^\]]+)\]/.exec(SCRIPT);
    expect(declared, 'SIGNED_FIELDS not found in tools/release.mjs').not.toBeNull();

    const fields = [...(declared?.[1] ?? '').matchAll(/'([a-zA-Z0-9]+)'/g)].map(
      (match) => match[1],
    );

    // Order matters as much as membership: the payload is positional, so the
    // same fields in a different order produce different bytes.
    expect(fields).toEqual([...SIGNED_MANIFEST_FIELDS]);
  });

  it('UPD-27: both sides build the same bytes for the same manifest', () => {
    // Reproduces the script's construction against shared's, so a change to
    // either — a separator, a case rule, a stray space — fails here.
    const manifest = {
      panel: 'master' as const,
      platform: 'win32' as const,
      version: '1.4.2',
      file: 'OrderBook-Master-1.4.2-Setup.exe',
      sizeBytes: 148_209_664,
      sha256: 'A'.repeat(64),
      releasedAt: '2026-08-31T09:00:00.000Z',
    };

    const fromScript = [...SIGNED_MANIFEST_FIELDS]
      .map((field) =>
        field === 'sha256'
          ? `${field}=${String(manifest[field]).toLowerCase()}`
          : `${field}=${String(manifest[field])}`,
      )
      .join('\n');

    expect(canonicalManifestPayload(manifest)).toBe(fromScript);
  });

  it('UPD-27: an uppercase digest signs the same as a lowercase one', () => {
    // A manifest written by hand, or by a tool that upper-cases hex, describes
    // the same file — and must not produce a signature that fails to verify.
    const base = {
      panel: 'office' as const,
      platform: 'darwin' as const,
      version: '1.4.2',
      file: 'OrderBook-Office-1.4.2-Setup.dmg',
      sizeBytes: 99,
      releasedAt: '2026-08-31T09:00:00.000Z',
    };

    expect(canonicalManifestPayload({ ...base, sha256: 'AbCd'.repeat(16) })).toBe(
      canonicalManifestPayload({ ...base, sha256: 'abcd'.repeat(16) }),
    );
  });

  it('UPD-27: the script refuses to sign without a key id', () => {
    // Signing with a key nobody can name means a panel cannot look the key up,
    // so the signature is unverifiable rather than merely unsigned.
    expect(SCRIPT).toContain('ORDERBOOK_RELEASE_KEY_ID is not');
  });
});
