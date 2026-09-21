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
 * **Headers are the wire field keys** (`code`, `name`, `rate`, …), which is
 * what the blank template writes and what round-trips exactly. A person who
 * types their own header row gets a lot of latitude anyway: matching ignores
 * case, spaces and punctuation, and knows the labels the Add Product form uses
 * plus the usual trade shorthand (`SKU`, `HSN`, `EAN`, `GST`, `Colour`).
 * Whatever they wrote is what an issue echoes back as `column`.
 *
 * **Money is in rupees in the sheet and paise in the database**, the same
 * conversion the form makes (`ProductDrawer.tsx`'s `toPaise`). A price column
 * the actor may not set is refused per row rather than silently dropped — a
 * 201 that discarded the price is the worst answer available.
 *
 * Validates only what a row asserts: a blank cell leaves the key absent, so a
 * four-column file of categories, models, codes and names imports without
 * inventing nulls for the other fields.
 */

import type { MessageParams, ProductImportIssue, ProductInput, ProductVariantInput } from '@orderbook/shared';
import { PRODUCT_UOMS, ProductValidationError, validateProductInput } from '@orderbook/shared';

/** Product-level fields a sheet may carry. */
export type ProductField = Exclude<
  keyof ProductInput,
  'categoryId' | 'parameters' | 'customFields' | 'variants' | 'hasVariants'
>;

/** The three columns that describe the row's variant rather than its model. */
export type VariantField = 'variant' | 'code' | 'weightKg';

export type ImportField = ProductField | VariantField;

type ImportKind = 'text' | 'money' | 'number' | 'int' | 'enum';

type MoneyPermission ='field.saleRate.edit' | 'field.purchaseRate.edit';

export interface ImportColumn {
  field: ImportField;
  kind: ImportKind;
  required?: true;
  /** The closed set an `enum` column accepts, in canonical form. */
  values?: readonly string[];
  min?: number;
  max?: number;
  /** `true` when `min` is a floor the value must clear, not merely reach. */
  exclusiveMin?: true;
  /** A money column only this permission may fill in. */
  permission?: MoneyPermission;
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
  { field: 'productType', kind: 'text', note: 'Free text — e.g. Plain, Designer, Vitrosa.' },
  { field: 'brand', kind: 'text', note: '' },
  { field: 'size', kind: 'text', note: 'e.g. 18x12, L-27 B-15 H-26' },
  { field: 'sin', kind: 'text', note: 'Stock item number from the catalogue.' },
  { field: 'grade', kind: 'text', note: '' },
  { field: 'hsnCode', kind: 'text', note: 'Kept as text so leading zeros survive.' },
  { field: 'barcode', kind: 'text', note: 'Unique across live products. Kept as text.' },
  { field: 'uom', kind: 'enum', values: PRODUCT_UOMS, note: 'What the product is counted in. Defaults to box.' },
  { field: 'rate', kind: 'money', permission: 'field.saleRate.edit', min: 0, note: 'Sale rate per unit, in rupees.' },
  { field: 'mrp', kind: 'money', permission: 'field.saleRate.edit', min: 0, note: 'Printed on the box, in rupees.' },
  { field: 'purchaseRate', kind: 'money', permission: 'field.purchaseRate.edit', min: 0, note: 'What the company pays, in rupees.' },
  { field: 'gstRatePct', kind: 'number', min: 0, max: 100, note: 'Percentage, 0 to 100.' },
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
      ['productType', ['type']],
      ['brand', ['make']],
      ['size', ['dimensions']],
      ['sin', ['stockitemnumber']],
      ['grade', ['quality']],
      ['hsnCode', ['hsn']],
      ['barcode', ['ean', 'ean13', 'upc']],
      ['uom', ['unit', 'unitofmeasure', 'countedin', 'units']],
      ['rate', ['price', 'saleprice', 'salerate', 'rateperunit', 'sellingprice']],
      ['mrp', []],
      ['purchaseRate', ['cost', 'costprice', 'purchaseprice', 'buyingprice']],
      ['gstRatePct', ['gst', 'gstrate', 'gstpercent', 'tax', 'taxrate']],
    ] as Array<[ImportField, string[]]>
  ).flatMap(([field, aliases]) =>
    [field, ...aliases].map((alias): [string, ImportField] => [normalizeHeader(alias), field]),
  ),
);

/**
 * What an enum column accepts besides its canonical values, after
 * `normalizeEnum`. Sheets say "Boxes", "pcs" and "nos".
 */
const ENUM_SYNONYMS: Partial<Record<ImportField, Record<string, string>>> = {
  uom: { boxes: 'box', bx: 'box', sq_ft: 'sqft', square_feet: 'sqft', squarefeet: 'sqft', pieces: 'piece', pcs: 'piece', pc: 'piece', nos: 'piece' },
};

function normalizeEnum(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

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

export interface MoneyPermissions {
  /** Holds `field.saleRate.edit`. */
  rates: boolean;
  /** Holds `field.purchaseRate.edit`. */
  cost: boolean;
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
  // "1,200.50", "Rs 1200", "₹ 850" — strip separators and currency marks.
  return Number(text.replace(/^(rs\.?|inr)\s*/i, '').replace(/[,\s₹]/g, ''));
}

function rangeIssueKey(column: ImportColumn): ProductImportIssue['messageKey'] {
  if (column.field === 'gstRatePct') return 'validation.product.percentage';
  if (column.field === 'weightKg') return 'validation.product.weightPositive';
  return 'validation.product.negativeAmount';
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
  allowed: MoneyPermissions,
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

    if (column.permission) {
      const held = column.permission === 'field.saleRate.edit' ? allowed.rates : allowed.cost;
      if (!held) {
        issue(column, index, 'error.forbidden.missingPermission', { permission: column.permission });
        return;
      }
    }

    switch (column.kind) {
      case 'text':
        target[column.field] = raw;
        return;

      case 'enum': {
        const canonical = normalizeEnum(raw);
        const synonyms = ENUM_SYNONYMS[column.field] ?? {};
        const values = column.values ?? [];
        const resolved = values.includes(canonical) ? canonical : synonyms[canonical];
        if (!resolved) {
          issue(column, index, 'validation.import.invalidValue', {
            column: header,
            allowed: values.join(', '),
          });
          return;
        }
        target[column.field] = resolved;
        return;
      }

      case 'money':
      case 'number':
      case 'int': {
        const value = parseNumber(raw);
        if (!Number.isFinite(value)) {
          issue(column, index, 'validation.import.notANumber', { column: header });
          return;
        }
        if (column.kind === 'int' && !Number.isInteger(value)) {
          issue(column, index, 'validation.import.notAWholeNumber', { column: header });
          return;
        }
        const belowMin =
          column.min !== undefined && (column.exclusiveMin ? value <= column.min : value < column.min);
        if (belowMin || (column.max !== undefined && value > column.max)) {
          issue(column, index, rangeIssueKey(column));
          return;
        }
        target[column.field] = column.kind === 'money' ? Math.round(value * 100) : value;
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
 * Second and later occurrences of a code, a barcode, or the same variant of
 * the same model within the file.
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
  const firstBarcode = new Map<string, number>();
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

    const barcode = (input.product.barcode ?? '').trim().toLowerCase();
    if (barcode) {
      const first = firstBarcode.get(barcode);
      if (first === undefined) firstBarcode.set(barcode, row);
      else duplicate(row, 'barcode', first);
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
    column.kind === 'money' ? 'rupees' : column.kind === 'enum' ? 'one of' : column.kind,
    column.values ? column.values.join(', ') : '',
    column.note,
  ]);
}
