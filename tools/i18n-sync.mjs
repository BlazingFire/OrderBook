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

/**
 * Read a catalogue by evaluating its object literal.
 *
 * This was a per-line regex over `'key': 'value'`, which was wrong three ways
 * and quietly so: it missed every value wrapped onto a second line, it missed
 * every double-quoted value — including the ones this script writes itself, so
 * a second run re-appended keys it had already added and produced duplicates —
 * and it returned values still carrying their source escapes, so a `\'` became
 * a literal backslash in the Hindi stub.
 *
 * Still dependency-free and still needs no build step: the file is scanned for
 * the literal's extent and evaluated, rather than parsed by hand.
 */
function readKeys(text, opener) {
  const start = text.indexOf(opener);
  if (start < 0) throw new Error(`could not find ${opener}`);
  const from = text.indexOf('{', start);

  let depth = 0;
  let end = -1;
  let inString = null;
  let inComment = null;

  for (let i = from; i < text.length; i += 1) {
    const char = text[i];

    if (inComment === 'line') {
      if (char === '\n') inComment = null;
      continue;
    }
    if (inComment === 'block') {
      if (char === '*' && text[i + 1] === '/') {
        inComment = null;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === inString) inString = null;
      continue;
    }

    // Comments before quotes: an apostrophe in `// don't` would otherwise open
    // a string that swallows the rest of the file.
    if (char === '/' && text[i + 1] === '/') {
      inComment = 'line';
      i += 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      inComment = 'block';
      i += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') inString = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end < 0) throw new Error(`unbalanced object literal after ${opener}`);
  const literal = text.slice(from, end + 1);
  return new Map(Object.entries(new Function(`return (${literal});`)()));
}

const enText = readFileSync(enPath, 'utf8');
const hiText = readFileSync(hiPath, 'utf8');

const enKeys = readKeys(enText, 'EN_MESSAGES');
const hiKeys = readKeys(hiText, 'HI_MESSAGES');

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
