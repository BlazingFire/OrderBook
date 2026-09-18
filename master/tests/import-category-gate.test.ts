/**
 * Source-reading invariant, in the `credential-invariants.test.ts` style: the
 * bulk import settles `catalog.importCreatesCategories` **above** its own
 * dry-run boundary.
 *
 * This is the whole defect the switch could introduce, and it is invisible to
 * an integration test that only runs one of the two passes. `importProducts`
 * returns early at `if (options.dryRun)` — a refusal added below that line
 * gives a preview that says "ok" and a commit that refuses the same row, which
 * is a worse product than not having the switch at all.
 *
 * Pure, so it always runs: the end-to-end half lives in
 * `company-settings.integration.test.ts` and `describe.skipIf`s itself out on a
 * machine with no PostgreSQL, where a skipped suite prints like a passing one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'services',
  'product-import.service.ts',
);

const source = readFileSync(SERVICE, 'utf8');
const importProducts = source.slice(source.indexOf('export async function importProducts'));

describe('the import settles the category switch before it can answer a dry run', () => {
  it('reads the setting inside importProducts', () => {
    expect(importProducts).toContain("'catalog.importCreatesCategories'");
  });

  it('reads it, and refuses on it, above the dry-run return', () => {
    const boundary = importProducts.indexOf('if (options.dryRun)');
    const read = importProducts.indexOf("'catalog.importCreatesCategories'");
    const refusal = importProducts.indexOf('validation.import.unknownCategory');

    expect(boundary).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(-1);
    expect(read).toBeLessThan(boundary);
    expect(refusal).toBeLessThan(boundary);
  });

  it('never reaches the category-creating repository call while the switch is off', () => {
    // `ensureCategories` inserts every name it does not recognise
    // (`product.repository.ts`). Guarding the call site rather than trusting
    // the row filter above it is what makes "may not invent" structural.
    const call = importProducts.indexOf('productRepo.ensureCategories');
    expect(call).toBeGreaterThan(-1);
    expect(importProducts.slice(call - 200, call)).toContain('mayCreateCategories');
  });
});
