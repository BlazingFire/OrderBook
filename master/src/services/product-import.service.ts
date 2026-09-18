/**
 * Bulk product import from a spreadsheet, and the blank template it starts from.
 *
 * One function answers both "what would this file do" (`dryRun`) and "do it",
 * so the preview a person approves and the import that follows cannot disagree
 * about a row. The import re-reads and re-validates the file it is handed —
 * the database may have moved since the preview — and its result is the one
 * the screen shows.
 *
 * **Writes go through the repositories in chunks, not through `createProduct`
 * five thousand times.** The single-product path costs two transactions, two
 * row locks and a socket fan-out per product; here each chunk of `BATCH` rows
 * takes one clock stamp, one block of ids, one category pass and one INSERT.
 * A chunk that fails is replayed row by row through the existing single-row
 * repository calls, so one clashing code costs that chunk its fast path and
 * costs the file nothing — the other rows land and the bad one is reported by
 * number.
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

import type {
  ProductImportIssue,
  ProductImportMode,
  ProductImportResult,
  ProductInput,
  Product,
} from '@orderbook/shared';
import { columnPatch, fieldFor, MAX_PRODUCT_IMPORT_ISSUES, PRODUCT_COLUMNS } from '@orderbook/shared';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import {
  findDuplicatesInFile,
  IMPORT_COLUMNS,
  IMPORT_HEADERS,
  isBlankRow,
  matchHeaders,
  parseImportRow,
  templateGuideRows,
  type ImportField,
  type ParsedRow,
} from '../domain/product-import.js';
import { canEditCost, canEditRates } from '../domain/visibility.js';
import { db } from '../db/knex.js';
import { AppError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { buildCsvTemplate, buildXlsxTemplate, XLSX_CONTENT_TYPE } from '../lib/spreadsheet.js';
import { readSheetRows } from '../lib/spreadsheet.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { allocatePermanentIds, nextHlc } from '../repositories/identity.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { publishChange } from './change-bus.js';
import { getSetting } from './settings.service.js';

const log = createLogger('product-import');

/** Rows per transaction. Large enough to amortise the locks, small enough to lose little on a clash. */
const BATCH = 500;

const ACCEPTED_EXTENSIONS = new Set(['csv', 'xlsx', 'txt']);

/** Width of each template column, in Excel character units. */
const TEMPLATE_WIDTHS: Partial<Record<ImportField, number>> = {
  productCode: 14,
  name: 36,
  alias: 18,
  categoryName: 18,
  productType: 14,
  brand: 14,
  series: 16,
  size: 12,
  barcode: 16,
  application: 14,
  surfaceTexture: 16,
  originPlant: 16,
};

const TEXT_COLUMNS = new Set<ImportField>(['productCode', 'barcode', 'hsnCode']);

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
    columns: IMPORT_COLUMNS.map((column) => ({
      header: column.field,
      width: TEMPLATE_WIDTHS[column.field] ?? 12,
      text: TEXT_COLUMNS.has(column.field),
      values: column.values,
    })),
    guide: [['column', 'required', 'kind', 'allowed values', 'note'], ...templateGuideRows(mayCreateCategories)],
  });

  return { bytes, contentType: XLSX_CONTENT_TYPE, fileName: 'products-template.xlsx' };
}

interface ImportFile {
  buffer: Buffer;
  fileName: string;
}

interface ImportOptions {
  dryRun: boolean;
  mode: ProductImportMode;
}

type UpdateRow = ParsedRow & { existing: Product };

export async function importProducts(
  file: ImportFile,
  options: ImportOptions,
  actor: ActorContext,
): Promise<ProductImportResult> {
  requirePermission(actor, 'products.bulk');
  requirePermission(actor, 'products.create');
  if (options.mode === 'upsert') requirePermission(actor, 'products.edit');

  const extension = file.fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    throw new ValidationError('validation.import.unsupportedFormat');
  }

  let rows: string[][];
  try {
    rows = await readSheetRows(file.buffer);
  } catch (error) {
    log.warn(`Could not read ${file.fileName}: ${error instanceof Error ? error.message : String(error)}`);
    throw new ValidationError('validation.import.unreadable');
  }

  const headerIndex = rows.findIndex((row) => !isBlankRow(row));
  if (headerIndex === -1) throw new ValidationError('validation.import.emptyFile');

  const headerRow = (rows[headerIndex] ?? []).map((cell) => cell.trim());
  const match = matchHeaders(headerRow);
  if (match.missing.length > 0) {
    throw new ValidationError('validation.import.missingColumn', { column: match.missing[0] as string });
  }

  const headerFor = (field: ImportField): string => {
    const at = match.byIndex.findIndex((column) => column?.field === field);
    return (at >= 0 ? headerRow[at] : undefined) || field;
  };

  const allowed = { rates: canEditRates(actor), cost: canEditCost(actor) };
  const issues: ProductImportIssue[] = [];
  const parsed: ParsedRow[] = [];
  let totalRows = 0;

  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    if (isBlankRow(cells)) return;
    totalRows += 1;
    const row = headerIndex + 2 + offset;
    const outcome = parseImportRow(cells, match, headerRow, row, allowed);
    if (outcome.input) parsed.push({ row, input: outcome.input });
    else issues.push(...outcome.issues);
  });

  if (totalRows === 0) throw new ValidationError('validation.import.emptyFile');

  const duplicateIssues = findDuplicatesInFile(parsed, headerFor);
  const duplicateRows = new Set(duplicateIssues.map((issue) => issue.row));
  issues.push(...duplicateIssues);
  const candidates = parsed.filter((entry) => !duplicateRows.has(entry.row));

  // A blank code means "give me one". Assigned before the clash check so a
  // generated code that collides with a hand-typed one in the same file is
  // caught here rather than by the database.
  const blank = candidates.filter((entry) => entry.input.productCode === '');
  if (blank.length > 0) {
    const codes = await productRepo.nextProductCodes(blank.length);
    blank.forEach((entry, index) => {
      entry.input = { ...entry.input, productCode: codes[index] as string };
    });
  }

  const existing = await productRepo.findLiveByCodes(
    actor.tenantId,
    candidates.map((entry) => entry.input.productCode),
  );

  let creates: ParsedRow[] = [];
  let updates: UpdateRow[] = [];
  for (const entry of candidates) {
    const hit = existing.get(entry.input.productCode.toLowerCase());
    if (!hit) {
      creates.push(entry);
    } else if (options.mode === 'upsert') {
      updates.push({ ...entry, existing: hit });
    } else {
      issues.push({
        row: entry.row,
        kind: 'skipped',
        column: headerFor('productCode'),
        messageKey: 'import.skip.codeExists',
        params: { productCode: entry.input.productCode },
      });
    }
  }

  // Barcodes are unique across live products too. For an update, the product
  // being updated is allowed to already hold its own barcode.
  const barcodeOwner = await productRepo.findLiveBarcodes(
    actor.tenantId,
    [...creates, ...updates].map((entry) => entry.input.barcode ?? '').filter(Boolean),
  );
  const barcodeTaken = (entry: ParsedRow, ownId: string | null): boolean => {
    const barcode = (entry.input.barcode ?? '').trim().toLowerCase();
    if (!barcode) return false;
    const owner = barcodeOwner.get(barcode);
    return owner !== undefined && owner !== ownId;
  };
  const refuseBarcode = (entry: ParsedRow): void => {
    issues.push({
      row: entry.row,
      kind: 'error',
      column: headerFor('barcode'),
      messageKey: 'error.conflict.barcodeTaken',
      params: { barcode: entry.input.barcode ?? '' },
    });
  };
  creates = creates.filter((entry) => {
    if (!barcodeTaken(entry, null)) return true;
    refuseBarcode(entry);
    return false;
  });
  updates = updates.filter((entry) => {
    if (!barcodeTaken(entry, entry.existing.id)) return true;
    refuseBarcode(entry);
    return false;
  });

  // A category the file names but the company does not have.
  //
  // Settled **here**, above the dry-run boundary, for the reason this file's
  // header gives: one function answers "what would this file do" and "do it",
  // so a preview that says "ok" and a commit that refuses would be the defect.
  // A row with no category column, or a blank cell, never reaches this — a
  // blank cell leaves the key absent (`domain/product-import.ts`).
  const mayCreateCategories = await getSetting(actor.tenantId, 'catalog.importCreatesCategories');
  let knownCategories = new Map<string, string>();
  if (!mayCreateCategories) {
    knownCategories = new Map(
      (await productRepo.listCategories(actor.tenantId)).map((category) => [
        category.name.trim().toLowerCase(),
        category.id,
      ]),
    );

    // Refused, not filed under no category: the same rule a price column the
    // actor may not set already follows — a success that discarded what the
    // file asserted is the worst answer available.
    const unknownCategory = (entry: ParsedRow): boolean => {
      const name = entry.input.categoryName?.trim();
      return name !== undefined && name !== '' && !knownCategories.has(name.toLowerCase());
    };
    const refuseCategory = (entry: ParsedRow): void => {
      issues.push({
        row: entry.row,
        kind: 'error',
        column: headerFor('categoryName'),
        messageKey: 'validation.import.unknownCategory',
        params: { categoryName: entry.input.categoryName ?? '' },
      });
    };
    creates = creates.filter((entry) => {
      if (!unknownCategory(entry)) return true;
      refuseCategory(entry);
      return false;
    });
    updates = updates.filter((entry) => {
      if (!unknownCategory(entry)) return true;
      refuseCategory(entry);
      return false;
    });
  }

  const sample = [...creates, ...updates]
    .sort((a, b) => a.row - b.row)
    .slice(0, 5)
    .map((entry) => entry.input);

  if (options.dryRun) {
    return finish({
      dryRun: true,
      mode: options.mode,
      fileName: file.fileName,
      totalRows,
      created: creates.length,
      updated: updates.length,
      issues,
      sample,
      ignoredColumns: match.ignored,
    });
  }

  let created = 0;
  let updated = 0;

  for (const chunk of chunks(creates, BATCH)) {
    try {
      await db().transaction(async (trx) => {
        const hlc = await nextHlc(trx);
        const ids = await allocatePermanentIds(actor.tenantId, 'product', chunk.length, trx);
        // While the switch is off the creating call is not made at all, rather
        // than made and trusted to find everything: every surviving row's name
        // is already in `knownCategories`, and nothing in this product deletes
        // a category, so the ids stay good between the check and this insert.
        const categories = mayCreateCategories
          ? await productRepo.ensureCategories(
              actor.tenantId,
              chunk.map((entry) => entry.input.categoryName ?? '').filter(Boolean),
              trx,
            )
          : knownCategories;
        await productRepo.insertProductRows(
          chunk.map((entry, index) => ({
            id: ids[index] as string,
            input: entry.input,
            categoryId: entry.input.categoryName
              ? (categories.get(entry.input.categoryName.trim().toLowerCase()) ?? null)
              : null,
          })),
          { tenantId: actor.tenantId, hlc },
          trx,
        );
      });
      created += chunk.length;
    } catch (error) {
      log.warn(
        `A chunk of ${chunk.length} products did not insert as one; replaying row by row: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const entry of chunk) {
        try {
          await db().transaction(async (trx) => {
            const hlc = await nextHlc(trx);
            await productRepo.insertProduct(
              { tenantId: actor.tenantId, input: entry.input, hlc, fieldHlc: {}, temporaryId: null },
              trx,
            );
          });
          created += 1;
        } catch (rowError) {
          issues.push(classifyRowFailure(rowError, entry, headerFor));
        }
      }
    }
  }

  for (const chunk of chunks(updates, BATCH)) {
    try {
      await db().transaction(async (trx) => {
        const hlc = await nextHlc(trx);
        for (const entry of chunk) await applyUpdate(entry, hlc, actor.tenantId, trx);
      });
      updated += chunk.length;
    } catch (error) {
      log.warn(
        `A chunk of ${chunk.length} product updates did not apply as one; replaying row by row: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const entry of chunk) {
        try {
          await db().transaction(async (trx) => {
            const hlc = await nextHlc(trx);
            await applyUpdate(entry, hlc, actor.tenantId, trx);
          });
          updated += 1;
        } catch (rowError) {
          issues.push(classifyRowFailure(rowError, entry, headerFor));
        }
      }
    }
  }

  const result = finish({
    dryRun: false,
    mode: options.mode,
    fileName: file.fileName,
    totalRows,
    created,
    updated,
    issues,
    sample,
    ignoredColumns: match.ignored,
  });

  if (created + updated > 0) {
    await db().transaction((trx) =>
      activityLog.recordActivity(
        {
          tenantId: actor.tenantId,
          entityType: 'catalog',
          entityId: actor.tenantId,
          action: 'imported',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { count: created + updated, fileName: file.fileName },
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

  return result;
}

/**
 * One update inside the caller's transaction, stamping the per-field clocks
 * the way `catalog.service.ts#updateProduct` does — so an offline edit to a
 * field this import did not touch still merges instead of being overwritten.
 */
async function applyUpdate(
  entry: UpdateRow,
  hlc: string,
  tenantId: string,
  trx: Parameters<typeof productRepo.updateProduct>[4],
): Promise<void> {
  const touched = Object.keys(columnPatch(entry.input, PRODUCT_COLUMNS));
  const fieldHlc = { ...entry.existing.sync.fieldHlc };
  for (const column of touched) fieldHlc[fieldFor(PRODUCT_COLUMNS, column)] = hlc;

  await productRepo.updateProduct(tenantId, entry.existing.id, entry.input, { hlc, fieldHlc }, trx);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** The CHECK constraints the import can still trip, by name, and the token each one means. */
const CHECK_TOKENS: Array<[needle: string, key: ProductImportIssue['messageKey']]> = [
  ['uom', 'validation.product.uom'],
  ['edge_type', 'validation.product.edgeType'],
  ['application', 'validation.product.application'],
  ['pei_rating', 'validation.product.peiRating'],
  ['gst_rate_pct', 'validation.product.percentage'],
  ['water_absorption_pct', 'validation.product.percentage'],
  ['mrp', 'validation.product.negativeAmount'],
  ['purchase_rate', 'validation.product.negativeAmount'],
];

/**
 * Read a per-row failure off whatever the database or a repository threw.
 *
 * The unique partial indexes are the source of truth for a clash — the
 * pre-checks only make the common case say "skipped" instead of "failed" —
 * so a race with a concurrent create lands here and is still named properly.
 */
function classifyRowFailure(
  error: unknown,
  entry: ParsedRow,
  headerFor: (field: ImportField) => string,
): ProductImportIssue {
  const pg = error as { code?: string; constraint?: string; message?: string } | null;

  if (pg?.code === '23505') {
    if ((pg.constraint ?? '').includes('barcode')) {
      return {
        row: entry.row,
        kind: 'error',
        column: headerFor('barcode'),
        messageKey: 'error.conflict.barcodeTaken',
        params: { barcode: entry.input.barcode ?? '' },
      };
    }
    return {
      row: entry.row,
      kind: 'error',
      column: headerFor('productCode'),
      messageKey: 'error.conflict.productCodeTaken',
      params: { productCode: entry.input.productCode },
    };
  }

  if (pg?.code === '23514') {
    const constraint = pg.constraint ?? '';
    const hit = CHECK_TOKENS.find(([needle]) => constraint.includes(needle));
    if (hit) return { row: entry.row, kind: 'error', messageKey: hit[1] };
  }

  if (error instanceof AppError) {
    return { row: entry.row, kind: 'error', messageKey: error.messageKey, params: error.params };
  }

  return {
    row: entry.row,
    kind: 'error',
    messageKey: 'validation.import.rowFailed',
    params: { reason: error instanceof Error ? error.message : String(error) },
  };
}

function finish(partial: {
  dryRun: boolean;
  mode: ProductImportMode;
  fileName: string;
  totalRows: number;
  created: number;
  updated: number;
  issues: ProductImportIssue[];
  sample: ProductInput[];
  ignoredColumns: string[];
}): ProductImportResult {
  const sorted = [...partial.issues].sort((a, b) => a.row - b.row);
  const skipped = sorted.filter((issue) => issue.kind === 'skipped').length;
  // Issues are per cell; failures are per row.
  const failed = new Set(sorted.filter((issue) => issue.kind === 'error').map((issue) => issue.row)).size;

  return {
    dryRun: partial.dryRun,
    mode: partial.mode,
    fileName: partial.fileName,
    totalRows: partial.totalRows,
    created: partial.created,
    updated: partial.updated,
    skipped,
    failed,
    issues: sorted.slice(0, MAX_PRODUCT_IMPORT_ISSUES),
    issuesTruncated: sorted.length > MAX_PRODUCT_IMPORT_ISSUES,
    ignoredColumns: partial.ignoredColumns,
    sample: partial.sample,
  };
}
