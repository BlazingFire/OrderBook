/**
 * Every switch the interface promises is actually populated.
 *
 * `CompanyFeatures` is the one channel by which a company switch reaches a
 * screen or an offline panel. Every field on it is optional
 * — it has to be, because a shop mid-update runs a Master and a panel on
 * different versions and a field the sender does not know about arrives as
 * `undefined` (`shared/tests/wire-optionality.test.ts` enforces that).
 *
 * Which means a field added to the interface and forgotten in the resolver
 * **typechecks cleanly**, ships, and reaches every reader as `undefined` — read
 * as "as before" — for ever. No screen breaks, no test goes red, and the
 * setting is a dropdown on a Settings page that decides nothing.
 *
 * This is the only thing in the tree that catches it. Source-reading, because
 * the alternative is to enumerate the fields by hand here and have a second
 * list to keep in step.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ENTITIES = readFileSync(
  path.resolve(HERE, '..', '..', 'shared', 'src', 'domain', 'entities.ts'),
  'utf8',
);
const RESOLVER = readFileSync(
  path.resolve(HERE, '..', 'src', 'services', 'company-features.ts'),
  'utf8',
);

/** The property names `CompanyFeatures` declares, comments stripped first. */
function declaredFields(): string[] {
  const start = ENTITIES.search(/export interface CompanyFeatures\s*\{/);
  if (start === -1) throw new Error('CompanyFeatures not found in entities.ts');
  const body = ENTITIES.slice(start, ENTITIES.indexOf('\n}', start));

  return [
    ...body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .matchAll(/^\s*(\w+)\??\s*:/gm),
  ]
    .map((match) => match[1] as string)
    .filter((name) => name !== 'CompanyFeatures');
}

describe('companyFeatures', () => {
  const fields = declaredFields();

  it('reads a setting for every field the interface declares', () => {
    expect(fields.length).toBeGreaterThan(1);

    const missing = fields.filter((field) => !new RegExp(`\\b${field}\\b`).test(RESOLVER));
    expect(missing).toEqual([]);
  });

  it('returns each of them, not merely resolves it', () => {
    // A field read into a const and left out of the returned object is the
    // same defect wearing a disguise, and it typechecks too.
    const returned = RESOLVER.slice(RESOLVER.lastIndexOf('return {'));
    const missing = fields.filter((field) => !new RegExp(`\\b${field}\\b`).test(returned));
    expect(missing).toEqual([]);
  });
});
