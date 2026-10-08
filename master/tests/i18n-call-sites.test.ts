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

import { EN_MESSAGES, PANEL_SCOPED_KEYS } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/** `t('key'` / `t("key"` — a template literal deliberately does not match. */
const CALL = /\bt\(\s*(['"])([A-Za-z0-9_.]+)\1/g;

/**
 * `t(cond ? 'a' : 'b'` — both keys. `inventory.piecesOnHand` went missing
 * behind exactly this shape: `CALL` sees neither branch, so the Stock screen
 * showed the raw key and nothing failed.
 */
const TERNARY = /\bt\(\s*[\w.!?&|\s]+?\?\s*(['"])([A-Za-z0-9_.]+)\1\s*:\s*(['"])([A-Za-z0-9_.]+)\3/g;

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
    const keys = [
      ...[...text.matchAll(CALL)].map((match) => match[2]),
      ...[...text.matchAll(TERNARY)].flatMap((match) => [match[2], match[4]]),
    ];
    for (const key of keys) {
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
  ['ui', null],
])('%s message keys', (webDir, panel) => {
  it('are all present in the shared catalogue', () => {
    const missing: string[] = [];

    for (const [key, files] of keysUsedIn(webDir)) {
      // ui/ is shared between panels, so panel-scoped keys are checked under
      // both prefixes — the same key will appear in both panels' catalogues.
      const resolved = panel && PANEL_SCOPED_KEYS.includes(key) ? `${panel}.${key}` : key;
      if (!(resolved in catalogue)) missing.push(`${key} (${files[0]})`);
    }

    expect(missing).toEqual([]);
  });
});

describe('panel-scoped keys', () => {
  it('exist under both panel prefixes, so neither panel renders a raw key', () => {
    const absent = PANEL_SCOPED_KEYS.flatMap((key) =>
      ['master', 'office']
        .map((panel) => `${panel}.${key}`)
        .filter((scoped) => !(scoped in catalogue)),
    );

    expect(absent).toEqual([]);
  });

  it('are not also present unprefixed, which would silently shadow the split', () => {
    expect(PANEL_SCOPED_KEYS.filter((key) => key in catalogue)).toEqual([]);
  });
});

/*
 * The other direction, for the Roles & users strings: a key nothing names is what a rewritten
 * screen leaves behind (the person screen, Oct 8, left eight). Repo-wide this cannot hold —
 * `permission.*`, `module.*` and the activity tokens are looked up by built names — so it covers
 * only the namespaces that are always written out whole.
 */
describe('Roles & users message keys', () => {
  it('are each still named somewhere outside the catalogue', () => {
    const source = ['shared/src', 'ui/src', 'master/src', 'master/web/src', 'office/src', 'office/web/src']
      .flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      .filter((file) => !file.endsWith(path.join('i18n', 'en.ts')))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const unread = Object.keys(catalogue).filter(
      (key) =>
        /^(access|avatar)\./.test(key) && !source.includes(`'${key}'`) && !source.includes(`"${key}"`),
    );

    expect(unread).toEqual([]);
  });
});
