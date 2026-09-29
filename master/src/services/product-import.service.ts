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

import type {
  Product,
  ProductImportIssue,
  ProductImportMode,
  ProductImportResult,
  ProductInput,
  ProductVariantInput,
} from '@orderbook/shared';
import { columnPatch, fieldFor, MAX_PRODUCT_IMPORT_ISSUES, PRODUCT_COLUMNS } from '@orderbook/shared';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import {
  findDuplicatesInFile,
  groupImportRows,
  IMPORT_COLUMNS,
  IMPORT_HEADERS,
  isBlankRow,
  matchHeaders,
  parseImportRow,
  templateGuideRows,
  type ImportField,
  type ImportGroup,
  type ParsedRow,
} from '../domain/product-import.js';
import { db } from '../db/knex.js';
import { AppError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { buildCsvTemplate, buildXlsxTemplate, XLSX_CONTENT_TYPE } from '../lib/spreadsheet.js';
import { readSheetRows } from '../lib/spreadsheet.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { allocatePermanentIds, nextHlc } from '../repositories/identity.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
import { publishChange } from './change-bus.js';
import { getSetting } from './settings.service.js';

const log = createLogger('product-import');

/** Products per transaction. Large enough to amortise the locks, small enough to lose little on a clash. */
const BATCH = 500;

const ACCEPTED_EXTENSIONS = new Set(['csv', 'xlsx', 'txt']);

/** Width of each template column, in Excel character units. */
const TEMPLATE_WIDTHS: Partial<Record<ImportField, number>> = {
  categoryName: 22,
  name: 28,
  variant: 20,
  code: 14,
  weightKg: 12,
  alias: 18,
  size: 18,
  multiColour: 12,
};

const TEXT_COLUMNS = new Set<ImportField>(['code']);

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
      ...(column.kind === 'boolean' ? { values: ['yes', 'no'] } : {}),
    })),
    guide: [['column', 'required', 'kind', 'note'], ...templateGuideRows(mayCreateCategories)],
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

type UpdateGroup = ImportGroup & { existing: Product };

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

  const issues: ProductImportIssue[] = [];
  const parsed: ParsedRow[] = [];
  let totalRows = 0;

  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    if (isBlankRow(cells)) return;
    totalRows += 1;
    const row = headerIndex + 2 + offset;
    const outcome = parseImportRow(cells, match, headerRow, row);
    if (outcome.input) parsed.push({ row, input: outcome.input });
    else issues.push(...outcome.issues);
  });

  if (totalRows === 0) throw new ValidationError('validation.import.emptyFile');

  const duplicateIssues = findDuplicatesInFile(parsed, headerFor);
  const duplicateRows = new Set(duplicateIssues.map((issue) => issue.row));
  issues.push(...duplicateIssues);

  const grouped = groupImportRows(
    parsed.filter((entry) => !duplicateRows.has(entry.row)),
    headerFor,
  );
  issues.push(...grouped.issues);

  // Which of the file's codes are already on a live variant — and on which
  // product. A group whose codes all sit on one product is that product
  // (update, or skipped); codes split across products cannot be reconciled.
  const existingByCode = await productVariantRepo.findLiveVariantsByCodes(
    actor.tenantId,
    grouped.groups.flatMap((group) => group.input.variants?.map((variant) => variant.code) ?? []),
  );
  const existingIds = new Set([...existingByCode.values()].map((hit) => hit.productId));
  const existingProducts = await productRepo.findProductsByIds(actor.tenantId, [...existingIds]);

  let creates: ImportGroup[] = [];
  let updates: UpdateGroup[] = [];
  for (const group of grouped.groups) {
    const owners = new Set<string>();
    for (const variant of group.input.variants ?? []) {
      const hit = existingByCode.get(variant.code.toLowerCase());
      if (hit) owners.add(hit.productId);
    }

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
      updates.push({ ...group, existing });
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
  const liveCategories = await productRepo.listCategories(actor.tenantId);
  const categoryCodeOf = (group: ImportGroup): string | null =>
    group.input.categoryCode?.trim() || null;
  const existingCategoryOf = (group: ImportGroup): string | undefined => {
    const code = categoryCodeOf(group)?.toLowerCase();
    if (code) return liveCategories.find((category) => category.code?.toLowerCase() === code)?.id;
    const name = group.input.categoryName?.trim().toLowerCase();
    if (!name) return undefined;
    const brand = group.input.categoryBrand?.trim().toLowerCase() || null;
    const named = liveCategories.filter(
      (category) =>
        category.name.trim().toLowerCase() === name &&
        (brand === null || category.brand?.trim().toLowerCase() === brand),
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

  const sample = [...creates, ...updates]
    .sort((a, b) => (a.rows[0]?.row ?? 0) - (b.rows[0]?.row ?? 0))
    .slice(0, 5)
    .map((group) => group.input);

  if (options.dryRun) {
    return finish({
      dryRun: true,
      mode: options.mode,
      fileName: file.fileName,
      totalRows,
      created: rowCount(creates),
      updated: rowCount(updates),
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
        // Only a name nothing matched above is left to create, and while the
        // switch is off the creating call is not made at all, rather than made
        // and trusted to find everything: every surviving group was matched.
        // A product binned between that check and this insert is the one gap
        // left; the chunk then files the sub product under it, as before.
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
            await productRepo.insertProduct(
              { tenantId: actor.tenantId, input: group.input, hlc, fieldHlc: {}, temporaryId: null },
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

  for (const chunk of chunks(updates, BATCH)) {
    try {
      await db().transaction(async (trx) => {
        const hlc = await nextHlc(trx);
        for (const group of chunk) await applyUpdate(group, hlc, actor.tenantId, trx);
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
            await applyUpdate(group, hlc, actor.tenantId, trx);
          });
          updated += group.rows.length;
        } catch (rowError) {
          issues.push(...classifyGroupFailure(rowError, group, headerFor));
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
 *
 * The file's rows are folded into the product's existing variant set rather
 * than replacing it: a sheet naming three of DAMRU's forty codes must
 * not delete the other thirty-seven. A row matches an existing variant by
 * code, else by label, else it is a new variant.
 */
async function applyUpdate(
  group: UpdateGroup,
  hlc: string,
  tenantId: string,
  trx: Parameters<typeof productRepo.updateProduct>[4],
): Promise<void> {
  const merged: ProductVariantInput[] = group.existing.variants.map((variant) => ({
    id: variant.id,
    code: variant.code,
    label: variant.label,
    weightKg: variant.weightKg,
  }));

  for (const incoming of group.input.variants ?? []) {
    const byCode = merged.find((variant) => variant.code.toLowerCase() === incoming.code.toLowerCase());
    const byLabel = merged.find(
      (variant) => (variant.label ?? '').toLowerCase() === (incoming.label ?? '').toLowerCase(),
    );
    const target = byCode ?? byLabel;
    if (target) {
      target.code = incoming.code;
      target.label = incoming.label ?? null;
      if (incoming.weightKg !== undefined && incoming.weightKg !== null) target.weightKg = incoming.weightKg;
    } else {
      merged.push({ code: incoming.code, label: incoming.label ?? null, weightKg: incoming.weightKg ?? null });
    }
  }

  const hasVariants = group.existing.hasVariants || Boolean(group.input.hasVariants);
  const input: ProductInput = {
    ...group.input,
    hasVariants,
    variants: merged.map((variant, index) => ({
      ...variant,
      // A one-form product that a sheet now gives colours: its single
      // unlabelled row is the plain member, and needs a name to keep.
      label: hasVariants ? (variant.label ?? 'Standard') : null,
      sequence: index + 1,
    })),
  };

  const touched = Object.keys(columnPatch(input, PRODUCT_COLUMNS));
  const fieldHlc: Record<string, string> = { ...group.existing.sync.fieldHlc, variants: hlc };
  for (const column of touched) fieldHlc[fieldFor(PRODUCT_COLUMNS, column)] = hlc;

  await productRepo.updateProduct(tenantId, group.existing.id, input, { hlc, fieldHlc }, trx);
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
  fileName: string;
  totalRows: number;
  created: number;
  updated: number;
  issues: ProductImportIssue[];
  sample: ProductInput[];
  ignoredColumns: string[];
}): ProductImportResult {
  const sorted = [...partial.issues].sort((a, b) => a.row - b.row);
  const skipped = new Set(sorted.filter((issue) => issue.kind === 'skipped').map((issue) => issue.row)).size;
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
