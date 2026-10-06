/**
 * The catalogue data file's reader, against the real file and against small
 * broken ones.
 *
 * The real-file half pins the transcription the owner signed off on
 * (2026-09-28): the loader can clear and rebuild the catalogue from this, so a
 * sub product the parser quietly skipped would simply stop existing on the
 * shop PC. The counts and the handful of named rows are the ones the owner's
 * request called out by page.
 *
 * The broken-file half checks that each refusal names the line it is about —
 * the person fixing a 959-line file needs the line, not "invalid catalogue".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import { CatalogueParseError, parseCatalogueMarkdown } from '../src/domain/catalogue-markdown.js';

const CATALOGUE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'catalogue',
  'swisware-plus-2026.md',
);

describe('the SWISWARE+ 2026 catalogue file', () => {
  const catalogue = parseCatalogueMarkdown(readFileSync(CATALOGUE_FILE, 'utf8'));
  const product = (code: string) => catalogue.products.find((entry) => entry.code === code);

  it('is the file the Master is configured to load', () => {
    expect(path.resolve(config.catalogueFile)).toBe(CATALOGUE_FILE);
  });

  it('holds one brand, the 21-colour range, 41 products and 549 sub products', () => {
    expect(catalogue.brands).toEqual(['Swisware+']);
    expect(catalogue.colours).toHaveLength(21);
    expect(catalogue.products).toHaveLength(41);
    expect(catalogue.products.reduce((sum, entry) => sum + entry.subProducts.length, 0)).toBe(549);
  });

  it('reads the colour range with its hex and group', () => {
    expect(catalogue.colours[0]).toEqual({ name: 'White', hex: '#FEFEFE', group: 'Standard' });
    expect(catalogue.colours.filter((colour) => colour.group === 'Rustic')).toHaveLength(5);
  });

  it('keeps One Piece Toilet as one product: white models first, then the numbered designs', () => {
    const toilet = product('OPT');
    expect(toilet).toMatchObject({
      name: 'One Piece Toilet',
      brand: 'Swisware+',
      pages: [4, 6, 7],
    });
    expect(toilet?.subProducts).toHaveLength(56);
    expect(toilet?.subProducts[0]).toEqual({
      name: '102',
      size: '9", L-27, B-15, H-26',
      rule: 'fixed',
      colour: 'White',
    });
    expect(toilet?.subProducts.find((sub) => sub.name === '1111')).toEqual({
      name: '1111',
      size: null,
      rule: 'dedicated',
      colour: null,
    });
  });

  it('reads Orissa Pan as multicolour (selectable) — nine models, none with a colour', () => {
    const pan = product('OP');
    expect(pan?.subProducts).toHaveLength(9);
    expect(pan?.subProducts.every((sub) => sub.rule === 'selectable' && sub.colour === null)).toBe(
      true,
    );
  });

  it('keeps the plain Sofiya pedestals apart from the floral basins of the same colour', () => {
    const names = product('SFD')?.subProducts.map((sub) => sub.name);
    expect(names).toContain('BLACK');
    expect(names).toContain('BLACK PLAIN');
  });

  it('gives every product an alphanumeric code', () => {
    for (const entry of catalogue.products) expect(entry.code).toMatch(/^[A-Za-z0-9]+$/);
  });
});

/** A minimal valid file, for breaking one thing at a time. */
function file(products: string): string {
  return [
    '# Test catalogue',
    '',
    '## Brands',
    '',
    '| Brand |',
    '|---|',
    '| Acme |',
    '',
    '## Colour range',
    '',
    '| Colour | Hex | Group |',
    '|---|---|---|',
    '| White | #FFFFFF | Standard |',
    '',
    '## Products',
    '',
    products,
  ].join('\n');
}

const GOOD_PRODUCT = [
  '### OPT — One Piece Toilet',
  '',
  '- Brand: Acme',
  '- Catalogue pages: 4',
  '',
  '| # | Sub product | Size | Colour rule | Colour |',
  '|---|---|---|---|---|',
  '| 1 | 102 (9") | L-27 | fixed | White |',
  '| 2 | 1111 |  | dedicated |  |',
  '| 3 | 20" O.P |  | multicolour |  |',
].join('\n');

/** Line 17 is the first line of the products block in `file()`. */
const FIRST_PRODUCT_LINE = 17;

function refusal(source: string): CatalogueParseError {
  try {
    parseCatalogueMarkdown(source);
  } catch (error) {
    if (error instanceof CatalogueParseError) return error;
    throw error;
  }
  throw new Error('expected the catalogue to be refused');
}

describe('a catalogue file that is wrong', () => {
  it('accepts the minimal file these cases break, rule words in any case', () => {
    const parsed = parseCatalogueMarkdown(
      file(GOOD_PRODUCT.replace('| multicolour |', '| MultiColour |')),
    );
    expect(parsed.products[0]?.subProducts.map((sub) => sub.rule)).toEqual([
      'fixed',
      'dedicated',
      'selectable',
    ]);
  });

  it('refuses a duplicate product code, naming the second one', () => {
    const error = refusal(
      file(`${GOOD_PRODUCT}\n\n${GOOD_PRODUCT.replace('One Piece Toilet', 'Again')}`),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 11);
    expect(error.message).toMatch(/duplicate product code "OPT"/);
  });

  it('refuses a product code that is not letters and digits', () => {
    const error = refusal(file(GOOD_PRODUCT.replace('### OPT', '### OP-T')));
    expect(error.line).toBe(FIRST_PRODUCT_LINE);
    expect(error.message).toMatch(/letters and digits/);
  });

  it('refuses the same sub product twice inside one product, whatever the case', () => {
    const error = refusal(
      file(
        `${GOOD_PRODUCT}\n| 4 | syphonic |  | fixed | White |\n| 5 | SYPHONIC |  | fixed | White |`,
      ),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 11);
    expect(error.message).toMatch(/duplicate sub product of OPT "SYPHONIC"/);
  });

  it('refuses a fixed sub product with no colour', () => {
    const error = refusal(file(GOOD_PRODUCT.replace('| fixed | White |', '| fixed |  |')));
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 7);
    expect(error.message).toMatch(/fixed but names no colour/);
  });

  it('refuses a colour beside a dedicated or multicolour rule', () => {
    expect(
      refusal(file(GOOD_PRODUCT.replace('| dedicated |  |', '| dedicated | White |'))).line,
    ).toBe(FIRST_PRODUCT_LINE + 8);
    expect(
      refusal(file(GOOD_PRODUCT.replace('| multicolour |  |', '| multicolour | White |'))).line,
    ).toBe(FIRST_PRODUCT_LINE + 9);
  });

  it('refuses a colour rule it does not know', () => {
    const error = refusal(file(GOOD_PRODUCT.replace('| dedicated |', '| rainbow |')));
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 8);
    expect(error.message).toMatch(/expected fixed, dedicated, multicolour/);
  });

  it('refuses a brand the Brands table does not list', () => {
    const error = refusal(file(GOOD_PRODUCT.replace('- Brand: Acme', '- Brand: Nobody')));
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 2);
  });

  it('refuses a product with no brand line', () => {
    const error = refusal(file(GOOD_PRODUCT.replace('- Brand: Acme', '')));
    expect(error.line).toBe(FIRST_PRODUCT_LINE);
    expect(error.message).toMatch(/no "- Brand:" line/);
  });

  it('refuses a reordered table header instead of loading every cell one column over', () => {
    const error = refusal(
      file(
        GOOD_PRODUCT.replace(
          '| # | Sub product | Size | Colour rule | Colour |',
          '| # | Sub product | Colour rule | Size | Colour |',
        ),
      ),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 5);
  });

  it('refuses a row with a missing cell', () => {
    const error = refusal(
      file(GOOD_PRODUCT.replace('| 2 | 1111 |  | dedicated |  |', '| 2 | 1111 | dedicated |  |')),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 8);
    expect(error.message).toMatch(/expected 5 cells, found 4/);
  });

  it('refuses a bad hex in the colour range', () => {
    const error = refusal(file(GOOD_PRODUCT).replace('#FFFFFF', 'white'));
    expect(error.line).toBe(13);
  });

  it('refuses a file with no Colour range section', () => {
    const source = file(GOOD_PRODUCT).replace('## Colour range', '## Colours');
    expect(refusal(source).message).toMatch(/missing the "## Colour range" section/);
  });

  // The cases below each loaded *less* than the file shows before they were
  // refused — the silent kind of wrong this parser exists to rule out.

  it('refuses a product heading outside "## Products" rather than never loading it', () => {
    const second = GOOD_PRODUCT.replace('### OPT — One Piece Toilet', '### WB — Wash Basin');
    const error = refusal(file(`${GOOD_PRODUCT}\n\n## More products\n\n${second}`));
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 13);
    expect(error.message).toMatch(/outside "## Products"/);
  });

  it('refuses a line in a product block it does not understand', () => {
    const error = refusal(
      file(GOOD_PRODUCT.replace('- Catalogue pages: 4', '- Colour rule: multicolour')),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 3);
  });

  it('refuses a second brand line instead of letting the last one win', () => {
    const error = refusal(
      file(GOOD_PRODUCT.replace('- Brand: Acme', '- Brand: Acme\n- Brand: Acme')),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 3);
    expect(error.message).toMatch(/second "- Brand:" line/);
  });

  it('refuses a table row typed without its leading pipe', () => {
    expect(refusal(file(`${GOOD_PRODUCT}\n4 | 1113 |  | dedicated |  |`)).line).toBe(
      FIRST_PRODUCT_LINE + 10,
    );
    const brands = refusal(file(GOOD_PRODUCT).replace('| Acme |', '| Acme |\nZeta |'));
    expect(brands.line).toBe(8);
    expect(brands.message).toMatch(/must start with "\|"/);
  });

  it('refuses a blank line inside a table', () => {
    const error = refusal(file(GOOD_PRODUCT.replace('| 2 | 1111 |', '\n| 2 | 1111 |')));
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 9);
    expect(error.message).toMatch(/without a gap/);
  });

  it('refuses two products of one name under one brand, which the database would', () => {
    const error = refusal(
      file(`${GOOD_PRODUCT}\n\n${GOOD_PRODUCT.replace('### OPT', '### OPT2')}`),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 11);
    expect(error.message).toMatch(/duplicate product "One Piece Toilet \(Acme\)"/);
  });

  it('refuses a table whose |---| line is missing, rather than reading the first row as it', () => {
    const error = refusal(file(GOOD_PRODUCT.replace('|---|---|---|---|---|\n', '')));
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 6);
    expect(error.message).toMatch(/expected the \|---\| line/);
  });

  it('refuses a page number that is not one', () => {
    const error = refusal(
      file(GOOD_PRODUCT.replace('- Catalogue pages: 4', '- Catalogue pages: 4, six')),
    );
    expect(error.line).toBe(FIRST_PRODUCT_LINE + 3);
    expect(error.message).toMatch(/"six" is not a page number/);
  });

  it('refuses a product whose table has no rows, which would load as nothing to sell', () => {
    const headerOnly = GOOD_PRODUCT.split('\n').slice(0, 7).join('\n');
    const error = refusal(file(headerOnly));
    expect(error.line).toBe(FIRST_PRODUCT_LINE);
    expect(error.message).toMatch(/OPT has no sub products/);
  });
});
