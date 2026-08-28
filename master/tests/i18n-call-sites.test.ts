/**
 * Every message key a screen asks for must exist in the catalogue.
 *
 * Both web apps used to carry their own hand-maintained dictionary, and
 * `t()` fell back to returning the key itself — so a typo, or a key that only
 * ever existed in the *other* panel's copy, rendered as `common.save` on
 * screen and nothing failed. That was live: five call sites were doing it when
 * the two dictionaries were folded into `shared/src/i18n/en.ts`.
 *
 * The panels' `t()` still takes a `string` rather than a `MessageKey`, because
 * tightening it is a separate change across ~1380 call sites. This test is the
 * same guarantee a day earlier: it reads the source, finds every literal key,
 * and fails if the catalogue does not have it.
 *
 * Source-reading rather than importing, in the style of
 * `migration-registry.test.ts` — the point is what is written in the files,
 * not what a module graph resolves to.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { EN_MESSAGES } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Keys whose sentence differs between panels. Each `strings.ts` prefixes
 * these with its own panel name before looking them up.
 */
const PANEL_SCOPED = [
  'app.panel',
  'backup.export.title',
  'backup.restore.confirmWipe',
  'settings.storage.title',
  'sync.conflictReview',
  'sync.offline',
  'sync.offlinePending',
  'sync.pendingChanges',
  'sync.popoverTitle.offline',
  'sync.popoverTitle.offlinePending',
  'sync.popoverTitle.synced',
];

/** `t('key'` / `t("key"` — a template literal deliberately does not match. */
const CALL = /\bt\(\s*(['"])([A-Za-z0-9_.]+)\1/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function keysUsedIn(webDir: string): Map<string, string[]> {
  const used = new Map<string, string[]>();

  for (const file of sourceFiles(path.join(ROOT, webDir, 'src'))) {
    // The dictionary shim itself names the scoped keys as data, not as calls.
    if (file.endsWith(path.join('i18n', 'strings.ts'))) continue;

    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CALL)) {
      const key = match[2];
      if (!key) continue;
      const at = path.relative(ROOT, file);
      const seen = used.get(key);
      if (seen) seen.push(at);
      else used.set(key, [at]);
    }
  }

  return used;
}

const catalogue = EN_MESSAGES as Record<string, string>;

describe.each([
  ['master/web', 'master'],
  ['office/web', 'office'],
])('%s message keys', (webDir, panel) => {
  it('are all present in the shared catalogue', () => {
    const missing: string[] = [];

    for (const [key, files] of keysUsedIn(webDir)) {
      const resolved = PANEL_SCOPED.includes(key) ? `${panel}.${key}` : key;
      if (!(resolved in catalogue)) missing.push(`${key} (${files[0]})`);
    }

    expect(missing).toEqual([]);
  });
});

describe('panel-scoped keys', () => {
  it('exist under both panel prefixes, so neither panel renders a raw key', () => {
    const absent = PANEL_SCOPED.flatMap((key) =>
      ['master', 'office']
        .map((panel) => `${panel}.${key}`)
        .filter((scoped) => !(scoped in catalogue)),
    );

    expect(absent).toEqual([]);
  });

  it('are not also present unprefixed, which would silently shadow the split', () => {
    expect(PANEL_SCOPED.filter((key) => key in catalogue)).toEqual([]);
  });
});
