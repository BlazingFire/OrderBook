/**
 * Reading a spreadsheet row as a `ProductInput` — pure, so the same function
 * answers "what would this file do" and "do it", and a unit test can drive it
 * with a two-dimensional array.
 *
 * **Headers are the wire field keys** (`productCode`, `name`, `rate`, …), which
 * is what the blank template writes and what round-trips exactly. A person who
 * types their own header row gets a lot of latitude anyway: matching ignores
 * case, spaces and punctuation, and knows the labels the Add Product form uses
 * ("Rate / box", "Pieces per box", "Coverage per box (sq ft)") plus the usual
 * trade shorthand (`SKU`, `HSN`, `EAN`, `GST`, `PEI`). Whatever they wrote is
 * what an issue echoes back as `column`.
 *
 * **Money is in rupees in the sheet and paise in the database**, the same
 * conversion the form makes (`ProductDrawer.tsx`'s `toPaise`). A price column
 * the actor may not set is refused per row rather than silently dropped — the
 * public API found out why (`public-api.routes.ts`'s `WRITE_GUARDS`): a 201
 * that discarded the price is the worst answer available.
 *
 * Validates only what a row asserts: a blank cell leaves the key absent, so a
 * two-column file of codes and names imports without inventing nulls for the
 * other thirty fields.
 */

import type { MessageParams, ProductImportIssue, ProductInput } from '@orderbook/shared';
import {
  PRODUCT_APPLICATIONS,
  PRODUCT_COLOUR_POLICIES,
  PRODUCT_EDGE_TYPES,
  PRODUCT_UOMS,
  ProductValidationError,
  validateProductInput,
} from '@orderbook/shared';

export type ImportField = Exclude<keyof ProductInput, 'categoryId' | 'parameters' | 'customFields'>;

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
  /** A money column only this permission may fill in. */
  permission?: MoneyPermission;
  /** One line for the template's Guide sheet. */
  note: string;
}

/**
 * Template order. The lead-generation flow first: brand, the main product,
 * the code, dimensions, then colour and the rest.
 */
export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { field: 'brand', kind: 'text', note: '' },
  { field: 'categoryName', kind: 'text', note: 'Created if it does not exist yet.' },
  { field: 'productCode', kind: 'text', note: 'Unique. Leave blank to have one generated (PRD-0001, …).' },
  { field: 'name', kind: 'text', required: true, note: 'Required.' },
  { field: 'alias', kind: 'text', note: 'A short name staff use at the counter.' },
  { field: 'size', kind: 'text', note: 'e.g. 600x600mm' },
  { field: 'color', kind: 'text', note: '' },
  { field: 'colourPolicy', kind: 'enum', values: PRODUCT_COLOUR_POLICIES, note: 'fixed keeps the base colour; selectable lets the counter choose one. Defaults to fixed.' },
  { field: 'grade', kind: 'text', note: '' },
  { field: 'sin', kind: 'text', note: 'Stock item number from the catalogue.' },
  { field: 'productType', kind: 'text', note: 'Free text — drives the type filter chips.' },
  { field: 'series', kind: 'text', note: '' },
  { field: 'finish', kind: 'text', note: '' },
  { field: 'shade', kind: 'text', note: 'Production shade, not the batch.' },
  { field: 'calibre', kind: 'text', note: '' },
  { field: 'surfaceTexture', kind: 'text', note: '' },
  { field: 'originPlant', kind: 'text', note: '' },
  { field: 'hsnCode', kind: 'text', note: 'Kept as text so leading zeros survive.' },
  { field: 'barcode', kind: 'text', note: 'Unique across live products. Kept as text.' },
  { field: 'uom', kind: 'enum', values: PRODUCT_UOMS, note: 'What the product is counted in. Defaults to box.' },
  { field: 'edgeType', kind: 'enum', values: PRODUCT_EDGE_TYPES, note: '' },
  { field: 'application', kind: 'enum', values: PRODUCT_APPLICATIONS, note: 'Where the tile can be used.' },
  { field: 'rate', kind: 'money', permission: 'field.saleRate.edit', min: 0, note: 'Sale rate per unit, in rupees.' },
  { field: 'mrp', kind: 'money', permission: 'field.saleRate.edit', min: 0, note: 'Printed on the box, in rupees.' },
  { field: 'pricePerSqft', kind: 'money', permission: 'field.saleRate.edit', min: 0, note: 'Rupees per square foot.' },
  { field: 'purchaseRate', kind: 'money', permission: 'field.purchaseRate.edit', min: 0, note: 'What the company pays, in rupees.' },
  { field: 'gstRatePct', kind: 'number', min: 0, max: 100, note: 'Percentage, 0 to 100.' },
  { field: 'waterAbsorptionPct', kind: 'number', min: 0, max: 100, note: 'Percentage, 0 to 100.' },
  { field: 'peiRating', kind: 'int', min: 0, max: 5, note: 'Abrasion resistance, 0 to 5.' },
  { field: 'weightKg', kind: 'number', min: 0, note: 'Box weight.' },
  { field: 'thicknessMm', kind: 'number', min: 0, note: '' },
  { field: 'piecesPerBox', kind: 'int', min: 0, note: '' },
  { field: 'boxCoverageSqft', kind: 'number', min: 0, note: 'Square feet covered by one box.' },
];

/** The template's header row, in order. */
export const IMPORT_HEADERS: readonly string[] = IMPORT_COLUMNS.map((column) => column.field);

const COLUMN_BY_FIELD = new Map(IMPORT_COLUMNS.map((column) => [column.field, column]));

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
      ['productCode', ['code', 'sku', 'itemcode', 'productcode']],
      ['name', ['productname', 'product', 'item', 'itemname']],
      ['alias', ['shortname', 'nickname']],
      ['categoryName', ['category']],
      ['productType', ['type']],
      ['brand', ['make']],
      ['series', ['collection']],
      ['size', []],
      ['sin', ['stockitemnumber']],
      ['grade', ['quality']],
      ['finish', []],
      ['color', ['colour']],
      ['shade', []],
      ['calibre', ['caliber']],
      ['surfaceTexture', ['texture', 'surface']],
      ['originPlant', ['plant', 'origin']],
      ['hsnCode', ['hsn']],
      ['barcode', ['ean', 'ean13', 'upc']],
      ['uom', ['unit', 'unitofmeasure', 'countedin', 'units']],
      ['edgeType', ['edge']],
      ['application', ['usedon', 'use']],
      ['rate', ['price', 'saleprice', 'salerate', 'ratebox', 'rateperbox', 'sellingprice']],
      ['mrp', []],
      ['pricePerSqft', ['ratepersqft', 'sqftrate', 'ratesqft', 'persqft']],
      ['colourPolicy', ['colourpolicy', 'colorpolicy', 'colouratsale', 'coloratsale']],
      ['purchaseRate', ['cost', 'costprice', 'purchaseprice', 'buyingprice']],
      ['gstRatePct', ['gst', 'gstrate', 'gstpercent', 'tax', 'taxrate']],
      ['waterAbsorptionPct', ['waterabsorption']],
      ['peiRating', ['pei']],
      ['weightKg', ['weight', 'boxweight']],
      ['thicknessMm', ['thickness']],
      ['piecesPerBox', ['pieces', 'pcsperbox', 'pcs', 'piecesbox']],
      ['boxCoverageSqft', ['coverage', 'coverageperbox', 'sqftperbox', 'boxcoverage', 'coverageperboxsqft']],
    ] as Array<[ImportField, string[]]>
  ).flatMap(([field, aliases]) =>
    [field, ...aliases].map((alias): [string, ImportField] => [normalizeHeader(alias), field]),
  ),
);

/**
 * What an enum column accepts besides its canonical values, after
 * `normalizeEnum`. Sheets say "Boxes", "sq ft" and "Floor and wall".
 */
const ENUM_SYNONYMS: Partial<Record<ImportField, Record<string, string>>> = {
  uom: { boxes: 'box', bx: 'box', sq_ft: 'sqft', square_feet: 'sqft', squarefeet: 'sqft', pieces: 'piece', pcs: 'piece', pc: 'piece', nos: 'piece' },
  edgeType: { nonrectified: 'non_rectified', non_rectified_edge: 'non_rectified', rectified_edge: 'rectified' },
  application: {
    floorwall: 'floor_wall',
    floor_and_wall: 'floor_wall',
    floorandwall: 'floor_wall',
    wall_floor: 'floor_wall',
    wall_and_floor: 'floor_wall',
    both: 'floor_wall',
    exterior: 'outdoor',
    outside: 'outdoor',
    floors: 'floor',
    walls: 'wall',
  },
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

export interface ParsedRow {
  /** Spreadsheet row number: the header is row 1. */
  row: number;
  /** `productCode` is `''` when the sheet left it blank and one is to be generated. */
  input: ProductInput;
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
  if (column.field === 'gstRatePct' || column.field === 'waterAbsorptionPct') {
    return 'validation.product.percentage';
  }
  if (column.field === 'peiRating') return 'validation.product.peiRating';
  return 'validation.product.negativeAmount';
}

/**
 * One row → one `ProductInput`, or the issues that stop it.
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
): { input: ProductInput | null; issues: ProductImportIssue[] } {
  const issues: ProductImportIssue[] = [];
  const input: Record<string, unknown> = { productCode: '' };

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

    if (column.permission) {
      const held = column.permission === 'field.saleRate.edit' ? allowed.rates : allowed.cost;
      if (!held) {
        issue(column, index, 'error.forbidden.missingPermission', { permission: column.permission });
        return;
      }
    }

    switch (column.kind) {
      case 'text':
        input[column.field] = raw;
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
        input[column.field] = resolved;
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
        if ((column.min !== undefined && value < column.min) || (column.max !== undefined && value > column.max)) {
          issue(column, index, rangeIssueKey(column));
          return;
        }
        input[column.field] = column.kind === 'money' ? Math.round(value * 100) : value;
        return;
      }
    }
  });

  if (typeof input.name !== 'string' || input.name === '') {
    const nameIndex = match.byIndex.findIndex((column) => column?.field === 'name');
    issue(COLUMN_BY_FIELD.get('name'), nameIndex, 'validation.product.nameRequired');
  }

  // Built as a loose record above because the fields are chosen at runtime;
  // by here `productCode` and `name` are both present as strings.
  const built = input as unknown as ProductInput;

  if (issues.length === 0) {
    try {
      validateProductInput(built);
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
 * Second and later occurrences of a product code or barcode within the file.
 *
 * Reported against the *later* row and pointing at the first, so the person
 * fixes the duplicate rather than the original. Case-insensitive, matching the
 * database's own `lower(product_code)` index.
 */
export function findDuplicatesInFile(
  rows: readonly ParsedRow[],
  headerFor: (field: ImportField) => string,
): ProductImportIssue[] {
  const issues: ProductImportIssue[] = [];
  const firstCode = new Map<string, number>();
  const firstBarcode = new Map<string, number>();

  for (const { row, input } of rows) {
    const code = input.productCode.trim().toLowerCase();
    if (code) {
      const first = firstCode.get(code);
      if (first === undefined) firstCode.set(code, row);
      else {
        issues.push({
          row,
          kind: 'error',
          column: headerFor('productCode'),
          messageKey: 'validation.import.duplicateInFile',
          params: { column: headerFor('productCode'), firstRow: first },
        });
      }
    }

    const barcode = (input.barcode ?? '').trim().toLowerCase();
    if (barcode) {
      const first = firstBarcode.get(barcode);
      if (first === undefined) firstBarcode.set(barcode, row);
      else {
        issues.push({
          row,
          kind: 'error',
          column: headerFor('barcode'),
          messageKey: 'validation.import.duplicateInFile',
          params: { column: headerFor('barcode'), firstRow: first },
        });
      }
    }
  }

  return issues;
}

/**
 * The Guide sheet: one row per column, so the template explains itself.
 *
 * `createsCategories` and `defaultUom` are the company's answers, passed in
 * rather than read here — this module is pure. Neither is cosmetic: with the
 * category switch off, the standing note "Created if it does not exist yet."
 * is the opposite of what the importer will do, and the `uom` note names the
 * unit a row with no unit column will actually be saved in. The template is the
 * one thing a person reads before filling the sheet in, so a note that lies
 * there produces a file that has to be imported twice.
 */
export function templateGuideRows(createsCategories: boolean, defaultUom: string): string[][] {
  return IMPORT_COLUMNS.map((column) => [
    column.field,
    column.required ? 'yes' : '',
    column.kind === 'money' ? 'rupees' : column.kind === 'enum' ? 'one of' : column.kind,
    column.values ? column.values.join(', ') : '',
    noteFor(column, createsCategories, defaultUom),
  ]);
}

/** The two notes that are the company's answer rather than a fixed sentence. */
function noteFor(
  column: (typeof IMPORT_COLUMNS)[number],
  createsCategories: boolean,
  defaultUom: string,
): string {
  if (column.field === 'categoryName' && !createsCategories) {
    return 'Must already exist — an import cannot create one.';
  }
  if (column.field === 'uom') {
    return `What the product is counted in. Defaults to ${defaultUom}.`;
  }
  return column.note;
}
