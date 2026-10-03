/**
 * R14, widened (1.4 D3): nowhere in the product reads the main-product code (`OPT`) as
 * part of a product's name.
 *
 * `ui/tests/product-label.test.ts` holds the screens' `productLabel` helper. This reads
 * every source folder that can compose display text (the servers, the PDFs and exports,
 * the shared domain, both web apps) and refuses the shapes in which a category code was
 * joined into a label: an array joined with a separator, a template literal that puts it
 * beside the name, and a string concatenation. A code has its own column and its own
 * field; the one place the code is written is that column.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const DIRS = [
  'master/src',
  'master/web/src',
  'office/src',
  'office/web/src',
  'shared/src',
  'ui/src',
  'electron/lib',
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'migrations' ? [] : sources(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = DIRS.flatMap((dir) => sources(path.join(ROOT, dir)));

const CODE = String.raw`(?:[cC]ategoryCode|[cC]ategory\??\.code|\bc\.code)`;

/** [needle, why]. Each is a way a code gets joined into text a person reads as a name. */
const SHAPES: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\[[^\]]*${CODE}[^\]]*\]\s*\.filter\(Boolean\)\s*\.join\(`), 'array of parts joined with a separator'],
  [new RegExp(String.raw`\[[^\]]*${CODE}[^\]]*\]\s*\.join\(\s*['"\`]\s*[-·|]`), 'array joined with a dash, middot or bar'],
  [new RegExp(String.raw`\$\{[^}]*${CODE}[^}]*\}\s*[-·|]`), 'template literal: code, then a separator'],
  [new RegExp(String.raw`[-·|]\s*\$\{[^}]*${CODE}[^}]*\}`), 'template literal: a separator, then the code'],
  [new RegExp(`${CODE}\\s*\\+\\s*['"\`]\\s*[-·|]`), 'string concatenation with a separator'],
  [new RegExp(String.raw`productLabel\([^)]*${CODE}`), 'a code handed to productLabel'],
];

describe('no display text carries the main-product code (R14)', () => {
  it('finds the sources it is meant to read', () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.some((file) => file.endsWith(path.join('domain', 'product-share.ts')))).toBe(true);
  });

  it.each(SHAPES)('has no %s', (needle, why) => {
    const offenders = FILES.filter((file) => needle.test(readFileSync(file, 'utf8'))).map((file) =>
      path.relative(ROOT, file),
    );
    expect(offenders, why).toEqual([]);
  });

  it('would have caught the product share subtitle that printed "OPT - One Piece Toilet"', () => {
    const old = '[product.categoryCode, product.categoryName].filter(Boolean).join(\' - \'),';
    expect(SHAPES.some(([needle]) => needle.test(old))).toBe(true);
  });
});
