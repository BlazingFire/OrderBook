/**
 * Every place the Office's new-lead form refuses over packaging reads the switch.
 *
 * Source-reading, because driving this in jsdom means walking the whole
 * pick-then-detail flow, and what matters is reach rather than behaviour: the
 * screen refuses in more than one place, and missing one produces the worst
 * outcome available in this change — `leads.packagingRequiredOnConvert` switched
 * OFF on the Settings page while the shop still cannot enter a line, because
 * `rowReady` gates `addProduct()`.
 *
 * Driving it in jsdom would need a fixture larger than the thing under test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'office',
    'web',
    'src',
    'screens',
    'AddLeadScreen.tsx',
  ),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

/**
 * Every line that makes a *decision* from a line's packaging — a truth test,
 * not a use of the value.
 *
 * The distinction is the setting's own: it decides whether a conversion is
 * refused, never whether the field is recorded. `packaging: entry.packaging
 * .trim()` builds the payload and must stay unconditional; packaging somebody
 * entered is kept either way. The first version of this matched any `.trim()`
 * and flagged that line, which would have pushed the switch into the write
 * path.
 */
function packagingDecisions(): string[] {
  return source
    .split('\n')
    .filter((line) => /(!|Boolean\()\s*\w+\.packaging(\?)?\.trim\(\)/.test(line))
    .map((line) => line.trim());
}

describe('the packaging switch', () => {
  it('is read somewhere in the form at all', () => {
    expect(source).toContain('packagingRequired');
  });

  it('gates the row-ready check that decides whether a line can be added', () => {
    // The sharp one. `draftIsReady` gates adding the line, so a company with
    // the switch off would be unable to enter a lead at the counter.
    const ready = source.slice(source.indexOf('function draftIsReady'));
    const body = ready.slice(0, ready.indexOf('\n  }'));

    expect(body).toContain('packaging');
    expect(body).toContain('packagingRequired');
  });

  it('gates every packaging test in the file, leaving none unconditional', () => {
    // Written as "find them all, then check each" rather than naming the two
    // sites: a third refusal added later is caught without anybody editing
    // this test, which is the only way a reach guard stays true.
    const unguarded = packagingDecisions().filter((line) => !line.includes('packagingRequired'));
    expect(unguarded).toEqual([]);
  });

  it('finds the sites it claims to be checking', () => {
    // Without this the assertion above passes on an empty list — the failure
    // mode of every "none of them are wrong" test.
    expect(packagingDecisions().length).toBeGreaterThanOrEqual(2);
  });
});
