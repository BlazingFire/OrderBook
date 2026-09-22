/**
 * A settings write tells the panels, and does it in the right order.
 *
 * Source-reading, in the `credential-invariants.test.ts` style, because the
 * thing worth pinning is an *ordering* inside one function and the alternative
 * is a real socket, a real database and a real panel.
 *
 * `writeSetting` published nothing at all until 2026-09-18. That is the bug
 * this guards against returning: a company switch that reaches a panel once,
 * on its first snapshot, and never again.
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
  'settings.service.ts',
);

const source = readFileSync(SERVICE, 'utf8');

/**
 * Comments stripped before anything is asserted.
 *
 * Not fussiness: the first version of the payload assertion below passed
 * against `payload: parsed`, because the doc comment sitting above the call
 * writes out `payload: null` to explain why it is null. A guard a comment can
 * satisfy is not a guard.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const writeSetting = code.slice(code.indexOf('export async function writeSetting'));
const publishCall = /publishChange\(\{[^}]*\}\)/.exec(writeSetting)?.[0] ?? '';

describe('writeSetting', () => {
  it('publishes a change, so a connected panel hears about it', () => {
    expect(publishCall).not.toBe('');
    expect(publishCall).toContain("entity: 'setting'");
  });

  it('publishes AFTER dropping the cache, not before', () => {
    // The publish makes every panel ask for a fresh snapshot. Published first,
    // that snapshot races the invalidation and can be built from the per-tenant
    // map holding the value that was just replaced — so the panels would be
    // told to refresh and then handed the old answer.
    const invalidate = writeSetting.indexOf('invalidateSettingsCache');
    const publish = writeSetting.indexOf('publishChange');

    expect(invalidate).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(invalidate);
  });

  it('sends no payload, so a sealed value cannot ride the change ring', () => {
    // The refresh is decided from the entity alone, before anything reads the
    // payload. A secret setting's plaintext must never enter the ring, which
    // every panel's cursor can replay from.
    expect(publishCall).toMatch(/payload:\s*null/);
    expect(publishCall).not.toMatch(/payload:\s*(?!null)\w/);
  });

  it('publishes outside the transaction, so nothing is announced that rolled back', () => {
    const transaction = writeSetting.indexOf('db().transaction');
    const closing = writeSetting.indexOf('\n  });', transaction);
    const publish = writeSetting.indexOf('publishChange');

    expect(transaction).toBeGreaterThan(-1);
    expect(closing).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(closing);
  });
});
