#!/usr/bin/env node
/**
 * Keeps `shared/src/i18n/hi.ts` a TOTAL `Record<MessageKey, string>` without
 * making mid-development builds unworkable.
 *
 * `hi.ts` is typed as a total record deliberately (`09-I18N.md` §3.1): adding
 * one English key must turn the Hindi build red until Hindi exists for it,
 * because that pressure is what stops an untranslated string shipping
 * silently. It is also genuinely obstructive mid-feature, so this script
 * appends every key missing from `hi.ts` with the English text and a
 * `// TODO(i18n-hi)` marker — the build goes green, and every untranslated
 * string is one `grep TODO(i18n-hi)` away.
 *
 * Deliberately dependency-free (reads and rewrites the file as text) so it
 * needs no build step of its own to run before `shared` has been built.
 *
 * Run as `npm run i18n:sync`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const enPath = path.join(repoRoot, 'shared/src/i18n/en.ts');
const hiPath = path.join(repoRoot, 'shared/src/i18n/hi.ts');

const KEY_LINE = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/;

function readKeys(text) {
  const keys = new Map();
  for (const line of text.split('\n')) {
    const match = KEY_LINE.exec(line);
    if (match) keys.set(match[1], match[2]);
  }
  return keys;
}

const enText = readFileSync(enPath, 'utf8');
const hiText = readFileSync(hiPath, 'utf8');

const enKeys = readKeys(enText);
const hiKeys = readKeys(hiText);

const missing = [...enKeys.keys()].filter((key) => !hiKeys.has(key));

if (missing.length === 0) {
  console.log('shared/src/i18n/hi.ts already covers every key in en.ts.');
  process.exit(0);
}

const closingBrace = hiText.lastIndexOf('};');
if (closingBrace === -1) {
  console.error('Could not find the closing "};" of HI_MESSAGES in hi.ts — aborting.');
  process.exit(1);
}

const additions = missing
  .map((key) => `  // TODO(i18n-hi)\n  '${key}': ${JSON.stringify(enKeys.get(key))},\n`)
  .join('');

const updated = `${hiText.slice(0, closingBrace)}${additions}${hiText.slice(closingBrace)}`;
writeFileSync(hiPath, updated, 'utf8');

console.log(`Appended ${missing.length} missing key(s) to shared/src/i18n/hi.ts:`);
for (const key of missing) console.log(`  - ${key}`);
console.log('Search for "TODO(i18n-hi)" to find every string still awaiting a real translation.');
