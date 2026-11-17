/**
 * Reading the catalogue data file (`master/assets/catalogue/swisware-plus-2026.md`,
 * `config.catalogueFile`) — pure: a string in, a typed catalogue out
 * (`docs/catalogue/CATALOGUE_MODEL.md` §4).
 *
 * The file is Markdown because the owner and whoever transcribes the next
 * printed catalogue can read, review and diff it without the software; this is
 * what makes that file load-bearing rather than documentation. Three sections
 * are data and every other section is prose for people:
 *
 *   `## Brands`        a `| Brand |` table
 *   `## Colour range`  a `| Colour | Hex | Group |` table
 *   `## Products`      one `### CODE — Name` block per product: a `- Brand:`
 *                      line, an optional `- Catalogue pages:` line, and a
 *                      `| # | Sub product | Size | Colours | Print side |` table
 *
 * **Strict, and loud about where.** The loader can clear and rebuild the
 * catalogue from this, so a silently skipped row is a sub product that stops
 * existing. Anything the parser does not understand inside a data section is
 * an error naming the line — never a guess.
 *
 * A sub product's Colours cell is the list it is offered in, comma-separated
 * — empty for none, one name for its only colour, several for a choice at
 * the counter. The word `All` alone in the cell is the whole Colour range
 * above it, expanded here so every later reader sees the colours themselves.
 * Print side is `Default`, `Left` or `Right` (blank is Default): which half
 * of a printed note the sub product belongs on, Default keeping the original
 * numeric-name rule (`shared/src/domain/colour-rule.ts`).
 */

import { CATEGORY_CODE_PATTERN, normalizeColours, type PrintSideSetting } from '@orderbook/shared';

export interface CatalogueColour {
  name: string;
  /** `#RRGGBB`, as sampled from the printed swatch. */
  hex: string;
  /** `Standard` / `Rustic` — how the printed range groups them. */
  group: string;
}

export interface CatalogueSubProduct {
  /** The printed identifier (`102`, `1111`, `MAGENTA`); unique inside its product. */
  name: string;
  size: string | null;
  /** The colours it is offered in (`All` already expanded); empty for none. */
  colours: string[];
  /** Which half of a printed note it belongs on; `default` unless the file says a side. */
  printSide: PrintSideSetting;
}

export interface CatalogueProduct {
  /** Letters and digits, unique across the file (case-insensitively). */
  code: string;
  name: string;
  brand: string;
  /** Printed page numbers, for a person checking the transcription. */
  pages: number[];
  /** In catalogue order — the loader's `sort_order`. */
  subProducts: CatalogueSubProduct[];
}

export interface ParsedCatalogue {
  brands: string[];
  colours: CatalogueColour[];
  products: CatalogueProduct[];
}

/** An error that names the 1-based line it is about. */
export class CatalogueParseError extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(`line ${line}: ${detail}`);
    this.name = 'CatalogueParseError';
  }
}

/** The file's print-side words. A `Map`, not an object literal: `"constructor"` must not look like a side. */
const SIDE_WORDS: ReadonlyMap<string, PrintSideSetting> = new Map([
  ['default', 'default'],
  ['left', 'left'],
  ['right', 'right'],
]);

/** The one Colours word that means the file's whole Colour range. */
const ALL_COLOURS = 'all';

const BRANDS_HEADER = ['brand'];
const COLOURS_HEADER = ['colour', 'hex', 'group'];
const SUB_PRODUCTS_HEADER = ['#', 'sub product', 'size', 'colours', 'print side'];

interface Line {
  /** 1-based, as an editor shows it. */
  number: number;
  text: string;
}

export function parseCatalogueMarkdown(source: string): ParsedCatalogue {
  const lines: Line[] = source
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((text, index) => ({ number: index + 1, text: text.trim() }));

  const sections = splitByHeading(lines, '## ');
  const brandsSection = requireSection(sections, 'Brands', lines.length);
  const coloursSection = requireSection(sections, 'Colour range', lines.length);
  const productsSection = requireSection(sections, 'Products', lines.length);

  const brands = readTable(brandsSection, BRANDS_HEADER).map(([cells, line]) => {
    const name = cells[0] ?? '';
    if (!name) throw new CatalogueParseError(line, 'a brand needs a name');
    return { name, line };
  });
  assertUnique(brands, (brand) => brand.name, 'brand');
  if (brands.length === 0) {
    throw new CatalogueParseError(brandsSection.heading.number, 'no brands listed');
  }

  const colours = readTable(coloursSection, COLOURS_HEADER).map(([cells, line]) => {
    const [name = '', hex = '', group = ''] = cells;
    if (!name) throw new CatalogueParseError(line, 'a colour needs a name');
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      throw new CatalogueParseError(line, `colour "${name}" has hex "${hex}", expected #RRGGBB`);
    }
    if (!group) throw new CatalogueParseError(line, `colour "${name}" needs a group`);
    return { name, hex, group, line };
  });
  assertUnique(colours, (colour) => colour.name, 'colour');

  const brandByLower = new Map(brands.map((brand) => [brand.name.toLowerCase(), brand.name]));
  const productBlocks = splitByHeading(productsSection.body, '### ');
  if (productBlocks.length === 0) {
    throw new CatalogueParseError(
      productsSection.heading.number,
      'no "### CODE — Name" products listed',
    );
  }

  // A product heading anywhere else — under a new "## Brand B products", say —
  // renders like every other product to the person reviewing the file and
  // would simply never load.
  const productHeadings = new Set(productBlocks.map((block) => block.heading.number));
  const stray = lines.find(
    (line) => line.text.startsWith('### ') && !productHeadings.has(line.number),
  );
  if (stray) {
    throw new CatalogueParseError(stray.number, 'a "### " product heading outside "## Products"');
  }

  const products = productBlocks.map((block) => ({
    ...readProduct(block, brandByLower, colours.map((colour) => colour.name)),
    line: block.heading.number,
  }));
  assertUnique(products, (product) => product.code, 'product code');
  // The database allows one live category per (brand, name)
  // (`idx_categories_brand_name`); a repeat would fail halfway through a load
  // that may already have cleared the old catalogue.
  assertUnique(products, (product) => `${product.name} (${product.brand})`, 'product');

  return {
    brands: brands.map((brand) => brand.name),
    colours: colours.map(({ name, hex, group }) => ({ name, hex, group })),
    products: products.map(({ line: _line, ...product }) => product),
  };
}

interface Section {
  heading: Line;
  title: string;
  body: Line[];
}

/**
 * Cut a run of lines at every heading with this exact prefix. Lines before the
 * first heading belong to no section — the document title and its preamble.
 */
function splitByHeading(lines: Line[], prefix: '## ' | '### '): Section[] {
  const sections: Section[] = [];

  for (const line of lines) {
    if (line.text.startsWith(prefix)) {
      sections.push({ heading: line, title: line.text.slice(prefix.length).trim(), body: [] });
    } else {
      sections.at(-1)?.body.push(line);
    }
  }

  return sections;
}

function requireSection(sections: Section[], title: string, lastLine: number): Section {
  const matches = sections.filter((section) => section.title.toLowerCase() === title.toLowerCase());
  const [first, second] = matches;
  if (!first) throw new CatalogueParseError(lastLine, `missing the "## ${title}" section`);
  if (second) {
    throw new CatalogueParseError(second.heading.number, `a second "## ${title}" section`);
  }
  return first;
}

/**
 * The section's one table, as trimmed cells per data row with the row's line.
 *
 * The header is checked, not skipped: a column added, removed or reordered by
 * hand would otherwise shift every value one cell sideways and load, say,
 * sizes as colour rules — plausible-looking data that is wrong on every row.
 */
function readTable(section: Section, header: readonly string[]): Array<[string[], number]> {
  const tableLines = section.body.filter((line) => line.text.startsWith('|'));
  const [headerLine, separatorLine, ...rows] = tableLines;

  if (!headerLine) {
    throw new CatalogueParseError(section.heading.number, `"${section.title}" has no table`);
  }

  // A row typed without its leading pipe still renders inside the table in
  // most viewers, so skipping it would drop a value the reviewer can see.
  const unpiped = section.body.find(
    (line) => line.text.includes('|') && !line.text.startsWith('|'),
  );
  if (unpiped) throw new CatalogueParseError(unpiped.number, 'a table row must start with "|"');

  const found = cellsOf(headerLine.text).map((cell) => cell.toLowerCase());
  if (found.join('|') !== header.join('|')) {
    throw new CatalogueParseError(
      headerLine.number,
      `expected the columns | ${header.join(' | ')} |, found | ${found.join(' | ')} |`,
    );
  }

  if (!separatorLine || !/^\|(\s*:?-+:?\s*\|)+$/.test(separatorLine.text)) {
    throw new CatalogueParseError(
      headerLine.number + 1,
      'expected the |---| line under the table header',
    );
  }

  // Every table line must be contiguous: a stray blank line inside a table
  // would end it in any Markdown viewer, so rows after it would be invisible
  // to a person reviewing the file while still being loaded from it.
  for (let at = 1; at < tableLines.length; at += 1) {
    const previous = tableLines[at - 1] as Line;
    const current = tableLines[at] as Line;
    if (current.number !== previous.number + 1) {
      throw new CatalogueParseError(
        current.number,
        'table rows must follow one another without a gap',
      );
    }
  }

  return rows.map((row) => {
    const cells = cellsOf(row.text);
    if (cells.length !== header.length) {
      throw new CatalogueParseError(
        row.number,
        `expected ${header.length} cells, found ${cells.length}`,
      );
    }
    return [cells, row.number];
  });
}

/** `| a | b |` → `['a', 'b']`. No escaped pipes: nothing in a catalogue needs one. */
function cellsOf(text: string): string[] {
  const inner = text.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

function readProduct(
  block: Section,
  brandByLower: Map<string, string>,
  colourNames: readonly string[],
): CatalogueProduct {
  const heading = /^(\S+)\s+—\s+(.+)$/.exec(block.title);
  if (!heading) {
    throw new CatalogueParseError(
      block.heading.number,
      `expected "### CODE — Name", found "### ${block.title}"`,
    );
  }
  const code = heading[1] as string;
  const name = (heading[2] as string).trim();

  if (!CATEGORY_CODE_PATTERN.test(code)) {
    throw new CatalogueParseError(
      block.heading.number,
      `product code "${code}" must be letters and digits only`,
    );
  }

  let brand: string | null = null;
  let pages: number[] = [];

  for (const line of block.body) {
    if (!line.text || line.text.startsWith('|')) continue;
    const field = /^-\s*([^:]+):\s*(.*)$/.exec(line.text);
    const key = field?.[1]?.trim().toLowerCase();
    const value = field?.[2]?.trim() ?? '';

    if (key === 'brand') {
      if (brand) {
        throw new CatalogueParseError(line.number, `product ${code} has a second "- Brand:" line`);
      }
      const known = brandByLower.get(value.toLowerCase());
      if (!known) {
        throw new CatalogueParseError(
          line.number,
          `brand "${value}" is not in the "## Brands" table`,
        );
      }
      brand = known;
    } else if (key === 'catalogue pages') {
      pages = value.split(',').map((page) => {
        const trimmed = page.trim();
        if (!/^\d+$/.test(trimmed)) {
          throw new CatalogueParseError(line.number, `"${trimmed}" is not a page number`);
        }
        return Number(trimmed);
      });
    } else {
      // A `- Colours: All` under the heading reads to a person as applying
      // to every row; ignoring it would load every row as written.
      throw new CatalogueParseError(
        line.number,
        `expected a "- Brand:" or "- Catalogue pages:" line or a table row, found "${line.text}"`,
      );
    }
  }

  if (!brand) {
    throw new CatalogueParseError(block.heading.number, `product ${code} has no "- Brand:" line`);
  }

  const rows = readTable(block, SUB_PRODUCTS_HEADER).map(([cells, line]) => ({
    ...readSubProduct(cells, line, code, colourNames),
    line,
  }));
  if (rows.length === 0) {
    throw new CatalogueParseError(block.heading.number, `product ${code} has no sub products`);
  }
  assertUnique(rows, (row) => row.name, `sub product of ${code}`);

  return {
    code,
    name,
    brand,
    pages,
    subProducts: rows.map(({ line: _line, ...subProduct }) => subProduct),
  };
}

function readSubProduct(
  cells: string[],
  line: number,
  productCode: string,
  colourNames: readonly string[],
): CatalogueSubProduct {
  const [, name = '', size = '', coloursCell = '', sideWord = ''] = cells;

  if (!name) throw new CatalogueParseError(line, `a sub product of ${productCode} needs a name`);

  let colours: string[];
  if (!coloursCell) {
    colours = [];
  } else if (coloursCell.toLowerCase() === ALL_COLOURS) {
    colours = [...colourNames];
  } else {
    const parts = coloursCell.split(',').map((part) => part.trim());
    if (parts.some((part) => !part)) {
      throw new CatalogueParseError(line, `"${name}" has a blank colour in "${coloursCell}"`);
    }
    colours = normalizeColours(parts);
    if (colours.length !== parts.length) {
      throw new CatalogueParseError(line, `"${name}" names a colour twice in "${coloursCell}"`);
    }
  }

  const printSide = sideWord ? SIDE_WORDS.get(sideWord.toLowerCase()) : 'default';
  if (!printSide) {
    throw new CatalogueParseError(
      line,
      `"${name}" has print side "${sideWord}", expected Default, Left or Right`,
    );
  }

  return { name, size: size || null, colours, printSide };
}

/** Case-insensitive, because the database's unique indexes are. */
function assertUnique<T extends { line: number }>(
  items: T[],
  key: (item: T) => string,
  what: string,
): void {
  const seen = new Map<string, number>();
  for (const item of items) {
    const folded = key(item).toLowerCase();
    const first = seen.get(folded);
    if (first !== undefined) {
      throw new CatalogueParseError(
        item.line,
        `duplicate ${what} "${key(item)}" (first on line ${first})`,
      );
    }
    seen.set(folded, item.line);
  }
}
