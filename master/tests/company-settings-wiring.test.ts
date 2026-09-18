/**
 * The orderings and placements that decide whether a switch works.
 *
 * Source-reading, in the `credential-invariants.test.ts` style, because each of
 * these is a *position* inside one function. The end-to-end halves live in
 * `company-settings.integration.test.ts`, which `describe.skipIf`s itself out
 * on a machine without PostgreSQL — where a skipped suite prints exactly like a
 * passing one. These always run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Comments stripped: a guard a doc comment can satisfy is not a guard. */
function code(relative: string): string {
  return readFileSync(path.join(SRC, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start);
}

describe('inventory.adjustmentNoteRequired', () => {
  const body = functionBody(code('services/inventory.service.ts'), 'export async function recordAdjustment');

  it('is checked BELOW the no-op return, not above it', () => {
    // Confirming a count that already matches writes no movement and no
    // activity row, so a reason collected there is discarded — a form that
    // takes something and throws it away. Above the return is the tempting
    // placement and it is the wrong one.
    const noop = body.indexOf('if (delta === 0)');
    const gate = body.indexOf("'inventory.adjustmentNoteRequired'");
    const written = body.indexOf('applyMovement');

    expect(noop).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(-1);
    // Strictly between the two: after the path that writes nothing has already
    // returned, and before anything is written.
    expect(gate).toBeGreaterThan(noop);
    expect(gate).toBeLessThan(written);
  });

  it('is checked before the movement is written', () => {
    const gate = body.indexOf("'inventory.adjustmentNoteRequired'");
    expect(body.indexOf('applyMovement')).toBeGreaterThan(gate);
  });

  it('decides blankness with the shared predicate, not a local truthiness test', () => {
    // Three hand-written `!note` tests — here and in each panel's form — is how
    // the server comes to refuse something a form let through.
    expect(body).toContain('isBlankNote(input.note)');
  });
});

describe('leads.packagingRequiredOnConvert', () => {
  const body = functionBody(code('services/order.service.ts'), 'export async function convertLead');

  it('is read before the transaction is opened', () => {
    // `getSetting` takes a pooled connection. Acquiring a second one while
    // holding `master_clock`'s lock is how a pool this size deadlocks (40P01),
    // which is what the lock-order comment inside that transaction is about.
    const read = body.indexOf("'leads.packagingRequiredOnConvert'");
    const transaction = body.indexOf('db().transaction');

    expect(read).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(read);
  });

  it('is passed into the pure guard rather than checked beside it', () => {
    const read = body.indexOf("'leads.packagingRequiredOnConvert'");
    expect(body.indexOf('assertConvertible(')).toBeLessThan(read);
  });

  it('leaves the rule required on the pure side, never defaulted', () => {
    // `readFileSync`, not grep: conversion.ts carries a literal NUL byte, and
    // grep answers "binary file matches" instead of showing the line — which is
    // how this rule was read as unenforced in the first place.
    const conversion = code('domain/conversion.ts');
    expect(conversion).toContain('packagingRequired: boolean');
    // A default is exactly what a forgotten argument looks like, and is how the
    // one call site would keep the old behaviour while the Settings screen
    // advertised a switch that decides nothing. The default goes on the
    // PARAMETER, not on the property — the first version of this assertion
    // watched `packagingRequired =` and sailed straight past
    // `rules: ConversionRules = { packagingRequired: true }`.
    expect(conversion).toMatch(/rules:\s*ConversionRules\s*[,)]/);
    expect(conversion).not.toMatch(/rules:\s*ConversionRules\s*=/);
    expect(conversion.indexOf('rules.packagingRequired')).toBeLessThan(
      conversion.indexOf("'validation.lead.packagingMissing'"),
    );
  });
});

describe('catalog.defaultUom', () => {
  it('defaults a create that named no unit, and never overrides one that did', () => {
    const body = functionBody(code('services/catalog.service.ts'), 'export async function createProduct');
    expect(body).toContain("getSetting(actor.tenantId, 'catalog.defaultUom')");
    expect(body).toContain('input.uom ?? unit');
  });

  it('is injected into the bulk import too, which does not go through createProduct', () => {
    // `insertProductRows` writes straight to the table, so without this a sheet
    // with no unit column falls through to the column's own DEFAULT 'box' and
    // the setting is a decorated dropdown.
    const body = functionBody(code('services/product-import.service.ts'), 'export async function importProducts');
    expect(body).toContain("'catalog.defaultUom'");
    expect(body.indexOf("'catalog.defaultUom'")).toBeLessThan(body.indexOf('if (options.dryRun)'));
  });

  it('injects it into creates only, so an upsert leaves a stored unit alone', () => {
    // The boundary between "the unit a NEW product starts in" and a company
    // setting silently re-uniting records somebody already shipped.
    const body = functionBody(code('services/product-import.service.ts'), 'export async function importProducts');
    const injection = body.slice(body.indexOf("'catalog.defaultUom'"), body.indexOf('const sample'));

    expect(injection).toContain('creates = creates.map');
    expect(injection).not.toContain('updates');
  });
});
