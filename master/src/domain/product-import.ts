/**
 * Reading a spreadsheet as products with variants — pure, so the same
 * functions answer "what would this file do" and "do it", and a unit test can
 * drive them with a two-dimensional array.
 *
 * **One row is one variant.** A sheet says which category and model a row
 * belongs to (`categoryName`, `name`), which colour or pattern it is
 * (`variant` — blank for a product that comes in one form), its `code` and,
 * when known, its `weightKg`. Rows with the same category and model are one
 * product with several variants; a model that never names a variant is a
 * product with one code. `groupImportRows` does that folding.
 *
 * **Headers are the wire field keys** (`code`, `name`, `size`, …), which is
 * what the blank template writes and what round-trips exactly. A person who
 * types their own header row gets a lot of latitude anyway: matching ignores
 * case, spaces and punctuation, and knows the labels the Add Product form uses
 * plus the usual trade shorthand (`SKU`, `Model`, `Colour`, `Weight`).
 * Whatever they wrote is what an issue echoes back as `column`.
 *
 * Validates only what a row asserts: a blank cell leaves the key absent, so a
 * four-column file of categories, models, codes and names imports without
 * inventing nulls for the other fields.
 *
 * **Catalogue v2** (`docs/catalogue/CATALOGUE_MODEL.md` §1, §5) names the
 * category a *product* and the model a *sub product*, and gives the category a
 * code and a brand. A row may name its product by `categoryCode` (`OPT`)
 * instead of by name — the code never creates a product, so a typo is refused
 * rather than turned into a new one — and `categoryBrand` makes the name the
 * (brand, name) pair, because two brands may both sell a One Piece Toilet.
 * The owner's words are header aliases (`Sub product`, `Main product`,
 * `Main product code`, `Brand`).
 */

import type { MessageParams, ProductImportIssue, ProductInput, ProductVariantInput } from '@orderbook/shared';
import { ProductValidationError, validateProductInput } from '@orderbook/shared';

/** Product-level fields a sheet may carry. */
export type ProductField = Exclude<keyof ProductInput, 'categoryId' | 'customFields' | 'variants' | 'hasVariants'>;

/** The three columns that describe the row's variant rather than its model. */
export type VariantField = 'variant' | 'code' | 'weightKg' | 'colourRule';

export type ImportField = ProductField | VariantField;

type ImportKind = 'text' | 'number' | 'boolean';

export interface ImportColumn {
  field: ImportField;
  /** The header the template writes — the owner's catalogue words; the field key is still read. */
  label: string;
  kind: ImportKind;
  required?: true;
  /** Read from an older sheet but left out of the template: `colourRule` replaced it. */
  legacy?: true;
  min?: number;
  /** `true` when `min` is a floor the value must clear, not merely reach. */
  exclusiveMin?: true;
  /** One line for the template's Guide sheet. */
  note: string;
}

/**
 * Template order. The first five are the shape of the catalogue itself; the
 * product's code and brand follow, because an older sheet without them still
 * reads the same.
 *
 * `categoryName` is required unless the row names its product by
 * `categoryCode` instead — the one pair where either will do (`matchHeaders`).
 */
export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { field: 'categoryBrand', label: 'Brand', kind: 'text', note: 'The brand the product is sold under — e.g. Swisware+. Read with Main product, since two brands may share a product name.' },
  { field: 'categoryCode', label: 'Main product code', kind: 'text', note: 'The main product by its code — e.g. OPT. It must exist already; filled, it is used instead of Main product.' },
  { field: 'categoryName', label: 'Main product', kind: 'text', required: true, note: 'Required unless Main product code is filled. The main product — e.g. ONE PIECE TOILET. Created if it does not exist yet.' },
  { field: 'name', label: 'Sub product', kind: 'text', required: true, note: 'Required. The sub product as printed — e.g. 102, DAMRU. Rows sharing a main product and sub product are one sub product.' },
  { field: 'size', label: 'Size', kind: 'text', note: 'e.g. 18x12, L-27 B-15 H-26' },
  { field: 'colourRule', label: 'Colour rule', kind: 'text', note: 'fixed = made in the one colour named in Colour; dedicated = the design is its own colour, none shown; multicolour = any colour of the colour range, picked on the lead. Blank reads the Colour column the old way.' },
  { field: 'variant', label: 'Colour', kind: 'text', note: 'The colour of a fixed sub product — e.g. White, Magenta. Leave blank for dedicated and multicolour.' },
  { field: 'code', label: 'Code', kind: 'text', required: true, note: 'Required. The sub product software code — e.g. OPT-0001. Unique across the whole catalogue.' },
  { field: 'weightKg', label: 'Weight (kg)', kind: 'number', min: 0, exclusiveMin: true, note: 'Weight of one piece in kilograms. Blank until known.' },
  { field: 'alias', label: 'Alias', kind: 'text', note: 'A short name staff use at the counter.' },
  { field: 'multiColour', label: 'Multicolour', kind: 'boolean', legacy: true, note: 'yes when the model is made in every colour of the colour list. Superseded by Colour rule.' },
];

/** The template's header row, in order. */
export const IMPORT_HEADERS: readonly string[] = IMPORT_COLUMNS.filter((column) => !column.legacy).map(
  (column) => column.label,
);

const COLUMN_BY_FIELD = new Map(IMPORT_COLUMNS.map((column) => [column.field, column]));

const VARIANT_FIELDS = new Set<ImportField>(['variant', 'code', 'weightKg', 'colourRule']);

/** Lower-case letters and digits only: "Weight (kg)" and "weight_kg" are the same header. */
export function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Everything a header cell may say for each field: the field key itself, the
 * form's own labels, and the trade shorthand. Keyed by `normalizeHeader` form.
 */
const HEADER_ALIASES: Record<string, ImportField> = Object.fromEntries(
  (
    [
      // `Main product` and `Sub product` are the owner's catalogue words;
      // `product` stays the model, as every sheet before catalogue v2 meant it.
      ['categoryName', ['category', 'mainproduct', 'mainproductname']],
      ['categoryCode', ['maincode', 'mainproductcode']],
      ['categoryBrand', ['brand', 'brandname', 'make']],
      [
        'name',
        ['productname', 'product', 'model', 'modelname', 'item', 'itemname', 'subproduct', 'subproductname'],
      ],
      ['variant', ['colour', 'color', 'variantname', 'colourvariant', 'shade', 'pattern', 'label']],
      ['code', ['productcode', 'variantcode', 'sku', 'itemcode', 'articlecode', 'article']],
      ['weightKg', ['weight', 'weightkgs', 'kg', 'kgs']],
      ['alias', ['shortname', 'nickname']],
      ['size', ['dimensions']],
      ['multiColour', ['multicolor', 'allcolours', 'allcolors', 'anycolour', 'anycolor']],
      ['colourRule', ['colorrule', 'rule']],
    ] as Array<[ImportField, string[]]>
  ).flatMap(([field, aliases]) =>
    [field, COLUMN_BY_FIELD.get(field)?.label ?? field, ...aliases].map((alias): [string, ImportField] => [normalizeHeader(alias), field]),
  ),
);

/** What the Colour rule column accepts, by `normalizeHeader` form; `selectable` is the stored name. */
const COLOUR_RULES: Record<string, 'fixed' | 'dedicated' | 'multicolour'> = {
  fixed: 'fixed',
  dedicated: 'dedicated',
  multicolour: 'multicolour',
  multicolor: 'multicolour',
  selectable: 'multicolour',
};

/** What a boolean column accepts: sheets say "yes", "Y", "true", "1", "no", "N", "false", "0". */
const BOOLEAN_WORDS: Record<string, boolean> = {
  yes: true,
  y: true,
  true: true,
  '1': true,
  no: false,
  n: false,
  false: false,
  '0': false,
};

export interface HeaderMatch {
  /** The column each header cell maps to, or null for one nothing knows. */
  byIndex: Array<ImportColumn | null>;
  /** Header cells that matched nothing, or matched a field already claimed. */
  ignored: string[];
  /** Required fields no header cell supplies. */
  missing: ImportField[];
}

export function matchHeaders(headerRow: readonly string[]): HeaderMatch {
  const byIndex: Array<ImportColumn | null> = [];
  const ignored: string[] = [];
  const claimed = new Set<ImportField>();

  for (const cell of headerRow) {
    const text = (cell ?? '').trim();
    const field = HEADER_ALIASES[normalizeHeader(text)];
    const column = field ? COLUMN_BY_FIELD.get(field) : undefined;

    if (!column || claimed.has(column.field)) {
      byIndex.push(null);
      if (text) ignored.push(text);
      continue;
    }

    claimed.add(column.field);
    byIndex.push(column);
  }

  // A product named by its code needs no name column.
  const supplied = (field: ImportField): boolean =>
    claimed.has(field) || (field === 'categoryName' && claimed.has('categoryCode'));
  const missing = IMPORT_COLUMNS.filter((column) => column.required && !supplied(column.field)).map(
    (column) => column.field,
  );

  return { byIndex, ignored, missing };
}

/** One sheet row, understood: the model's fields and the row's own variant. */
export interface ImportRow {
  /** Product-level fields; `categoryName` and `name` are always present. */
  product: ProductInput;
  variant: ProductVariantInput;
  /** The live sub product the row's code is on, set only to keep twins apart (`separateTwins`). */
  owner?: string;
}

export interface ParsedRow {
  /** Spreadsheet row number: the header is row 1. */
  row: number;
  input: ImportRow;
}

/** A row is blank when every cell is — those are skipped without a word. */
export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((cell) => (cell ?? '').trim() === '');
}

/**
 * "1,200.50", "12.5 kg", "12,5" and "0,125" (a decimal comma, as a
 * semicolon-separated CSV writes it), "1.234,5" (dot groups, then a decimal
 * comma) → a number; anything else, including `0x10` and `1e3` which
 * `Number()` would accept, is NaN.
 *
 * A lone comma is the decimal mark whatever follows it: the one number column
 * is a piece's weight, kept to three decimals, so `1,125` is 1.125 kg from a
 * decimal-comma Excel, never a 1125 kg piece.
 */
function parseNumber(text: string): number {
  const bare = text.replace(/\s*kgs?$/i, '').replace(/\s/g, '');
  const plain = /^-?\d+,\d+$/.test(bare)
    ? bare.replace(',', '.')
    : /^-?\d{1,3}(\.\d{3})+,\d+$/.test(bare)
      ? bare.replace(/\./g, '').replace(',', '.')
      : bare.replace(/,/g, '');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(plain) ? Number(plain) : Number.NaN;
}


/**
 * One row → one `ImportRow`, or the issues that stop it.
 *
 * Every column is checked rather than stopping at the first problem, so a row
 * with three wrong cells reports three problems once, not one per upload.
 *
 * `restore` reads a backup of the catalogue (`product-zip.service.ts`) rather
 * than a sheet a person typed: a cell is the stored value exactly — its ends
 * trimmed, its inner spacing kept, since the screens keep it — and a blank
 * Alias or Size is that value cleared (null), not left out.
 */
export function parseImportRow(
  cells: readonly string[],
  match: HeaderMatch,
  headerRow: readonly string[],
  row: number,
  options: { restore?: boolean } = {},
): { input: ImportRow | null; issues: ProductImportIssue[] } {
  const issues: ProductImportIssue[] = [];
  const product: Record<string, unknown> = {};
  const variant: Record<string, unknown> = {};

  const issue = (
    column: ImportColumn | undefined,
    index: number,
    messageKey: ProductImportIssue['messageKey'],
    params?: MessageParams,
  ): void => {
    const header = (headerRow[index] ?? column?.field ?? '').trim();
    issues.push({ row, kind: 'error', column: header || undefined, messageKey, params });
  };

  match.byIndex.forEach((column, index) => {
    if (!column) return;
    const raw = (cells[index] ?? '').trim();
    if (raw === '') {
      if (options.restore && (column.field === 'alias' || column.field === 'size')) product[column.field] = null;
      return;
    }

    const header = (headerRow[index] ?? column.field).trim() || column.field;
    const target = VARIANT_FIELDS.has(column.field) ? variant : product;

    switch (column.kind) {
      case 'text':
        // Inner runs of whitespace (a pasted line break, a double space, a
        // non-breaking space) would make "ONE  PIECE" a different product from
        // "ONE PIECE"; a code is left as typed, and so is a restore's cell.
        target[column.field] = column.field === 'code' || options.restore ? raw : raw.replace(/\s+/g, ' ');
        return;

      case 'boolean': {
        const resolved = BOOLEAN_WORDS[raw.trim().toLowerCase()];
        if (resolved === undefined) {
          issue(column, index, 'validation.import.invalidValue', { column: header, allowed: 'yes, no' });
          return;
        }
        target[column.field] = resolved;
        return;
      }

      case 'number': {
        const value = parseNumber(raw);
        if (!Number.isFinite(value)) {
          issue(column, index, 'validation.import.notANumber', { column: header });
          return;
        }
        const belowMin =
          column.min !== undefined && (column.exclusiveMin ? value <= column.min : value < column.min);
        if (belowMin) {
          issue(column, index, 'validation.product.weightPositive');
          return;
        }
        target[column.field] = value;
        return;
      }
    }
  });

  const indexOf = (field: ImportField): number => match.byIndex.findIndex((column) => column?.field === field);

  const named = (value: unknown): boolean => typeof value === 'string' && value !== '';
  if (!named(product.categoryName) && !named(product.categoryCode)) {
    issue(COLUMN_BY_FIELD.get('categoryName'), indexOf('categoryName'), 'validation.product.categoryRequired');
  }
  if (typeof product.name !== 'string' || product.name === '') {
    issue(COLUMN_BY_FIELD.get('name'), indexOf('name'), 'validation.product.nameRequired');
  }
  if (typeof variant.code !== 'string' || variant.code === '') {
    issue(COLUMN_BY_FIELD.get('code'), indexOf('code'), 'validation.product.variantCodeRequired');
  }

  // Built as loose records above because the fields are chosen at runtime;
  // by here the required strings are present.
  // The colour rule decides what the Colour cell means (docs/catalogue/
  // CATALOGUE_MODEL.md §2): a dedicated sub product carries none, and a
  // multicolour one is the single flag the model stores — and keeps a colour
  // it is given, because the form lets a multicolour sub product have colours
  // too and the export writes them. No rule at all reads the sheet the way it
  // was read before the column existed.
  const ruleText = typeof variant.colourRule === 'string' ? variant.colourRule.toLowerCase() : '';
  const rule = ruleText ? COLOUR_RULES[normalizeHeader(ruleText)] : undefined;
  const colour = typeof variant.variant === 'string' ? variant.variant : null;
  if (ruleText && !rule) {
    issue(COLUMN_BY_FIELD.get('colourRule'), indexOf('colourRule'), 'validation.import.invalidValue', {
      column: (headerRow[indexOf('colourRule')] ?? 'colourRule').trim() || 'colourRule',
      allowed: 'fixed, dedicated, multicolour',
    });
  } else if (rule === 'fixed' && !colour) {
    issue(COLUMN_BY_FIELD.get('variant'), indexOf('variant'), 'validation.import.fixedNeedsColour');
  }
  if (rule) product.multiColour = rule === 'multicolour';

  const built: ImportRow = {
    product: product as unknown as ProductInput,
    variant: {
      code: String(variant.code ?? ''),
      label: rule === 'dedicated' ? null : colour,
      weightKg: typeof variant.weightKg === 'number' ? variant.weightKg : null,
    },
  };

  if (issues.length === 0) {
    try {
      validateProductInput(built.product);
    } catch (error) {
      if (error instanceof ProductValidationError) {
        issues.push({ row, kind: 'error', messageKey: error.messageKey });
      } else {
        throw error;
      }
    }
  }

  return issues.length > 0 ? { input: null, issues } : { input: built, issues };
}

/**
 * Second and later occurrences of a code, or the same variant of the same
 * model within the file.
 *
 * Reported against the *later* row and pointing at the first, so the person
 * fixes the duplicate rather than the original. Case-insensitive, matching the
 * database's own `lower(code)` index.
 *
 * `byCode`: a row whose variant is its code, not its colour (a sheet with no
 * Colour column naming a live code), is a duplicate only by its code.
 */
export function findDuplicatesInFile(
  rows: readonly ParsedRow[],
  headerFor: (field: ImportField) => string,
  byCode: (entry: ParsedRow) => boolean = () => false,
): ProductImportIssue[] {
  const issues: ProductImportIssue[] = [];
  const firstCode = new Map<string, number>();
  const firstVariant = new Map<string, number>();

  const duplicate = (row: number, field: ImportField, first: number): void => {
    issues.push({
      row,
      kind: 'error',
      column: headerFor(field),
      messageKey: 'validation.import.duplicateInFile',
      params: { column: headerFor(field), firstRow: first },
    });
  };

  for (const entry of rows) {
    const { row, input } = entry;
    const code = input.variant.code.trim().toLowerCase();
    if (code) {
      const first = firstCode.get(code);
      if (first === undefined) firstCode.set(code, row);
      else duplicate(row, 'code', first);
    }
    if (byCode(entry)) continue;

    const variantKey = `${groupKey(input)}${(input.variant.label ?? '').trim().toLowerCase()}`;
    const first = firstVariant.get(variantKey);
    if (first === undefined) firstVariant.set(variantKey, row);
    else duplicate(row, 'variant', first);
  }

  return issues;
}

/**
 * Category and model, case-insensitively: what makes two rows one product.
 * The category is its code when the row gives one, else its (brand, name)
 * pair — two brands may share a product name. Fields are joined with a unit
 * separator, which no trimmed cell contains. A twin's row (`separateTwins`)
 * also carries the sub product it is on.
 */
function groupKey(input: ImportRow): string {
  const text = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();
  const { categoryCode, categoryBrand, categoryName, name } = input.product;
  const category = text(categoryCode)
    ? ['code', text(categoryCode)]
    : ['name', text(categoryBrand), text(categoryName)];
  return [...category, text(name), ...(input.owner ? [input.owner] : [])].join('\u001f');
}

/**
 * Twins: rows that read as one sub product (one main product, one name) while
 * their codes already sit on two or more live sub products — what two imports
 * made before the import kept the name rule. Each such row is marked with the
 * sub product its code is on, so the rows fold back into the products they
 * came from and an unedited backup reads as it is. A row of that name whose
 * code is on none of them is left to the name, where the name rule refuses
 * it: which twin it belongs to is not in the file.
 */
export function separateTwins(
  rows: readonly ParsedRow[],
  ownerOf: (code: string) => string | undefined,
): void {
  const owners = new Map<string, Set<string>>();
  for (const { input } of rows) {
    const owner = ownerOf(input.variant.code);
    if (!owner) continue;
    const key = groupKey(input);
    owners.set(key, (owners.get(key) ?? new Set<string>()).add(owner));
  }
  for (const { input } of rows) {
    const owner = ownerOf(input.variant.code);
    if (owner && (owners.get(groupKey(input))?.size ?? 0) > 1) input.owner = owner;
  }
}

/** Several sheet rows folded into one product. */
export interface ImportGroup {
  key: string;
  /** Every row that fed the group, in sheet order; the first supplies the product fields. */
  rows: ParsedRow[];
  /** The product as the catalogue service would receive it. */
  input: ProductInput;
}

/**
 * Fold rows into products: rows sharing a category and model become one
 * product whose variants are those rows. The model's own fields come from
 * the first row — a sheet that gives DAMRU a different size on row 3 than on
 * row 2 is asking two things at once, and the first wins as it would in a
 * form.
 *
 * A group that names a variant on some rows and leaves it blank on others is
 * refused whole (`validation.import.mixedVariants`): it cannot be both a
 * one-form product and a model with colours.
 *
 * A `restore` reads a backup, which writes one sub product's cells alike on
 * every row: a later row that disagrees with the first is a second sub
 * product the file cannot tell apart from it (twins of one name, or a
 * hand-combined file), so it is reported (`validation.import.subProductCellsDiffer`)
 * rather than folded into the first and its cells lost.
 */
export function groupImportRows(
  rows: readonly ParsedRow[],
  headerFor: (field: ImportField) => string,
  options: { restore?: boolean } = {},
): { groups: ImportGroup[]; issues: ProductImportIssue[] } {
  const byKey = new Map<string, ParsedRow[]>();
  for (const entry of rows) {
    const key = groupKey(entry.input);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(entry);
    else byKey.set(key, [entry]);
  }

  const groups: ImportGroup[] = [];
  const issues: ProductImportIssue[] = [];

  for (const [key, all] of byKey) {
    const head = all[0] as ParsedRow;
    const members = all.filter((entry) => {
      const differs = options.restore ? differingField(head.input.product, entry.input.product) : undefined;
      if (differs === undefined) return true;
      // The Colour rule cell is where the template's multicolour flag lives.
      const column = headerFor(differs === 'multiColour' ? 'colourRule' : differs);
      issues.push({
        row: entry.row,
        kind: 'error',
        column,
        messageKey: 'validation.import.subProductCellsDiffer',
        params: { name: head.input.product.name, column, firstRow: head.row },
      });
      return false;
    });

    const labelled = members.filter((entry) => (entry.input.variant.label ?? '').trim() !== '');
    if (labelled.length > 0 && labelled.length < members.length) {
      for (const entry of members) {
        issues.push({
          row: entry.row,
          kind: 'error',
          column: headerFor('variant'),
          messageKey: 'validation.import.mixedVariants',
          params: { name: entry.input.product.name },
        });
      }
      continue;
    }

    const first = members[0] as ParsedRow;
    const hasVariants = labelled.length > 0;
    groups.push({
      key,
      rows: members,
      input: {
        ...first.input.product,
        hasVariants,
        variants: members.map((entry, index) => ({
          code: entry.input.variant.code.trim(),
          label: hasVariants ? (entry.input.variant.label ?? '').trim() : null,
          weightKg: entry.input.variant.weightKg ?? null,
          sequence: index + 1,
        })),
      },
    });
  }

  return { groups, issues };
}

/** The first sub product cell two rows give differently, if any. */
function differingField(a: ProductInput, b: ProductInput): ProductField | undefined {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ProductField>;
  return [...fields].find((field) => a[field] !== b[field]);
}

/**
 * The Guide sheet: one row per column, so the template explains itself.
 *
 * `createsCategories` is the company's answer, passed in rather than read
 * here — this module is pure. It is not cosmetic: with the category switch
 * off, the standing note "Created if it does not exist yet." is the opposite
 * of what the importer will do, and the template is the one thing a person
 * reads before filling the sheet in.
 */
export function templateGuideRows(createsCategories: boolean): string[][] {
  return IMPORT_COLUMNS.filter((column) => !column.legacy).map((column) => [
    column.label,
    column.required ? 'yes' : '',
    column.kind === 'boolean' ? 'yes / no' : column.kind,
    noteFor(column, createsCategories),
  ]);
}

/** The note that is the company's answer rather than a fixed sentence. */
function noteFor(column: (typeof IMPORT_COLUMNS)[number], createsCategories: boolean): string {
  if (column.field === 'categoryName' && !createsCategories) {
    return 'Required unless Main product code is filled. Must already exist — an import cannot create one.';
  }
  return column.note;
}
