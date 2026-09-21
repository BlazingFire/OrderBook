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
 */

import type { MessageParams, ProductImportIssue, ProductInput, ProductVariantInput } from '@orderbook/shared';
import { ProductValidationError, validateProductInput } from '@orderbook/shared';

/** Product-level fields a sheet may carry. */
export type ProductField = Exclude<keyof ProductInput, 'categoryId' | 'customFields' | 'variants' | 'hasVariants'>;

/** The three columns that describe the row's variant rather than its model. */
export type VariantField = 'variant' | 'code' | 'weightKg';

export type ImportField = ProductField | VariantField;

type ImportKind = 'text' | 'number' | 'boolean';

export interface ImportColumn {
  field: ImportField;
  kind: ImportKind;
  required?: true;
  min?: number;
  /** `true` when `min` is a floor the value must clear, not merely reach. */
  exclusiveMin?: true;
  /** One line for the template's Guide sheet. */
  note: string;
}

/** Template order. The first five are the shape of the catalogue itself. */
export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { field: 'categoryName', kind: 'text', required: true, note: 'Required. Created if it does not exist yet — e.g. ONE PIECE TOILET.' },
  { field: 'name', kind: 'text', required: true, note: 'Required. The model — e.g. DAMRU. Rows sharing a category and model are one product.' },
  { field: 'variant', kind: 'text', note: 'Colour or pattern of this row — e.g. Blue, Vitrosa 41. Leave blank for a product that comes in one form.' },
  { field: 'code', kind: 'text', required: true, note: 'Required. Unique across the whole catalogue.' },
  { field: 'weightKg', kind: 'number', min: 0, exclusiveMin: true, note: 'Weight of one piece in kilograms. Blank until known.' },
  { field: 'alias', kind: 'text', note: 'A short name staff use at the counter.' },
  { field: 'size', kind: 'text', note: 'e.g. 18x12, L-27 B-15 H-26' },
  { field: 'multiColour', kind: 'boolean', note: 'yes when the model is made in every colour of the colour list, so a lead line can name one. Defaults to no.' },
];

/** The template's header row, in order. */
export const IMPORT_HEADERS: readonly string[] = IMPORT_COLUMNS.map((column) => column.field);

const COLUMN_BY_FIELD = new Map(IMPORT_COLUMNS.map((column) => [column.field, column]));

const VARIANT_FIELDS = new Set<ImportField>(['variant', 'code', 'weightKg']);

/** Lower-case letters and digits only: "Rate / box" and "rate_box" are the same header. */
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
      ['categoryName', ['category']],
      ['name', ['productname', 'product', 'model', 'modelname', 'item', 'itemname']],
      ['variant', ['colour', 'color', 'variantname', 'colourvariant', 'shade', 'pattern', 'label']],
      ['code', ['productcode', 'variantcode', 'sku', 'itemcode', 'articlecode', 'article']],
      ['weightKg', ['weight', 'weightkgs', 'kg', 'kgs']],
      ['alias', ['shortname', 'nickname']],
      ['size', ['dimensions']],
      ['multiColour', ['multicolor', 'allcolours', 'allcolors', 'anycolour', 'anycolor']],
    ] as Array<[ImportField, string[]]>
  ).flatMap(([field, aliases]) =>
    [field, ...aliases].map((alias): [string, ImportField] => [normalizeHeader(alias), field]),
  ),
);

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

  const missing = IMPORT_COLUMNS.filter((column) => column.required && !claimed.has(column.field)).map(
    (column) => column.field,
  );

  return { byIndex, ignored, missing };
}

/** One sheet row, understood: the model's fields and the row's own variant. */
export interface ImportRow {
  /** Product-level fields; `categoryName` and `name` are always present. */
  product: ProductInput;
  variant: ProductVariantInput;
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

function parseNumber(text: string): number {
  // "1,200.50", "12.5 kg" — strip separators and the unit.
  return Number(text.replace(/\s*kgs?$/i, '').replace(/[,\s]/g, ''));
}


/**
 * One row → one `ImportRow`, or the issues that stop it.
 *
 * Every column is checked rather than stopping at the first problem, so a row
 * with three wrong cells reports three problems once, not one per upload.
 */
export function parseImportRow(
  cells: readonly string[],
  match: HeaderMatch,
  headerRow: readonly string[],
  row: number,
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
    if (raw === '') return;

    const header = (headerRow[index] ?? column.field).trim() || column.field;
    const target = VARIANT_FIELDS.has(column.field) ? variant : product;

    switch (column.kind) {
      case 'text':
        target[column.field] = raw;
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

  if (typeof product.categoryName !== 'string' || product.categoryName === '') {
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
  const built: ImportRow = {
    product: product as unknown as ProductInput,
    variant: {
      code: String(variant.code ?? ''),
      label: typeof variant.variant === 'string' ? variant.variant : null,
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
 */
export function findDuplicatesInFile(
  rows: readonly ParsedRow[],
  headerFor: (field: ImportField) => string,
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

  for (const { row, input } of rows) {
    const code = input.variant.code.trim().toLowerCase();
    if (code) {
      const first = firstCode.get(code);
      if (first === undefined) firstCode.set(code, row);
      else duplicate(row, 'code', first);
    }

    const variantKey = `${groupKey(input)}${(input.variant.label ?? '').trim().toLowerCase()}`;
    const first = firstVariant.get(variantKey);
    if (first === undefined) firstVariant.set(variantKey, row);
    else duplicate(row, 'variant', first);
  }

  return issues;
}

/** Category and model, case-insensitively: what makes two rows one product. */
export function groupKey(input: ImportRow): string {
  return `${(input.product.categoryName ?? '').trim().toLowerCase()}${input.product.name.trim().toLowerCase()}`;
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
 * the first row — a sheet that gives DAMRU a different rate on row 3 than on
 * row 2 is asking two things at once, and the first wins as it would in a
 * form.
 *
 * A group that names a variant on some rows and leaves it blank on others is
 * refused whole (`validation.import.mixedVariants`): it cannot be both a
 * one-form product and a model with colours.
 */
export function groupImportRows(
  rows: readonly ParsedRow[],
  headerFor: (field: ImportField) => string,
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

  for (const [key, members] of byKey) {
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

/** The Guide sheet: one row per column, so the template explains itself. */
export function templateGuideRows(): string[][] {
  return IMPORT_COLUMNS.map((column) => [
    column.field,
    column.required ? 'yes' : '',
    column.kind === 'boolean' ? 'yes / no' : column.kind,
    column.note,
  ]);
}
