/**
 * Bulk product import from a spreadsheet, and the blank template it starts from.
 *
 * One function answers both "what would this file do" (`dryRun`) and "do it",
 * so the preview a person approves and the import that follows cannot disagree
 * about a row. The import re-reads and re-validates the file it is handed —
 * the database may have moved since the preview — and its result is the one
 * the screen shows.
 *
 * **A row is a variant; a product is a group of rows** sharing a category
 * and a model name (`domain/product-import.ts#groupImportRows`). Counts are
 * reported in rows, the unit the person sees in the sheet.
 *
 * **Writes go through the repositories in chunks, not through `createProduct`
 * five thousand times.** The single-product path costs two transactions, two
 * row locks and a socket fan-out per product; here each chunk of `BATCH`
 * products takes one clock stamp, one block of ids per table, one category
 * pass and two INSERTs. A chunk that fails is replayed product by product
 * through the existing single-product repository call, so one clashing code
 * costs that chunk its fast path and costs the file nothing — the other
 * products land and the bad one is reported by row number.
 *
 * **One change event, not N.** Publishing a `product` event per row would
 * push the whole file through the change ring and force every other panel
 * into a full snapshot anyway; a single `catalog` event asks for that refresh
 * once (`shared/src/protocol/socket.ts`).
 *
 * **Online-only, on the Master.** The Office panel uploads the file over its
 * panel-authenticated HTTP surface, the same path product photos take. The
 * offline outbox carries JSON mutations and rewrites its file per mutation;
 * a bulk import through it would be quadratic on disk and invisible on refusal.
 */

import { createHash } from 'node:crypto';
import type {
  MessageKey,
  MessageParams,
  Product,
  ProductCellChange,
  ProductImportIssue,
  ProductImportMode,
  ProductImportResult,
  ProductImportRowDecision,
  ProductImportRowKind,
  ProductImportRowPreview,
  ProductInput,
  ProductRowChange,
  ProductVariantInput,
} from '@orderbook/shared';
import {
  colourRuleOf,
  columnPatch,
  fieldFor,
  MAX_PRODUCT_IMPORT_ISSUES,
  MAX_PRODUCT_IMPORT_ROWS,
  PRODUCT_FORMAT_SUBJECT,
  PRODUCT_FORMAT_VERSION,
  productFormatOf,
  PRODUCT_COLUMNS,
  ProductValidationError,
  validateProductInput,
} from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import {
  findDuplicatesInFile,
  groupImportRows,
  IMPORT_COLUMNS,
  IMPORT_HEADERS,
  isBlankRow,
  matchHeaders,
  parseImportRow,
  separateTwins,
  templateGuideRows,
  type ImportField,
  type ImportGroup,
  type ParsedRow,
} from '../domain/product-import.js';
import { db } from '../db/knex.js';
import { AppError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { toCsv } from '../lib/csv.js';
import {
  buildCsvTemplate,
  buildXlsxTable,
  buildXlsxTemplate,
  XLSX_CONTENT_TYPE,
} from '../lib/spreadsheet.js';
import { readSheetRows, readSheetSubject } from '../lib/spreadsheet.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { allocatePermanentIds, nextHlc } from '../repositories/identity.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
import { publishChange } from './change-bus.js';
import { getSetting } from './settings.service.js';

const log = createLogger('product-import');

/** Products per transaction. Large enough to amortise the locks, small enough to lose little on a clash. */
const BATCH = 500;

const MAX_ROW_PREVIEWS = 1000;

const ACCEPTED_EXTENSIONS = new Set(['csv', 'xlsx', 'txt']);

/** Width of each template column, in Excel character units. */
const TEMPLATE_WIDTHS: Partial<Record<ImportField, number>> = {
  categoryBrand: 14,
  categoryCode: 18,
  categoryName: 24,
  name: 24,
  size: 18,
  colourRule: 14,
  variant: 18,
  code: 14,
  weightKg: 12,
  alias: 18,
};

const TEXT_COLUMNS = new Set<ImportField>(['code']);

/** Today as `2026-10-01`, the PC's own date — an export's file name says when it was taken. */
function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function productImportTemplate(
  format: 'csv' | 'xlsx',
  actor: ActorContext,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  requirePermission(actor, 'products.bulk');

  if (format === 'csv') {
    return {
      bytes: Buffer.from(buildCsvTemplate(IMPORT_HEADERS), 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      fileName: 'products-template.csv',
    };
  }

  const mayCreateCategories = await getSetting(actor.tenantId, 'catalog.importCreatesCategories');

  const bytes = await buildXlsxTemplate({
    columns: IMPORT_COLUMNS.filter((column) => !column.legacy).map((column) => ({
      header: column.label,
      width: TEMPLATE_WIDTHS[column.field] ?? 12,
      text: TEXT_COLUMNS.has(column.field),
      ...(column.field === 'colourRule' ? { values: ['fixed', 'dedicated', 'multicolour'] } : {}),
    })),
    guide: [['column', 'required', 'kind', 'note'], ...templateGuideRows(mayCreateCategories)],
    subject: `${PRODUCT_FORMAT_SUBJECT} ${PRODUCT_FORMAT_VERSION}`,
  });

  return { bytes, contentType: XLSX_CONTENT_TYPE, fileName: 'products-template.xlsx' };
}

/**
 * The live catalogue as a sheet in the template's own columns, one row per
 * sub product (per variant, for an older multi-variant model), in catalogue
 * order — so an export edited and uploaded back with "Update them" matches
 * every row by its code. `level: 'main'` is the list of main products instead.
 */
export async function exportProducts(
  format: 'csv' | 'xlsx',
  actor: ActorContext,
  level: 'sub' | 'main' = 'sub',
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  // Reading the catalogue needs no more than seeing it; only the import writes.
  requirePermission(actor, 'products.view');

  const { count, ...file } = await buildProductExport(format, actor, level);

  // After the file is built, in a small transaction of its own, like the log
  // export: building it wrote nothing.
  await db().transaction((trx) =>
    activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'catalog',
        entityId: actor.tenantId,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { count, level, format, fileName: file.fileName },
      },
      actor,
      trx,
    ),
  );

  return file;
}

export async function buildProductExport(
  format: 'csv' | 'xlsx',
  actor: ActorContext,
  level: 'sub' | 'main',
): Promise<{ bytes: Buffer; contentType: string; fileName: string; count: number }> {
  if (level === 'main') {
    const categories = await productRepo.listCategories(actor.tenantId);
    const headers = ['Brand', 'Main product code', 'Main product', 'Sub products'];
    const mainRows = categories.map((category) => [
      category.brand ?? '',
      category.code ?? '',
      category.name,
      category.subProductCount,
    ]);
    if (format === 'csv') {
      return {
        bytes: Buffer.from('﻿' + toCsv(headers, mainRows), 'utf8'),
        contentType: 'text/csv; charset=utf-8',
        fileName: `main-products-${today()}.csv`,
        count: mainRows.length,
      };
    }
    const bytes = await buildXlsxTable({
      sheetName: 'Main products',
      columns: headers.map((header) => ({
        header,
        width: 24,
        text: header === 'Main product code',
      })),
      rows: mainRows,
    });
    return {
      bytes,
      contentType: XLSX_CONTENT_TYPE,
      fileName: `main-products-${today()}.xlsx`,
      count: mainRows.length,
    };
  }

  // ponytail: one page of everything; paginate the read if a catalogue ever outgrows memory.
  const { items } = await productRepo.listProducts(actor.tenantId, { limit: 100000, offset: 0 });

  const columns = IMPORT_COLUMNS.filter((column) => !column.legacy);
  const rows = items.flatMap((product) => {
    // A variant taken off the form while history still quotes it stays in the
    // database, inactive; it is not part of the catalogue a person would edit.
    const live = { ...product, variants: product.variants.filter((variant) => variant.isActive) };
    const rule = ruleName(live);
    return live.variants.map((variant) => [
      product.brand ?? '',
      product.categoryCode ?? '',
      product.categoryName,
      product.name,
      product.size ?? '',
      rule,
      // Every colour a sub product has, a multicolour one's too: the form lets
      // it have both, and a blank cell would read back as one unlabelled code.
      variant.label ?? '',
      variant.code,
      variant.weightKg ?? '',
      product.alias ?? '',
    ]);
  });

  if (format === 'csv') {
    return {
      bytes: Buffer.from(
        '﻿' +
          toCsv(
            columns.map((column) => column.label),
            rows,
          ),
        'utf8',
      ),
      contentType: 'text/csv; charset=utf-8',
      fileName: `products-${today()}.csv`,
      count: rows.length,
    };
  }

  const bytes = await buildXlsxTable({
    sheetName: 'Products',
    columns: columns.map((column) => ({
      header: column.label,
      width: TEMPLATE_WIDTHS[column.field] ?? 12,
      text: TEXT_COLUMNS.has(column.field),
    })),
    rows,
    subject: `${PRODUCT_FORMAT_SUBJECT} ${PRODUCT_FORMAT_VERSION}`,
  });
  return {
    bytes,
    contentType: XLSX_CONTENT_TYPE,
    fileName: `products-${today()}.xlsx`,
    count: rows.length,
  };
}

interface ImportFile {
  buffer: Buffer;
  fileName: string;
}

interface ImportOptions {
  dryRun: boolean;
  mode: ProductImportMode;
  /** Selected spreadsheet rows for a per row review apply. When set, rows outside the set are not read, not counted and not written. */
  onlyRows?: number[];
  /**
   * SHA-256 of the file the dry run hashed, sent back with a per-row apply so
   * a re-uploaded file cannot silently move the approved row numbers. A real
   * run with `onlyRows` whose hash differs is refused with
   * `validation.import.fileChanged`.
   */
  fileHash?: string;
  /**
   * Set by the product zip restore (`product-zip.service.ts`), which writes its
   * own one activity row and change event, so this run writes neither.
   *
   * The file is a backup of the catalogue, read as the stored data rather than
   * as a sheet a person typed: a cell keeps its inner spacing and its colour's
   * own spelling, and a blank Alias, Size or Weight clears the value. A sub
   * product the file names under codes it does not have is the live one of
   * that name in that main product, and one whose code is only in the Recycle
   * Bin comes back from there — neither becomes a twin. The file's order is
   * the catalogue order: a new sub product takes its place, and a main product
   * whose sub products the file lists in another order is renumbered.
   *
   * The result lists the rows added and the cells changed (`ImportedRows`).
   * `pendingCategories` are the main products the zip will create first, and
   * `plannedCategories` the ones it will recode, rename or bring back from the
   * Recycle Bin, as it leaves them: a dry run reads them as there.
   * `exactVariants` makes each file sub product's codes exactly its rows: a
   * code the file leaves out is removed (deactivated while history quotes it),
   * not only listed. `leaving` are the live sub products the exact run moves
   * to the Recycle Bin before it writes: a dry run reads them as gone, so the
   * name one holds is free for a file row, as it is by the time the run writes.
   *
   * `updateOnly` reads the file as only the cells to change: a blank cell keeps
   * the stored value (`parseImportRow`), a row of a live code may leave Sub
   * product and Main product blank, a code a sub product lacks is added beside
   * its codes (never recoding one by its colour), no code loses its colour, no
   * variant is named "Standard", and no sub product is renumbered: a new or
   * moved one goes after the last of its main product. What a sub product
   * would be after the run is checked here, above the dry-run boundary, so a
   * row the write would refuse (a second code of one colour) is refused in the
   * preview too.
   */
  restore?: {
    pendingCategories?: readonly productRepo.CategorySeed[];
    plannedCategories?: ReadonlyArray<{
      id: string;
      code: string | null;
      name: string;
      brand: string | null;
    }>;
    exactVariants?: boolean;
    leaving?: readonly string[];
    updateOnly?: boolean;
  };
}

type UpdateGroup = ImportGroup & {
  existing: Product;
  /** In the Recycle Bin: the update brings it back first. */
  binned?: boolean;
  /**
   * The main product the plan found for the file's cells. The write files the
   * sub product by this id rather than finding it again by name: the write's
   * lookup compares exactly, while a typed sheet's name was matched with its
   * spacing collapsed, and would create a second main product beside it.
   */
  mainId?: string;
};

const isUpdate = (group: ImportGroup): group is UpdateGroup => 'existing' in group;

/** The rows a restore lists, by code; only with `restore`. */
export type ImportedRows = {
  added: ProductRowChange[];
  changed: ProductRowChange[];
  /** Live codes (colours) of a file sub product that the file does not name: removed under `exactVariants`, else kept. */
  variantsNotInFile: Array<{ code: string; name: string }>;
  /** Sub products a code brought back from the Recycle Bin, with the cells the file changed. */
  restoredFromBin: ProductRowChange[];
  /** `updateOnly`: sub products whose `dedicated` Colour rule was not applied, since codes the file does not name keep their colours. */
  ruleKept: Array<{ code: string; name: string }>;
  /** Main products whose sub products the file lists in another order: renumbered in the file's. */
  reordered: Array<{ code: string; name: string }>;
  /** Every live sub product a file row matched, changed or not — none of them is missing from the file. */
  matchedIds: string[];
  /**
   * Each sub product the run adds, changes or brings back from the Bin, as it
   * leaves it: the live one's id (null for a new one) and every code with its
   * colour — what a dry run plans those rows' photos against. A code
   * `exactVariants` removes is still here, as a dry run without it reads it,
   * so that run plans the photos against the same codes its preview did.
   */
  subProducts: Array<{
    id: string | null;
    name: string;
    hasVariants: boolean;
    variants: Array<{ code: string; label: string | null }>;
  }>;
};

/** How a run reads the file against the stored product, the same for its preview and its writes. */
interface MergeRules {
  /** A restore: the cells are the stored data. Otherwise a value equal to the stored one but for spacing keeps the stored spelling. */
  restore: boolean;
  /** A restore whose file has a Weight column: a blank weight clears the stored one. */
  clearsWeight: boolean;
  /**
   * Lower-cased codes on rows the run refused. The file still names them, so
   * `exactVariants` does not remove them and they are not listed as missing:
   * the row's problem says what is wrong with it.
   */
  refusedCodes: Set<string>;
  /** `restore.exactVariants`: every group's rows are its whole variant set. */
  exactVariants: boolean;
  /** `restore.updateOnly`: a blank Colour keeps the code's own, a new code is always added, nothing is relabelled. */
  updateOnly: boolean;
  /**
   * The file has a Colour column. Without one (a sheet of codes and weights)
   * it says nothing of colours: each code keeps its colour, and the sub
   * product whether it has colours.
   */
  colours: boolean;
}

export async function importProducts(
  file: ImportFile,
  options: ImportOptions,
  actor: ActorContext,
): Promise<ProductImportResult & { rows?: ImportedRows }> {
  requirePermission(actor, 'products.bulk');
  requirePermission(actor, 'products.create');
  if (options.mode === 'upsert') requirePermission(actor, 'products.edit');

  const extension = file.fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    throw new ValidationError('validation.import.unsupportedFormat');
  }

  const fileHash = createHash('sha256').update(file.buffer).digest('hex');
  // A per-row apply re-uploads the file its preview reviewed: row numbers only
  // mean something against the same bytes, so a changed file is refused here
  // rather than applying the approved decisions to another file's rows.
  if (!options.dryRun && options.onlyRows && options.fileHash !== fileHash) {
    throw new ValidationError('validation.import.fileChanged');
  }

  let rows: string[][];
  let formatVersion: number | null = null;
  try {
    rows = await readSheetRows(file.buffer);
    formatVersion = productFormatOf(await readSheetSubject(file.buffer));
  } catch (error) {
    log.warn(
      `Could not read ${file.fileName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new ValidationError('validation.import.unreadable');
  }

  const headerIndex = rows.findIndex((row) => !isBlankRow(row));
  if (headerIndex === -1) throw new ValidationError('validation.import.emptyFile');

  const labelOf = (field: ImportField): string =>
    IMPORT_COLUMNS.find((column) => column.field === field)?.label ?? field;
  const headerRow = (rows[headerIndex] ?? []).map((cell) => cell.trim());
  const match = matchHeaders(headerRow);
  // An update-only file needs only its Code column: a row of a live code fills the rest from it.
  const missing = options.restore?.updateOnly
    ? match.missing.filter((field) => field === 'code')
    : match.missing;
  if (missing.length > 0) {
    throw new ValidationError('validation.import.missingColumn', {
      column: labelOf(missing[0] as ImportField),
    });
  }

  const headerFor = (field: ImportField): string => {
    const at = match.byIndex.findIndex((column) => column?.field === field);
    return (at >= 0 ? headerRow[at] : undefined) || labelOf(field);
  };

  if (rows.length - headerIndex - 1 > MAX_PRODUCT_IMPORT_ROWS) {
    throw new ValidationError('validation.import.tooManyRows', { max: MAX_PRODUCT_IMPORT_ROWS });
  }

  // Read once, up front: the live products (to know a brand that exists) and
  // the Fields lists, so a brand or colour is matched the way the person sees
  // it — case and spacing aside — instead of minting "swisware+" beside
  // "Swisware+". A colour nobody listed stays as typed (the form allows it);
  // a brand nobody listed is a new brand: kept as typed and, on a real import,
  // added to the Brands list so the catalogue's brand filter can find it.
  const liveCategories = await productRepo.listCategories(actor.tenantId);
  for (const seed of options.restore?.pendingCategories ?? []) {
    liveCategories.push({
      id: `pending:${seed.code ?? seed.name}`,
      tenantId: actor.tenantId,
      name: seed.name,
      code: seed.code ?? null,
      brand: seed.brand ?? null,
      sortOrder: null,
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
      subProductCount: 0,
    });
  }
  for (const planned of options.restore?.plannedCategories ?? []) {
    const live = liveCategories.find((category) => category.id === planned.id);
    if (live) Object.assign(live, planned);
    else {
      liveCategories.push({
        ...planned,
        tenantId: actor.tenantId,
        sortOrder: null,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        subProductCount: 0,
      });
    }
  }
  const [brandOptions, colourOptions] = await Promise.all([
    customFieldRepo.listOptionsForKey(actor.tenantId, 'product.brand'),
    customFieldRepo.listOptionsForKey(actor.tenantId, 'stock.colour'),
  ]);
  const restore = options.restore !== undefined;
  // A typed sheet's spacing was collapsed as it was read (`parseImportRow`),
  // so a stored name is matched to it collapsed too; a restore's is exact.
  const textKey = (text: string): string => (restore ? text.trim() : spaced(text)).toLowerCase();
  const brandByLower = new Map<string, string>();
  for (const category of liveCategories) {
    if (category.brand) brandByLower.set(textKey(category.brand), category.brand);
  }
  for (const option of brandOptions) brandByLower.set(textKey(option.value), option.value);
  // A colour already on the list is kept as written; another spelling takes
  // the list's, the first by list order when two differ only in case (the
  // Fields screen allows both), so a preview and its run map alike.
  const colourValues = new Set(colourOptions.map((option) => option.value));
  const colourByLower = new Map<string, string>();
  for (const option of colourOptions) {
    if (!colourByLower.has(option.value.toLowerCase()))
      colourByLower.set(option.value.toLowerCase(), option.value);
  }

  const updateOnly = Boolean(options.restore?.updateOnly);
  const rules: MergeRules = {
    restore,
    clearsWeight:
      restore && !updateOnly && match.byIndex.some((column) => column?.field === 'weightKg'),
    refusedCodes: new Set(),
    exactVariants: !updateOnly && Boolean(options.restore?.exactVariants),
    colours: match.byIndex.some((column) => column?.field === 'variant'),
    updateOnly,
  };

  const issues: ProductImportIssue[] = [];
  let parsed: ParsedRow[] = [];
  let totalRows = 0;
  const codeAt = match.byIndex.findIndex((column) => column?.field === 'code');
  const codeOfRow = new Map<number, string>();

  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    if (isBlankRow(cells)) return;
    const selectedRow = headerIndex + 2 + offset;
    if (options.onlyRows && !options.onlyRows.includes(selectedRow)) return;
    totalRows += 1;
    const row = headerIndex + 2 + offset;
    codeOfRow.set(row, (cells[codeAt] ?? '').trim().toLowerCase());
    const outcome = parseImportRow(cells, match, headerRow, row, { restore, updateOnly });
    if (!outcome.input) {
      issues.push(...outcome.issues);
      return;
    }

    const { product, variant } = outcome.input;
    const brand = product.categoryBrand?.trim();
    if (brand) product.categoryBrand = brandByLower.get(textKey(brand)) ?? brand;
    // A restore's colour is the stored spelling, list or not.
    if (variant.label && !restore && !colourValues.has(variant.label)) {
      variant.label = colourByLower.get(variant.label.toLowerCase()) ?? variant.label;
    }

    parsed.push({ row, input: outcome.input });
  });

  if (totalRows === 0) throw new ValidationError('validation.import.emptyFile');

  // Which of the file's codes are already on a live variant — and on which
  // product. A group whose codes all sit on one product is that product
  // (update, or skipped); codes split across products cannot be reconciled.
  const existingByCode = await productVariantRepo.findLiveVariantsByCodes(
    actor.tenantId,
    parsed.map((entry) => entry.input.variant.code),
  );
  if (updateOnly)
    parsed = await fillFromLive(parsed, existingByCode, actor.tenantId, issues, headerFor);
  if (restore)
    separateTwins(parsed, (code) => existingByCode.get(code.trim().toLowerCase())?.productId);

  // With no Colour column a live code is its own variant: two codes of one sub product are not one.
  const duplicateIssues = findDuplicatesInFile(
    parsed,
    headerFor,
    (entry) => !rules.colours && existingByCode.has(entry.input.variant.code.trim().toLowerCase()),
    updateOnly,
  );
  const duplicateRows = new Set(duplicateIssues.map((issue) => issue.row));
  issues.push(...duplicateIssues);

  const grouped = groupImportRows(
    parsed.filter((entry) => !duplicateRows.has(entry.row)),
    headerFor,
    { restore, updateOnly },
  );
  issues.push(...grouped.issues);

  const ownersOf = (
    group: ImportGroup,
    byCode: ReadonlyMap<string, { productId: string }>,
  ): Set<string> => {
    const owners = new Set<string>();
    for (const variant of group.input.variants ?? []) {
      const hit = byCode.get(variant.code.toLowerCase());
      if (hit) owners.add(hit.productId);
    }
    return owners;
  };
  // A restore's code that only a sub product in the Recycle Bin carries is
  // that sub product: it comes back from the Bin, as catalog.restoreProduct
  // would bring it, instead of a copy being created beside it that would leave
  // the binned one unable to come back (its codes taken).
  const binnedByCode =
    restore && options.mode === 'upsert'
      ? await binnedVariantsByCodes(
          actor.tenantId,
          grouped.groups
            .filter((group) => ownersOf(group, existingByCode).size === 0)
            .flatMap((group) => group.input.variants?.map((variant) => variant.code) ?? []),
        )
      : new Map<string, { productId: string }>();
  const existingIds = new Set(
    [...existingByCode.values(), ...binnedByCode.values()].map((hit) => hit.productId),
  );
  const existingProducts = await productRepo.findProductsByIds(actor.tenantId, [...existingIds]);

  let creates: ImportGroup[] = [];
  let updates: UpdateGroup[] = [];
  const claimedOwners = new Set<string>();
  for (const group of grouped.groups) {
    let owners = ownersOf(group, existingByCode);
    const fromBin = owners.size === 0 && binnedByCode.size > 0;
    if (fromBin) owners = ownersOf(group, binnedByCode);

    if (owners.size === 0) {
      creates.push(group);
      continue;
    }
    if (owners.size > 1) {
      for (const entry of group.rows) {
        issues.push({
          row: entry.row,
          kind: 'error',
          column: headerFor('code'),
          messageKey: 'validation.import.codesSplit',
          params: { name: group.input.name },
        });
      }
      continue;
    }

    const [ownerId] = owners;
    const existing = existingProducts.get(ownerId as string);
    if (!existing) {
      creates.push(group);
    } else if (options.mode === 'upsert') {
      // Two models of the file resolving to one product would each rewrite it
      // from the same stale copy; the later one is refused rather than lost.
      if (claimedOwners.has(existing.id)) {
        for (const entry of group.rows) {
          issues.push({
            row: entry.row,
            kind: 'error',
            column: headerFor('code'),
            messageKey: 'validation.import.sameProduct',
            params: { name: group.input.name },
          });
        }
        continue;
      }
      claimedOwners.add(existing.id);
      // One back from the Bin keeps the codes the file does not name, as a
      // live one does: listed, and removed only under `exactVariants`.
      updates.push({ ...group, existing, binned: fromBin });
    } else {
      for (const entry of group.rows) {
        issues.push({
          row: entry.row,
          kind: 'skipped',
          column: headerFor('code'),
          messageKey: 'import.skip.codeExists',
          params: { productCode: entry.input.variant.code },
        });
      }
    }
  }

  const rowCount = (groups: readonly ImportGroup[]): number =>
    groups.reduce((sum, group) => sum + group.rows.length, 0);

  // The product (category) each group names, among the live ones, by the rule
  // the single-product path follows (`resolveCategoryId`): a code is exact,
  // never falls back to the name and never creates a product
  // (docs/catalogue/CATALOGUE_MODEL.md §5); a name is read with its brand, and
  // one given no brand takes the brandless product of that name first.
  //
  // Settled **here**, above the dry-run boundary, for the reason this file's
  // header gives: one function answers "what would this file do" and "do it",
  // so a preview that says "ok" and a commit that refuses would be the defect.
  const mayCreateCategories = await getSetting(actor.tenantId, 'catalog.importCreatesCategories');
  const categoryCodeOf = (group: ImportGroup): string | null =>
    group.input.categoryCode?.trim() || null;
  const existingCategoryOf = (group: ImportGroup): string | undefined => {
    const code = categoryCodeOf(group)?.toLowerCase();
    if (code) return liveCategories.find((category) => category.code?.toLowerCase() === code)?.id;
    const name = textKey(group.input.categoryName ?? '');
    if (!name) return undefined;
    const brand = textKey(group.input.categoryBrand ?? '') || null;
    const named = liveCategories.filter(
      (category) =>
        textKey(category.name) === name &&
        (brand === null || textKey(category.brand ?? '') === brand),
    );
    return (named.find((category) => !category.brand) ?? named[0])?.id;
  };

  // Refused, not filed under no category: a success that discarded what the
  // file asserted is the worst answer available. Every row of the group is
  // named, because every row carried the category. An unknown name is only
  // refused while the switch forbids creating one; an unknown code always is.
  const keepKnownCategory = (group: ImportGroup): boolean => {
    if (existingCategoryOf(group) !== undefined) return true;
    const code = categoryCodeOf(group);
    if (!code && (mayCreateCategories || !group.input.categoryName?.trim())) return true;
    for (const entry of group.rows) {
      issues.push(
        code
          ? {
              row: entry.row,
              kind: 'error',
              column: headerFor('categoryCode'),
              messageKey: 'validation.product.categoryCodeUnknown',
              params: { code },
            }
          : {
              row: entry.row,
              kind: 'error',
              column: headerFor('categoryName'),
              messageKey: 'validation.import.unknownCategory',
              params: { categoryName: group.input.categoryName ?? '' },
            },
      );
    }
    return false;
  };
  creates = creates.filter(keepKnownCategory);
  updates = updates.filter(keepKnownCategory);

  // A sub product comes back from the Bin as the Bin's own Restore brings it
  // (`catalog.restoreProduct`): only for a person who may delete products, and
  // with every code it holds — so one whose code a live product took since, or
  // this file gives another sub product, is refused here, in the preview too,
  // rather than first by the write. Never a copy created beside it instead.
  const binned = updates.filter((group) => group.binned);
  if (binned.length > 0) {
    const mayRestore = actorCan(actor, 'products.delete');
    // Every code it holds after the write, one deactivated there included.
    const codesOf = (group: UpdateGroup): string[] => {
      const after = mergedUpdate(group, rules).input.variants ?? [];
      const kept = new Set(after.map((variant) => variant.id));
      return [
        ...after.map((variant) => variant.code),
        ...group.existing.variants
          .filter((variant) => !kept.has(variant.id))
          .map((variant) => variant.code),
      ];
    };
    const fileGroupOf = new Map<string, ImportGroup>();
    for (const group of [...creates, ...updates]) {
      for (const variant of group.input.variants ?? [])
        fileGroupOf.set(variant.code.toLowerCase(), group);
    }
    const holders = await productVariantRepo.findLiveVariantsByCodes(
      actor.tenantId,
      binned.flatMap(codesOf),
    );
    const stay = new Set<ImportGroup>();
    for (const group of binned) {
      const taken = codesOf(group).filter(
        (code) =>
          holders.has(code.toLowerCase()) ||
          (fileGroupOf.get(code.toLowerCase()) ?? group) !== group,
      );
      if (mayRestore && taken.length === 0) continue;
      stay.add(group);
      for (const entry of group.rows) {
        issues.push({
          row: entry.row,
          kind: 'error',
          column: headerFor('code'),
          ...(mayRestore
            ? {
                messageKey: 'validation.product.restoreCodesTaken',
                params: { codes: taken.join(', ') },
              }
            : {
                messageKey: 'validation.import.binnedNeedsDelete',
                params: { name: group.existing.name },
              }),
        });
      }
    }
    updates = updates.filter((group) => !stay.has(group));
  }

  const bySheet = (a: ImportGroup, b: ImportGroup): number =>
    (a.rows[0]?.row ?? 0) - (b.rows[0]?.row ?? 0);
  const leaving = new Set(options.restore?.leaving);
  const liveSubs = (await liveSubProducts(actor.tenantId)).filter((sub) => !leaving.has(sub.id));
  const nameKey = (categoryId: string, name: string): string =>
    `${categoryId}\u001f${name.trim().toLowerCase()}`;

  if (restore && options.mode === 'upsert') {
    // The same sub product under codes this catalogue does not have — another
    // install numbered it — is the live one of that name in that main product,
    // unless a file row already names that one by its own codes. It is updated
    // and recoded to the file's rows, not created a second time beside itself;
    // its codes the rows leave out are kept and listed, as a live one's are.
    const namedByCode = new Set([...existingByCode.values()].map((hit) => hit.productId));
    const byName = new Map<string, string>();
    for (const sub of liveSubs) {
      const key = nameKey(sub.categoryId, sub.name);
      if (!namedByCode.has(sub.id) && !byName.has(key)) byName.set(key, sub.id);
    }
    const sameName = new Map<ImportGroup, string>();
    for (const group of creates) {
      const categoryId = existingCategoryOf(group);
      const key = categoryId === undefined ? '' : nameKey(categoryId, group.input.name);
      const id = byName.get(key);
      if (id === undefined) continue;
      sameName.set(group, id);
      byName.delete(key);
    }
    const found = await productRepo.findProductsByIds(actor.tenantId, [...sameName.values()]);
    for (const [group, id] of sameName) {
      const existing = found.get(id);
      if (!existing) continue;
      creates = creates.filter((candidate) => candidate !== group);
      updates.push({ ...group, existing });
    }
  }

  // No two live sub products of one name in one main product (§5): what the
  // screens refuse (`catalog.assertSubProductNameFree`) the bulk path must not
  // make either. Read against where every sub product ends up — a file group
  // where the file puts it, every other one where it is — so two sub products
  // whose names the file swaps both land. As on the screens only a group that
  // moves (new, renamed, moved, or back from the Bin) is refused, so twins from
  // before the rule stay editable. A refused group stays where it was, which
  // may be where another group was going: settled again until nothing more is.
  const refused = new Set<ImportGroup>();
  const fileIds = new Set(updates.map((group) => group.existing.id));
  for (let more = true; more;) {
    more = false;
    const held = new Set(
      liveSubs
        .filter((sub) => !fileIds.has(sub.id))
        .map((sub) => nameKey(sub.categoryId, sub.name)),
    );
    const moving: Array<[ImportGroup, string]> = [];
    for (const group of [...creates, ...updates].sort(bySheet)) {
      const stays =
        isUpdate(group) && !group.binned
          ? nameKey(group.existing.categoryId, group.existing.name)
          : undefined;
      const categoryId = existingCategoryOf(group);
      const name = isUpdate(group) ? mergedUpdate(group, rules).input.name : group.input.name;
      const lands = categoryId === undefined ? undefined : nameKey(categoryId, name);
      if (refused.has(group) || lands === stays) {
        if (stays !== undefined) held.add(stays);
      } else if (lands !== undefined) {
        moving.push([group, lands]);
      }
    }
    for (const [group, key] of moving) {
      if (!held.has(key)) {
        held.add(key);
        continue;
      }
      refused.add(group);
      more = true;
    }
  }
  for (const group of refused) {
    const category = liveCategories.find((candidate) => candidate.id === existingCategoryOf(group));
    for (const entry of group.rows) {
      issues.push({
        row: entry.row,
        kind: 'error',
        column: headerFor('name'),
        messageKey: 'validation.product.nameTaken',
        params: { name: group.input.name, category: category?.name ?? '' },
      });
    }
  }
  creates = creates.filter((group) => !refused.has(group));
  updates = updates.filter((group) => !refused.has(group));

  for (const group of updates) group.mainId = existingCategoryOf(group);
  // An update-only file says only some cells, so what a sub product would be is checked whole
  // here: a second code of one colour, or a colour added to a sub product of one plain code.
  if (updateOnly) {
    const writes = (group: ImportGroup): boolean => {
      try {
        validateProductInput(isUpdate(group) ? mergedUpdate(group, rules).input : group.input);
        return true;
      } catch (error) {
        if (!(error instanceof ProductValidationError)) throw error;
        for (const entry of group.rows) {
          issues.push({
            row: entry.row,
            kind: 'error',
            column: headerFor('variant'),
            messageKey: error.messageKey,
          });
        }
        return false;
      }
    };
    creates = creates.filter(writes);
    updates = updates.filter(writes);
  }
  // Every refusal above the dry-run boundary is in by here.
  for (const issue of issues) {
    const code = issue.kind === 'error' ? codeOfRow.get(issue.row) : undefined;
    if (code) rules.refusedCodes.add(code);
  }

  // An upsert row whose product already says exactly this is not an update:
  // an export uploaded back unedited must read "nothing to do", not "N updated".
  // A sub product back from the Bin is a change whatever its cells say.
  const matched = updates;
  const changes = new Map(
    updates.map((group) => [
      group,
      changedCells(group, existingCategoryOf(group), liveCategories, labelOf, rules),
    ]),
  );
  const unchangedGroups = updates.filter(
    (group) => !group.binned && changes.get(group)?.length === 0,
  );
  updates = updates.filter((group) => !unchangedGroups.includes(group));
  const unchanged = rowCount(unchangedGroups);

  const reordered: ImportedRows['reordered'] = [];
  const renumbered: Array<{ id: string; sortOrder: number; group?: ImportGroup }> = [];
  if (restore) {
    // A restored catalogue keeps the file's order. A sub product already in
    // its main product stays; every other one arrives — new, back from the
    // Bin, or moved in. Arrivals the file lists after every staying one take
    // the numbers after the main product's last, so they land last as listed.
    // Otherwise — the file lists the staying ones in another order, puts an
    // arrival between them, or a staying one has no number (sorted after any)
    // — the main product is renumbered 1..n in the file's order, the live ones
    // the file does not name after them in their own. Compared as an order,
    // never as numbers, so an unedited export — gaps and blank orders
    // included — changes nothing.
    const byMain = new Map<string, ImportGroup[]>();
    for (const group of [...creates, ...matched].sort(bySheet)) {
      const main =
        existingCategoryOf(group) ??
        `new:${productRepo.categorySeedKey({ name: group.input.categoryName ?? '', brand: group.input.categoryBrand })}`;
      const groups = byMain.get(main);
      if (groups) groups.push(group);
      else byMain.set(main, [group]);
    }
    const named = new Set(matched.map((group) => group.existing.id));
    for (const [main, groups] of byMain) {
      const stays = (group: ImportGroup): group is UpdateGroup =>
        isUpdate(group) && !group.binned && group.existing.categoryId === main;
      const staying = groups.filter(stays).map((group) => group.existing.id);
      const stayingIds = new Set(staying);
      const live = liveSubs.filter((sub) => sub.categoryId === main);
      const liveStaying = live.filter((sub) => stayingIds.has(sub.id));
      const firstArrival = groups.findIndex((group) => !stays(group));
      const inOrder =
        liveStaying.map((sub) => sub.id).join() === staying.join() &&
        (firstArrival === -1 ||
          (groups.slice(firstArrival).every((group) => !stays(group)) &&
            liveStaying.every((sub) => sub.sortOrder !== null)));
      // An update-only file lists only what it changes: it never renumbers a main product.
      if (inOrder || updateOnly) {
        let last = Math.max(0, ...live.map((sub) => sub.sortOrder ?? 0));
        for (const group of groups) if (!stays(group)) group.input.sortOrder = last += 1;
        continue;
      }

      const category = liveCategories.find((candidate) => candidate.id === main);
      reordered.push({ code: category?.code ?? '', name: category?.name ?? '' });
      groups.forEach((group, index) => {
        if (stays(group)) renumbered.push({ id: group.existing.id, sortOrder: index + 1, group });
        else group.input.sortOrder = index + 1;
      });
      let next = groups.length;
      for (const sub of live)
        if (!named.has(sub.id)) renumbered.push({ id: sub.id, sortOrder: (next += 1) });
    }
  }

  // What a restore lists: on the real run, without the rows that then failed.
  const failedRows = (): Set<number> =>
    new Set(issues.filter((issue) => issue.kind === 'error').map((issue) => issue.row));
  const restoreRows = (): { rows?: ImportedRows } => {
    if (!restore) return {};
    const failed = failedRows();
    const landed = (group: ImportGroup): boolean =>
      group.rows.every((entry) => !failed.has(entry.row));
    const changedRow = (group: UpdateGroup): ProductRowChange => ({
      code: group.input.variants?.[0]?.code ?? '',
      name: group.input.name,
      fields: changes.get(group) ?? [],
    });
    const subProduct = (
      id: string | null,
      input: ProductInput,
    ): ImportedRows['subProducts'][number] => ({
      id,
      name: input.name,
      hasVariants: Boolean(input.hasVariants),
      variants: (input.variants ?? []).map((variant) => ({
        code: variant.code,
        label: variant.label ?? null,
      })),
    });
    const kept = matched.filter(landed);
    return {
      rows: {
        added: creates
          .filter(landed)
          .flatMap((group) =>
            group.rows.map((entry) => ({
              code: entry.input.variant.code.trim(),
              name: group.input.name,
              fields: [],
            })),
          ),
        changed: updates.filter((group) => landed(group) && !group.binned).map(changedRow),
        restoredFromBin: updates.filter((group) => landed(group) && group.binned).map(changedRow),
        ruleKept: kept
          .filter((group) => mergedUpdate(group, rules).ruleKept)
          .map((group) => ({
            code: group.input.variants?.[0]?.code ?? '',
            name: group.input.name,
          })),
        variantsNotInFile: kept.flatMap((group) =>
          mergedUpdate(group, rules).untouched.map((variant) => ({
            code: variant.code,
            name: group.input.name,
          })),
        ),
        reordered,
        matchedIds: kept.map((group) => group.existing.id),
        // With the codes `exactVariants` removes: what the preview, run without it, read.
        subProducts: [
          ...creates.filter(landed).map((group) => subProduct(null, group.input)),
          ...updates
            .filter(landed)
            .map((group) =>
              subProduct(
                group.existing.id,
                mergedUpdate(group, { ...rules, exactVariants: false }).input,
              ),
            ),
        ],
      },
    };
  };

  const sample = [...creates, ...updates]
    .sort(bySheet)
    .slice(0, 5)
    .map((group) => group.input);

  function buildRowPreviews(): {
    rowPreviews: ProductImportRowPreview[];
    rowPreviewsTruncated: boolean;
  } {
    const byRow = new Map<number, ProductImportRowPreview>();
    const pushRow = (args: {
      row: number;
      kind: ProductImportRowKind;
      decision: ProductImportRowDecision;
      fileName: string;
      fileCode: string;
      existing: { name: string } | null;
      cells: ProductCellChange[];
      reasonKey: MessageKey;
      reasonParams?: MessageParams;
    }): void => {
      if (byRow.has(args.row)) return;
      byRow.set(args.row, {
        row: args.row,
        kind: args.kind,
        decision: args.decision,
        fileName: args.fileName,
        fileCode: args.fileCode,
        existingName: args.existing ? args.existing.name : null,
        existingCode: args.existing ? args.fileCode : null,
        cells: args.cells,
        reasonKey: args.reasonKey,
        ...(args.reasonParams ? { reasonParams: args.reasonParams } : {}),
      });
    };
    for (const issue of issues) {
      pushRow({
        row: issue.row,
        kind: issue.kind === 'skipped' ? 'clash' : 'invalid',
        decision: 'skip',
        fileName: '',
        fileCode: codeOfRow.get(issue.row) ?? '',
        existing: null,
        cells: [],
        reasonKey: issue.messageKey,
        reasonParams: issue.params,
      });
    }
    const upsert = options.mode === 'upsert';
    for (const group of creates) {
      for (const entry of group.rows) {
        pushRow({
          row: entry.row,
          kind: 'new',
          decision: 'create',
          fileName: group.input.name,
          fileCode: entry.input.variant.code,
          existing: null,
          cells: [],
          reasonKey: 'product.smart.reason.validNew',
        });
      }
    }
    for (const group of updates) {
      const cells = changes.get(group) ?? [];
      for (const entry of group.rows) {
        pushRow({
          row: entry.row,
          kind: 'update',
          decision: upsert ? 'update' : 'skip',
          fileName: group.input.name,
          fileCode: entry.input.variant.code,
          existing: group.existing,
          cells,
          reasonKey: upsert ? 'product.smart.reason.validUpdate' : 'import.skip.codeExists',
          ...(upsert ? {} : { reasonParams: { productCode: entry.input.variant.code } }),
        });
      }
    }
    for (const group of unchangedGroups) {
      for (const entry of group.rows) {
        pushRow({
          row: entry.row,
          kind: 'unchanged',
          decision: 'skip',
          fileName: group.input.name,
          fileCode: entry.input.variant.code,
          existing: group.existing,
          cells: [],
          reasonKey: 'product.smart.reason.unchanged',
        });
      }
    }
    const sorted = [...byRow.values()].sort((a, b) => a.row - b.row);
    return {
      rowPreviews: sorted.slice(0, MAX_ROW_PREVIEWS),
      rowPreviewsTruncated: sorted.length > MAX_ROW_PREVIEWS,
    };
  }

  if (options.dryRun) {
    return {
      ...finish({
        dryRun: true,
        fileHash,
        mode: options.mode,
        fileName: file.fileName,
        totalRows,
        created: rowCount(creates),
        updated: rowCount(updates),
        unchanged,
        issues,
        sample,
        ignoredColumns: match.ignored,
        formatVersion,
      }),
      ...restoreRows(),
      ...buildRowPreviews(),
    };
  }

  let created = 0;
  let updated = 0;

  for (const chunk of chunks(creates, BATCH)) {
    try {
      await db().transaction(async (trx) => {
        const hlc = await nextHlc(trx);
        const ids = await allocatePermanentIds(actor.tenantId, 'product', chunk.length, trx);
        // Only a name nothing matched above is left to create, and while the
        // switch is off the creating call is not made at all, rather than made
        // and trusted to find everything: every surviving group was matched.
        // A product binned between that check and this insert is the one gap
        // left; the chunk then files the sub product under it, as before.
        await registerBrands(
          actor.tenantId,
          chunk.map((group) => group.input.categoryBrand ?? ''),
          brandOptions,
          trx,
        );
        const seedOf = (group: ImportGroup) => ({
          name: group.input.categoryName ?? '',
          brand: group.input.categoryBrand ?? null,
        });
        const fresh = mayCreateCategories
          ? await productRepo.ensureCategories(
              actor.tenantId,
              chunk.filter((group) => existingCategoryOf(group) === undefined).map(seedOf),
              trx,
            )
          : new Map<string, string>();
        await productRepo.insertProductRows(
          chunk.map((group, index) => ({
            id: ids[index] as string,
            input: group.input,
            categoryId:
              existingCategoryOf(group) ??
              fresh.get(productRepo.categorySeedKey(seedOf(group))) ??
              null,
          })),
          { tenantId: actor.tenantId, hlc },
          trx,
        );

        const variantRows = chunk.flatMap((group, index) =>
          (group.input.variants ?? []).map((variant, sequence) => ({
            productId: ids[index] as string,
            input: variant,
            sequence: sequence + 1,
          })),
        );
        const variantIds = await allocatePermanentIds(
          actor.tenantId,
          'product_variant',
          variantRows.length,
          trx,
        );
        await productVariantRepo.insertVariantRows(
          variantRows.map((row, index) => ({ ...row, id: variantIds[index] as string })),
          actor.tenantId,
          trx,
        );
      });
      created += rowCount(chunk);
    } catch (error) {
      log.warn(
        `A chunk of ${chunk.length} products did not insert as one; replaying product by product: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const group of chunk) {
        try {
          await db().transaction(async (trx) => {
            const hlc = await nextHlc(trx);
            await registerBrands(
              actor.tenantId,
              [group.input.categoryBrand ?? ''],
              brandOptions,
              trx,
            );
            // Filed where the plan found its main product, as the chunk would have.
            await productRepo.insertProduct(
              {
                tenantId: actor.tenantId,
                input: { ...group.input, categoryId: existingCategoryOf(group) },
                hlc,
                fieldHlc: {},
                temporaryId: null,
              },
              trx,
            );
          });
          created += group.rows.length;
        } catch (rowError) {
          issues.push(...classifyGroupFailure(rowError, group, headerFor));
        }
      }
    }
  }

  // A brand the file introduced is now in the Brands list; the cached copy is stale.
  customFieldRepo.invalidateFieldCache(actor.tenantId);

  for (const chunk of chunks(updates, BATCH)) {
    try {
      await db().transaction(async (trx) => {
        const hlc = await nextHlc(trx);
        for (const group of chunk) await applyUpdate(group, rules, hlc, actor.tenantId, trx);
      });
      updated += rowCount(chunk);
    } catch (error) {
      log.warn(
        `A chunk of ${chunk.length} product updates did not apply as one; replaying product by product: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const group of chunk) {
        try {
          await db().transaction(async (trx) => {
            const hlc = await nextHlc(trx);
            await applyUpdate(group, rules, hlc, actor.tenantId, trx);
          });
          updated += group.rows.length;
        } catch (rowError) {
          issues.push(...classifyGroupFailure(rowError, group, headerFor));
        }
      }
    }
  }

  // The file's order, in one transaction once every row has landed: a sub
  // product whose row failed keeps its place.
  const failed = failedRows();
  const renumber = renumbered.filter(
    (entry) => !entry.group?.rows.some((row) => failed.has(row.row)),
  );
  if (renumber.length > 0) {
    await db().transaction(async (trx) => {
      const hlc = await nextHlc(trx);
      const current = await productRepo.findProductsByIds(
        actor.tenantId,
        renumber.map((entry) => entry.id),
        trx,
        { includeDeleted: false },
      );
      for (const { id, sortOrder } of renumber) {
        const product = current.get(id);
        if (!product || product.sortOrder === sortOrder) continue;
        await productRepo.updateProductColumns(
          actor.tenantId,
          id,
          { sort_order: sortOrder },
          {
            hlc,
            fieldHlc: { ...product.sync.fieldHlc, [fieldFor(PRODUCT_COLUMNS, 'sort_order')]: hlc },
          },
          trx,
        );
      }
    });
  }

  const result = finish({
    dryRun: false,
    fileHash,
    mode: options.mode,
    fileName: file.fileName,
    totalRows,
    created,
    updated,
    unchanged,
    issues,
    sample,
    ignoredColumns: match.ignored,
    formatVersion,
  });

  if (created + updated > 0 && !options.restore) {
    await db().transaction((trx) =>
      activityLog.recordActivity(
        {
          tenantId: actor.tenantId,
          entityType: 'catalog',
          entityId: actor.tenantId,
          action: 'imported',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: {
            count: created + updated,
            fileName: file.fileName,
            mode: options.mode,
            created,
            updated,
          },
        },
        actor,
        trx,
      ),
    );

    publishChange({
      entity: 'catalog',
      action: 'updated',
      id: actor.tenantId,
      payload: { created, updated, skipped: result.skipped, failed: result.failed },
    });
  }

  return { ...result, ...restoreRows() };
}

/** The Colour rule cell as the template spells it. */
function ruleName(product: {
  multiColour: boolean;
  variants: ReadonlyArray<{ label: string | null }>;
}): string {
  const rule = colourRuleOf(product);
  return rule === 'selectable' ? 'multicolour' : rule;
}

/** Text as a typed sheet reads it (`parseImportRow`): runs of whitespace as one space. */
const spaced = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The product as the sheet leaves it: the existing sub products with the
 * file's rows folded in, and the live codes no row named (`untouched`). A
 * deactivated variant (history still quotes it) stays out unless a row names
 * its code — it is not resurrected by a sheet that never mentioned it. Under
 * `exactVariants` a group keeps only its rows, and the codes of rows the run
 * refused (`MergeRules.refusedCodes`), which the file still names.
 *
 * Whether it has colours follows the file once the file covers the whole sub
 * product, no live code left unnamed: a fixed sub product the file calls
 * dedicated or multicolour becomes that, not a fixed one coloured "Standard".
 * A file with no Colour column (`MergeRules.colours`) changes neither that nor
 * any code's colour.
 * A typed sheet's text keeps the stored spelling where only the spacing
 * differs (`MergeRules`), so an unedited export reads as unchanged.
 */
function mergedUpdate(
  group: UpdateGroup,
  rules: MergeRules,
): { input: ProductInput; untouched: ProductVariantInput[]; ruleKept: boolean } {
  const asStored = (
    text: string | null | undefined,
    stored: string | null | undefined,
  ): string | null | undefined =>
    !rules.restore && text && stored && spaced(text) === spaced(stored) ? stored : text;

  const merged: Array<ProductVariantInput & { active: boolean; touched?: boolean }> =
    group.existing.variants.map((variant) => ({
      id: variant.id,
      code: variant.code,
      label: variant.label,
      weightKg: variant.weightKg,
      active: variant.isActive,
    }));

  for (const incoming of group.input.variants ?? []) {
    const byCode = merged.find(
      (variant) => variant.code.toLowerCase() === incoming.code.toLowerCase(),
    );
    const byLabel = merged.find(
      (variant) =>
        variant.active &&
        !variant.touched &&
        (variant.label ?? '').toLowerCase() === (incoming.label ?? '').toLowerCase(),
    );
    // Update only: a code the sub product lacks is another code, never one of its own recoded.
    const target = byCode ?? (rules.updateOnly ? undefined : byLabel);
    if (target) {
      target.code = incoming.code;
      if (rules.colours && (!rules.updateOnly || incoming.label))
        target.label = asStored(incoming.label, target.label) ?? null;
      target.touched = true;
      if (rules.clearsWeight) target.weightKg = incoming.weightKg ?? null;
      else if (incoming.weightKg !== undefined && incoming.weightKg !== null)
        target.weightKg = incoming.weightKg;
    } else {
      merged.push({
        code: incoming.code,
        label: incoming.label ?? null,
        weightKg: incoming.weightKg ?? null,
        active: true,
        touched: true,
      });
    }
  }

  const untouched = merged.filter((variant) => variant.active && !variant.touched);
  const onRefusedRow = (variant: { code: string }): boolean =>
    rules.refusedCodes.has(variant.code.toLowerCase());
  const leftAlone = untouched.filter((variant) => !rules.exactVariants || onRefusedRow(variant));
  const kept = merged.filter((variant) => variant.touched || leftAlone.includes(variant));
  // The file decides whether it has colours once it names every live code;
  // while codes it never named remain, a switch that was on stays on. Then an
  // unlabelled member — the single row of a one-form product a sheet now
  // gives colours — is named "Standard", the plain member, so it has a name.
  const covered = leftAlone.length === 0;
  // Update only: a blank Colour is no word on it, so the sub product keeps its colours unless
  // its rows add one, or a `dedicated` rule names every live code of it. A dedicated rule while
  // codes it does not name have colours cannot apply, and is left out whole (`ruleKept`).
  const { multiColour, ...given } = group.input;
  const dedicated =
    multiColour === false && !(group.input.variants ?? []).some((variant) => variant.label);
  const ruleKept =
    rules.updateOnly && rules.colours && dedicated && !covered && group.existing.hasVariants;
  const hasVariants = !rules.colours
    ? group.existing.hasVariants
    : rules.updateOnly
      ? !(dedicated && covered) && (Boolean(group.input.hasVariants) || group.existing.hasVariants)
      : Boolean(group.input.hasVariants) || (!covered && group.existing.hasVariants);
  return {
    ruleKept,
    input: {
      ...given,
      ...(ruleKept || multiColour === undefined ? {} : { multiColour }),
      // Left alone where it already is; else filed by the id the plan found.
      ...(group.mainId === undefined
        ? {}
        : {
            categoryId: group.mainId === group.existing.categoryId ? undefined : group.mainId,
            categoryCode: undefined,
            categoryName: undefined,
            categoryBrand: undefined,
          }),
      name: asStored(group.input.name, group.existing.name) ?? group.input.name,
      ...(group.input.alias !== undefined
        ? { alias: asStored(group.input.alias, group.existing.alias) }
        : {}),
      ...(group.input.size !== undefined
        ? { size: asStored(group.input.size, group.existing.size) }
        : {}),
      hasVariants,
      variants: kept.map(({ active: _active, touched: _touched, ...variant }, index) => ({
        ...variant,
        label: hasVariants ? (variant.label ?? (rules.updateOnly ? null : 'Standard')) : null,
        sequence: index + 1,
      })),
    },
    untouched: untouched
      .filter((variant) => !onRefusedRow(variant))
      .map(({ active: _active, touched: _touched, ...variant }) => variant),
  };
}

/**
 * The cells applying `mergedUpdate` would change, by the file's column names:
 * empty exactly when the row changes nothing the product already holds, and
 * otherwise what the product zip's preview lists, old to new. Compared on what
 * the sheet asserts (an absent key is untouched, as `columnPatch` reads it),
 * against the live variants only.
 */
function changedCells(
  group: UpdateGroup,
  categoryId: string | undefined,
  categories: ReadonlyArray<{ id: string; code: string | null; name: string }>,
  labelOf: (field: ImportField) => string,
  rules: MergeRules,
): ProductCellChange[] {
  const { existing } = group;
  const { input } = mergedUpdate(group, rules);
  const cells: ProductCellChange[] = [];
  const cell = (field: ImportField, from: unknown, to: unknown): void => {
    cells.push({
      column: labelOf(field),
      from: from == null ? '' : String(from),
      to: to == null ? '' : String(to),
    });
  };

  if (categoryId === undefined || categoryId !== existing.categoryId) {
    const moved = categories.find((category) => category.id === categoryId);
    cell(
      'categoryCode',
      existing.categoryCode ?? existing.categoryName,
      moved ? (moved.code ?? moved.name) : '',
    );
  }
  for (const key of ['name', 'alias', 'size'] as const) {
    if (input[key] !== undefined && (input[key] ?? null) !== (existing[key] ?? null)) {
      cell(key, existing[key], input[key]);
    }
  }

  const live = existing.variants.filter((variant) => variant.isActive);
  const next = input.variants ?? [];
  if (
    (input.multiColour !== undefined && input.multiColour !== existing.multiColour) ||
    input.hasVariants !== existing.hasVariants
  ) {
    cell(
      'colourRule',
      ruleName({ multiColour: existing.multiColour, variants: live }),
      ruleName({
        multiColour: input.multiColour ?? existing.multiColour,
        variants: next.map((variant) => ({ label: variant.label ?? null })),
      }),
    );
  }

  if (next.length !== live.length) {
    cell(
      'code',
      live.map((variant) => variant.code).join(', '),
      next.map((variant) => variant.code).join(', '),
    );
    return cells;
  }
  next.forEach((variant, index) => {
    const was = live[index] as (typeof live)[number];
    if (variant.code !== was.code) cell('code', was.code, variant.code);
    if ((variant.label ?? null) !== (was.label ?? null)) cell('variant', was.label, variant.label);
    if ((variant.weightKg ?? null) !== (was.weightKg ?? null))
      cell('weightKg', was.weightKg, variant.weightKg);
  });
  return cells;
}

/**
 * One update inside the caller's transaction, stamping the per-field clocks
 * the way `catalog.service.ts#updateProduct` does — so an offline edit to a
 * field this import did not touch still merges instead of being overwritten.
 *
 * The file's rows are folded into the product's existing variant set rather
 * than replacing it: a sheet naming three of DAMRU's forty codes must
 * not delete the other thirty-seven. A row matches an existing variant by
 * code, else by label, else it is a new variant.
 *
 * One in the Recycle Bin comes back first, its codes with it, as
 * `catalog.restoreProduct` brings it — its own photos and history included.
 */
async function applyUpdate(
  group: UpdateGroup,
  rules: MergeRules,
  hlc: string,
  tenantId: string,
  trx: Parameters<typeof productRepo.updateProduct>[4],
): Promise<void> {
  const { input } = mergedUpdate(group, rules);

  const touched = Object.keys(columnPatch(input, PRODUCT_COLUMNS));
  const fieldHlc: Record<string, string> = { ...group.existing.sync.fieldHlc, variants: hlc };
  for (const column of touched) fieldHlc[fieldFor(PRODUCT_COLUMNS, column)] = hlc;

  if (group.binned) {
    fieldHlc.deletedAt = hlc;
    await productRepo.restoreProduct(tenantId, group.existing.id, { hlc, fieldHlc }, trx);
  }
  await productRepo.updateProduct(tenantId, group.existing.id, input, { hlc, fieldHlc }, trx);
  if (group.binned) await productVariantRepo.setDeletedAt(tenantId, group.existing.id, null, trx);
}

/**
 * An update-only file's rows with Sub product or Main product left blank:
 * each takes the cell from another row of its sub product that gives it, else
 * from the live sub product its code is on, so it groups and matches as that
 * one and changes neither. A row whose code no live sub product has needs both
 * (`nameRequired` / `categoryRequired`), as a new one always did.
 */
async function fillFromLive(
  parsed: readonly ParsedRow[],
  liveByCode: ReadonlyMap<string, { productId: string }>,
  tenantId: string,
  issues: ProductImportIssue[],
  headerFor: (field: ImportField) => string,
): Promise<ParsedRow[]> {
  const ownerOf = (entry: ParsedRow): string | undefined =>
    liveByCode.get(entry.input.variant.code.trim().toLowerCase())?.productId;
  const hasMain = (product: ProductInput): boolean =>
    Boolean(product.categoryCode || product.categoryName);
  const lacking = parsed.filter(
    (entry) => !entry.input.product.name || !hasMain(entry.input.product),
  );
  const live = await productRepo.findProductsByIds(
    tenantId,
    lacking.flatMap((entry) => ownerOf(entry) ?? []),
  );
  const named = new Map<string, string>();
  const mains = new Map<string, ProductInput>();
  for (const entry of parsed) {
    const owner = ownerOf(entry);
    const { product } = entry.input;
    if (!owner) continue;
    if (product.name && !named.has(owner)) named.set(owner, product.name);
    if (hasMain(product) && !mains.has(owner)) mains.set(owner, product);
  }

  return parsed.filter((entry) => {
    const { product } = entry.input;
    const owner = ownerOf(entry);
    const sub = owner === undefined ? undefined : live.get(owner);
    let ok = true;
    if (!product.name) {
      const name = (owner && named.get(owner)) || sub?.name;
      if (name) product.name = name;
      else {
        issues.push({
          row: entry.row,
          kind: 'error',
          column: headerFor('name'),
          messageKey: 'validation.product.nameRequired',
        });
        ok = false;
      }
    }
    if (!hasMain(product)) {
      const from = owner === undefined ? undefined : mains.get(owner);
      const main = from
        ? {
            categoryCode: from.categoryCode,
            categoryName: from.categoryName,
            categoryBrand: from.categoryBrand,
          }
        : sub
          ? sub.categoryCode
            ? { categoryCode: sub.categoryCode }
            : { categoryName: sub.categoryName, categoryBrand: sub.brand ?? undefined }
          : undefined;
      if (main) {
        for (const [key, value] of Object.entries(main))
          if (value) Object.assign(product, { [key]: value });
      } else {
        issues.push({
          row: entry.row,
          kind: 'error',
          column: headerFor('categoryName'),
          messageKey: 'validation.product.categoryRequired',
        });
        ok = false;
      }
    }
    return ok;
  });
}

/** Every live sub product, where it sits, in catalogue order within its main product (`listProducts`' order). */
async function liveSubProducts(
  tenantId: string,
): Promise<Array<{ id: string; name: string; categoryId: string; sortOrder: number | null }>> {
  const rows = await db()('products')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .orderByRaw('sort_order ASC NULLS LAST, lower(name) ASC, id ASC')
    .select<Array<{ id: string; name: string; category_id: string; sort_order: number | null }>>(
      'id',
      'name',
      'category_id',
      'sort_order',
    );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    categoryId: String(row.category_id),
    sortOrder: row.sort_order === null ? null : Number(row.sort_order),
  }));
}

/**
 * The sub products in the Recycle Bin behind these codes, keyed by
 * lower-cased code like `findLiveVariantsByCodes`: the one binned last, when a
 * code was binned more than once.
 */
async function binnedVariantsByCodes(
  tenantId: string,
  codes: readonly string[],
): Promise<Map<string, { productId: string }>> {
  const found = new Map<string, { productId: string }>();
  const wanted = [...new Set(codes.map((code) => code.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return found;

  const rows = await db()('product_variants as v')
    .join('products as p', 'p.id', 'v.product_id')
    .where('v.tenant_id', tenantId)
    .whereNotNull('p.deleted_at')
    .whereRaw('lower(v.code) = ANY(?)', [wanted])
    .orderBy('p.deleted_at', 'desc')
    .select<Array<{ code: string; product_id: string }>>('v.code', 'v.product_id');
  for (const row of rows) {
    const key = String(row.code).toLowerCase();
    if (!found.has(key)) found.set(key, { productId: String(row.product_id) });
  }
  return found;
}

/** Brands the file introduces, added to the Brands list (`product.brand`) beside the ones already there. */
export async function registerBrands(
  tenantId: string,
  brands: readonly string[],
  listed: ReadonlyArray<{ value: string; sequence: number }>,
  trx: Parameters<typeof customFieldRepo.insertOption>[1],
): Promise<void> {
  const have = new Set(listed.map((option) => option.value.toLowerCase()));
  let sequence = Math.max(0, ...listed.map((option) => option.sequence));
  for (const brand of new Set(brands.map((value) => value.trim()).filter(Boolean))) {
    if (have.has(brand.toLowerCase())) continue;
    have.add(brand.toLowerCase());
    sequence += 1;
    await customFieldRepo.insertOption(
      {
        tenantId,
        listKey: 'product.brand',
        value: brand,
        label: brand,
        hex: null,
        sequence,
        createdBy: null,
      },
      trx,
    );
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** The CHECK constraints the import can still trip, by name, and the token each one means. */
const CHECK_TOKENS: Array<[needle: string, key: ProductImportIssue['messageKey']]> = [
  ['weight', 'validation.product.weightPositive'],
];

/**
 * Read a per-product failure off whatever the database or a repository
 * threw, and report it on every row of the group.
 *
 * The unique partial indexes are the source of truth for a clash — the
 * pre-checks only make the common case say "skipped" instead of "failed" —
 * so a race with a concurrent create lands here and is still named properly.
 */
function classifyGroupFailure(
  error: unknown,
  group: ImportGroup,
  headerFor: (field: ImportField) => string,
): ProductImportIssue[] {
  const pg = error as { code?: string; constraint?: string; message?: string } | null;

  const perRow = (issue: Omit<ProductImportIssue, 'row'>): ProductImportIssue[] =>
    group.rows.map((entry) => ({ row: entry.row, ...issue }));

  // The variant repository has already turned a code clash into the
  // catalogue's own conflict; name the row's code, not the whole set.
  if (error instanceof AppError && error.messageKey === 'error.conflict.productCodeTaken') {
    return group.rows.map((entry) => ({
      row: entry.row,
      kind: 'error',
      column: headerFor('code'),
      messageKey: 'error.conflict.productCodeTaken',
      params: { productCode: entry.input.variant.code },
    }));
  }

  if (pg?.code === '23505') {
    return group.rows.map((entry) => ({
      row: entry.row,
      kind: 'error',
      column: headerFor('code'),
      messageKey: 'error.conflict.productCodeTaken',
      params: { productCode: entry.input.variant.code },
    }));
  }

  if (pg?.code === '23514') {
    const constraint = pg.constraint ?? '';
    const hit = CHECK_TOKENS.find(([needle]) => constraint.includes(needle));
    if (hit) return perRow({ kind: 'error', messageKey: hit[1] });
  }

  if (error instanceof AppError) {
    return perRow({ kind: 'error', messageKey: error.messageKey, params: error.params });
  }

  return perRow({
    kind: 'error',
    messageKey: 'validation.import.rowFailed',
    params: { reason: error instanceof Error ? error.message : String(error) },
  });
}

function finish(partial: {
  dryRun: boolean;
  mode: ProductImportMode;
  /** Selected spreadsheet rows for a per row review apply. When set, rows outside the set are not read, not counted and not written. */
  onlyRows?: number[];
  fileName: string;
  /** SHA-256 of the uploaded file, for the per-row apply to send back. */
  fileHash: string;
  totalRows: number;
  created: number;
  updated: number;
  unchanged: number;
  issues: ProductImportIssue[];
  sample: ProductInput[];
  ignoredColumns: string[];
  formatVersion: number | null;
}): ProductImportResult {
  const sorted = [...partial.issues].sort((a, b) => a.row - b.row);
  const skipped = new Set(
    sorted.filter((issue) => issue.kind === 'skipped').map((issue) => issue.row),
  ).size;
  // Issues are per cell; failures are per row.
  const failed = new Set(sorted.filter((issue) => issue.kind === 'error').map((issue) => issue.row))
    .size;

  return {
    dryRun: partial.dryRun,
    mode: partial.mode,
    fileName: partial.fileName,
    fileHash: partial.fileHash,
    totalRows: partial.totalRows,
    created: partial.created,
    updated: partial.updated,
    unchanged: partial.unchanged,
    skipped,
    failed,
    issues: sorted.slice(0, MAX_PRODUCT_IMPORT_ISSUES),
    issuesTruncated: sorted.length > MAX_PRODUCT_IMPORT_ISSUES,
    ignoredColumns: partial.ignoredColumns,
    formatVersion: partial.formatVersion,
    sample: partial.sample,
  };
}
