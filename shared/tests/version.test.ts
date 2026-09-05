/**
 * The version comparison the Updates screens judge machines with.
 *
 * Pure, so it runs everywhere and cannot skip. The cases that matter are the
 * ones a naive string comparison gets wrong: `1.10.0` is newer than `1.9.0`
 * even though `'1.10.0' < '1.9.0'` as text, and that is exactly the tenth
 * release where a wrong answer would first appear.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compareVersions, isNewer, parseVersion, standing } from '../src/domain/version.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('version comparison', () => {
  it('orders by number, not by text — 1.10.0 is newer than 1.9.0', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect('1.10.0' > '1.9.0').toBe(false); // the bug this exists to prevent
  });

  it('compares each part in turn', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('reads an unparseable version as 0.0.0 rather than throwing', () => {
    expect(parseVersion('not a version')).toEqual([0, 0, 0]);
    expect(parseVersion(null)).toEqual([0, 0, 0]);
    expect(parseVersion(undefined)).toEqual([0, 0, 0]);
    // `appVersion()` falls back to '0.0.0' when package.json is unreadable, so
    // an unreadable build sorts as very old — which is the safe direction.
    expect(isNewer('1.0.0', 'not a version')).toBe(true);
  });

  it('ignores anything after the patch number', () => {
    expect(compareVersions('1.2.3-beta.4', '1.2.3')).toBe(0);
  });

  it('says unknown when either side has no version, never "up to date"', () => {
    expect(standing(null, '1.0.0')).toBe('unknown');
    expect(standing('1.0.0', null)).toBe('unknown');
    expect(standing('1.0.0', '1.0.0')).toBe('same');
    expect(standing('0.9.0', '1.0.0')).toBe('behind');
    expect(standing('1.1.0', '1.0.0')).toBe('ahead');
  });
});

/**
 * All seven package.json files must agree on the version.
 *
 * A missed workspace would ship silently — the Updates screen compares
 * versions, and a mismatched workspace would read as "behind" or "ahead"
 * when it is actually the same release.
 */
const WORKSPACES = [
  'package.json',
  'shared/package.json',
  'ui/package.json',
  'master/package.json',
  'master/web/package.json',
  'office/package.json',
  'office/web/package.json',
];

describe('cross-workspace version agreement', () => {
  it('all package.json files report the same version', () => {
    const versions = WORKSPACES.map((rel) => {
      const full = path.join(REPO_ROOT, rel);
      const pkg = JSON.parse(readFileSync(full, 'utf8')) as { version?: string };
      return { workspace: rel, version: pkg.version ?? '0.0.0' };
    });

    const unique = [...new Set(versions.map((v) => v.version))];
    expect(unique).toHaveLength(1);
  });
});
