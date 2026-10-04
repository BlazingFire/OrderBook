/**
 * What the two web apps show when something fails comes from the catalogue.
 *
 * A screen's error path has the thrown message to show when there is one and a
 * fallback when there is not — a network stack failure, an unstructured 500,
 * something that is not an `Error`. The fallbacks were English literals in
 * both panels ("Could not move the lead", "Export failed", "Request failed",
 * and the Office's kanban cards printed `via` in front of the source), so a
 * screen showed an English literal exactly when something had gone wrong. So did
 * the api clients' own timeout and cancel failures, which a Master boot that
 * timed out put on the splash as they were. The
 * lint rule for untranslated JSX cannot see any of them: they are string
 * arguments and ternary branches, not JSX text, and the one JSX case sits in a
 * file the rule is still switched off for.
 *
 * Source-reading, in the style of `i18n-call-sites.test.ts`. Each form below
 * is how a fallback is actually written in these files; a new one written the
 * same way is caught without anybody editing this test.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { EN_MESSAGES } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The file with its comments blanked, so prose quoting an old literal is not a finding. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

const FALLBACK_FORMS: Array<[form: string, pattern: RegExp]> = [
  // `caught instanceof Error ? caught.message : 'Could not load'`
  ['a ternary after .message', /instanceof\s+\w+\s*\?\s*[\w.]+\.message\s*:\s*'([^']+)'/g],
  // `detail?.message ?? 'Request failed'`
  ['a ?? after .message', /\.message\s*\?\?\s*'([^']+)'/g],
  // `run(() => …, 'Could not save the weight')` — the failure argument, which
  // prettier leaves either after the closing brace or on a line of its own.
  ['a failure argument', /(?:\}\s*,|^)\s*'([A-Z][^']*\s[^']*)'\s*,?\s*\)?\s*$/gm],
  // `<span>via {lead.sourcePlatform}</span>`
  ['JSX text before a value', />\s*(via)\s*\{/g],
  // `new ApiError('The panel did not answer in time', 'timeout')` — the api
  // clients' own failures, which the boot shows on the splash as they are.
  ['an ApiError built from a literal', /new\s+ApiError\(\s*'([^']+)'/g],
];

describe.each(['master/web/src', 'office/web/src'])('%s', (app) => {
  it('writes every error fallback as a catalogue key, not an English literal', () => {
    const literals: string[] = [];

    for (const file of sources(path.join(ROOT, app))) {
      const text = code(file);
      for (const [form, pattern] of FALLBACK_FORMS) {
        for (const match of text.matchAll(pattern)) {
          literals.push(`${path.relative(ROOT, file)}: ${form}: "${match[1]}"`);
        }
      }
    }

    expect(literals).toEqual([]);
  });
});

describe('the keys that keep their old "rates" names', () => {
  // Renaming a key is churn across both catalogues and every call site, so
  // these keep the names they had while party records carried prices. The
  // software carries no money at all; what they say must not suggest it does.
  it.each(['lead.add.party.ownRates', 'lead.detail.partyRates'] as const)(
    '%s names no money',
    (key) => {
      // English words for money, and the rupee sign.
      const money = /\b(rates?|prices?|priced|pricing|amount|cost)\b|₹/i;
      expect(EN_MESSAGES[key]).not.toMatch(money);
    },
  );
});
