/**
 * Bulk party import and export, and the blank template the import starts from
 * (`docs/PARTY_IMPORT_FORMAT.md`; the model is `product-import.service.ts`).
 *
 * One function answers both "what would this file do" (`dryRun`) and "do it",
 * so the preview a person approves and the import that follows cannot disagree
 * about a row. The import re-reads and re-validates the file it is handed — the
 * database may have moved since the preview.
 *
 * **Party Access holds.** An export lists only the parties the caller may
 * view. An update checks `manage` on each row's party, and a code the caller
 * may not even view is reported as unknown — a row's answer must not confirm
 * that somebody else's customer exists. A bulk add skips a name and city that
 * a party outside the caller's scope already holds (`listLivePartyNameCities`
 * deliberately ignores scope).
 *
 * **One change event, not N**: a `party_bulk` event asks every panel for a
 * fresh snapshot once, instead of pushing the file through the change ring.
 *
 * **Online-only, on the Master.** The Office uploads the file over its
 * panel-authenticated HTTP surface, the same path the product import takes.
 */

import type {
  Party,
  PartyImportColumn,
  PartyImportIssue,
  PartyImportMode,
  PartyImportResult,
  PartyInput,
} from '@orderbook/shared';
import {
  columnPatch,
  fieldFor,
  MAX_PARTY_IMPORT_BYTES,
  MAX_PARTY_IMPORT_ISSUES,
  MAX_PARTY_IMPORT_ROWS,
  PARTY_COLUMNS,
  PARTY_IMPORT_COLUMNS,
  PARTY_IMPORT_HEADERS,
  PARTY_SHEET_NAME,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import {
  checkPartyFields,
  findDuplicatesInFile,
  isBlankRow,
  matchPartyHeaders,
  parsePartyRow,
  partyKey,
  templateGuideRows,
  type ParsedPartyRow,
} from '../domain/party-import.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { db } from '../db/knex.js';
import { AppError, ValidationError } from '../lib/errors.js';
import { toCsv } from '../lib/csv.js';
import { createLogger } from '../lib/logger.js';
import {
  buildCsvTemplate,
  buildXlsxTable,
  buildXlsxTemplate,
  readSheetRows,
  XLSX_CONTENT_TYPE,
} from '../lib/spreadsheet.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import { publishChange } from './change-bus.js';
import { requirePartyAccess } from './party-access.service.js';

const log = createLogger('party-import');

type Field = PartyImportColumn['field'];

/** Parties per transaction: large enough to amortise the clock stamp, small enough to lose little on a clash. */
const BATCH = 200;

/** Parties per page when an export reads the book. */
const EXPORT_PAGE = 1000;

const ACCEPTED_EXTENSIONS = new Set(['csv', 'xlsx', 'txt']);

/** Codes, phones, pincodes and GSTINs are text: Excel must not turn `0731…` into a number. */
const TEXT_FIELDS = new Set<Field>(['partyCode', 'phone', 'altPhone', 'pincode', 'gstNumber']);

const WIDTHS: Partial<Record<Field, number>> = {
  partyCode: 12,
  name: 28,
  phone: 16,
  altPhone: 16,
  email: 26,
  addressLine1: 30,
  addressLine2: 30,
  city: 18,
  state: 16,
  pincode: 10,
  gstNumber: 18,
  notes: 36,
};

interface DownloadFile {
  bytes: Buffer;
  contentType: string;
  fileName: string;
}

/** Today as `2026-10-03`, the PC's own date — an export's file name says when it was taken. */
function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const templateColumns = PARTY_IMPORT_COLUMNS.map((column) => ({
  header: column.label,
  width: WIDTHS[column.field] ?? 16,
  text: TEXT_FIELDS.has(column.field),
}));

export async function partyImportTemplate(format: 'csv' | 'xlsx', actor: ActorContext): Promise<DownloadFile> {
  requirePermission(actor, 'parties.bulk');

  if (format === 'csv') {
    return {
      bytes: Buffer.from('\uFEFF' + buildCsvTemplate(PARTY_IMPORT_HEADERS), 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      fileName: 'parties-template.csv',
    };
  }

  const bytes = await buildXlsxTemplate({
    columns: templateColumns,
    guide: [['column', 'required', 'kind', 'note'], ...templateGuideRows()],
    sheetName: PARTY_SHEET_NAME,
  });
  return { bytes, contentType: XLSX_CONTENT_TYPE, fileName: 'parties-template.xlsx' };
}

/** A party as one sheet row, in the template's columns. */
function sheetRow(party: Party): string[] {
  return PARTY_IMPORT_COLUMNS.map((column) =>
    column.field === 'partyCode' ? party.partyCode : (party[column.field] ?? ''),
  );
}

/**
 * The parties the caller may view, in the template's own columns — so an
 * export edited and uploaded back with "update by code" matches every row by
 * its Party Code.
 */
export async function exportParties(format: 'csv' | 'xlsx', actor: ActorContext): Promise<DownloadFile> {
  requirePermission(actor, 'parties.view');

  const scope = resolvePartyScope(actor);
  const rows: string[][] = [];
  for (let offset = 0; ; offset += EXPORT_PAGE) {
    const page = await partyRepo.listParties(actor.tenantId, { limit: EXPORT_PAGE, offset, scope });
    rows.push(...page.items.map(sheetRow));
    if (page.items.length < EXPORT_PAGE || rows.length >= page.total) break;
  }

  await db().transaction((trx) =>
    activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'party_list',
        entityId: actor.tenantId,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { count: rows.length, format },
      },
      actor,
      trx,
    ),
  );

  if (format === 'csv') {
    return {
      bytes: Buffer.from('\uFEFF' + toCsv(PARTY_IMPORT_HEADERS, rows), 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      fileName: `parties-${today()}.csv`,
    };
  }

  const bytes = await buildXlsxTable({ sheetName: PARTY_SHEET_NAME, columns: templateColumns, rows });
  return { bytes, contentType: XLSX_CONTENT_TYPE, fileName: `parties-${today()}.xlsx` };
}

interface ImportFile {
  buffer: Buffer;
  fileName: string;
}

interface ImportOptions {
  dryRun: boolean;
  mode: PartyImportMode;
}

interface UpdateEntry {
  row: number;
  existing: Party;
  /** Only the keys that differ from what the party holds. */
  input: PartyInput;
}

interface CreateEntry {
  row: number;
  input: PartyInput;
}

export async function importParties(
  file: ImportFile,
  options: ImportOptions,
  actor: ActorContext,
): Promise<PartyImportResult> {
  requirePermission(actor, 'parties.bulk');
  requirePermission(actor, options.mode === 'create' ? 'parties.create' : 'parties.edit');

  const extension = file.fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.has(extension)) throw new ValidationError('validation.import.unsupportedFormat');
  if (file.buffer.length > MAX_PARTY_IMPORT_BYTES) throw new ValidationError('validation.import.tooLarge');

  let rows: string[][];
  try {
    rows = await readSheetRows(file.buffer);
  } catch (error) {
    log.warn(`Could not read ${file.fileName}: ${errorText(error)}`);
    throw new ValidationError('validation.import.unreadable');
  }

  const headerIndex = rows.findIndex((row) => !isBlankRow(row));
  if (headerIndex === -1) throw new ValidationError('validation.import.emptyFile');

  const headerRow = (rows[headerIndex] ?? []).map((cell) => cell.trim());
  const match = matchPartyHeaders(headerRow, options.mode);
  const labelOf = (field: Field): string =>
    PARTY_IMPORT_COLUMNS.find((column) => column.field === field)?.label ?? field;
  if (match.missing.length > 0) {
    throw new ValidationError('validation.import.missingColumn', { column: labelOf(match.missing[0] as Field) });
  }
  const headerFor = (field: Field): string => {
    const at = match.byIndex.findIndex((column) => column?.field === field);
    return (at >= 0 ? headerRow[at] : undefined) || labelOf(field);
  };

  if (rows.length - headerIndex - 1 > MAX_PARTY_IMPORT_ROWS) {
    throw new ValidationError('validation.import.tooManyRows', { max: MAX_PARTY_IMPORT_ROWS });
  }

  const issues: PartyImportIssue[] = [];
  const parsed: ParsedPartyRow[] = [];
  let totalRows = 0;

  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    if (isBlankRow(cells)) return;
    totalRows += 1;
    const outcome = parsePartyRow(cells, match, headerRow, headerIndex + 2 + offset, options.mode);
    if (outcome.parsed) parsed.push(outcome.parsed);
    else issues.push(...outcome.issues);
  });

  if (totalRows === 0) throw new ValidationError('validation.import.emptyFile');

  const duplicateIssues = findDuplicatesInFile(parsed, options.mode, headerFor);
  const duplicateRows = new Set(duplicateIssues.map((issue) => issue.row));
  issues.push(...duplicateIssues);
  const candidates = parsed.filter((entry) => !duplicateRows.has(entry.row));

  const creates: CreateEntry[] = [];
  const updates: UpdateEntry[] = [];
  let unchanged = 0;

  if (options.mode === 'create') {
    const taken = new Set(
      (await partyRepo.listLivePartyNameCities(actor.tenantId)).map((party) => partyKey(party.name, party.city)),
    );
    for (const entry of candidates) {
      const checked = checkPartyFields(entry, null, headerFor);
      if (checked.issues.length > 0) {
        issues.push(...checked.issues);
        continue;
      }
      if (taken.has(partyKey(checked.input.name, checked.input.city))) {
        issues.push({
          row: entry.row,
          kind: 'skipped',
          column: headerFor('name'),
          messageKey: 'import.skip.partyExists',
          params: { name: checked.input.name, city: checked.input.city ?? '—' },
        });
        continue;
      }
      creates.push({ row: entry.row, input: checked.input });
    }
  } else {
    const byCode = await partyRepo.findLivePartiesByCodes(
      actor.tenantId,
      candidates.map((entry) => entry.code ?? ''),
    );
    for (const entry of candidates) {
      const code = entry.code ?? '';
      const existing = byCode.get(code.toLowerCase());
      const unknown: PartyImportIssue = {
        row: entry.row,
        kind: 'error',
        column: headerFor('partyCode'),
        messageKey: 'validation.import.partyCodeUnknown',
        params: { code },
      };
      if (!existing) {
        issues.push(unknown);
        continue;
      }

      // A party the caller cannot view is "unknown", not "forbidden": the row's
      // answer must not confirm that somebody else's customer exists.
      if (!(await mayAct(existing.id, 'view', actor))) {
        issues.push(unknown);
        continue;
      }
      if (!(await mayAct(existing.id, 'manage', actor))) {
        issues.push({ ...unknown, messageKey: 'validation.import.partyOutOfScope' });
        continue;
      }

      const checked = checkPartyFields(entry, existing, headerFor);
      if (checked.issues.length > 0) {
        issues.push(...checked.issues);
        continue;
      }

      const changed: Record<string, string> = {};
      for (const [key, value] of Object.entries(checked.input)) {
        if (value !== ((existing as unknown as Record<string, unknown>)[key] ?? null)) changed[key] = value as string;
      }
      if (Object.keys(changed).length === 0) unchanged += 1;
      else updates.push({ row: entry.row, existing, input: changed as unknown as PartyInput });
    }
  }

  const sample = [...creates.map((entry) => entry.input), ...updates.map((entry) => entry.input)].slice(0, 5);

  if (options.dryRun) {
    return finish({
      dryRun: true,
      mode: options.mode,
      fileName: file.fileName,
      totalRows,
      created: creates.length,
      updated: updates.length,
      unchanged,
      issues,
      sample,
      ignoredColumns: match.ignored,
    });
  }

  let created = 0;
  let updated = 0;

  const insert = async (entry: CreateEntry, trx: Parameters<typeof partyRepo.insertParty>[1], hlc: string): Promise<void> => {
    await partyRepo.insertParty(
      {
        tenantId: actor.tenantId,
        input: entry.input,
        createdByUserId: actorUserId(actor),
        hlc,
        fieldHlc: {},
        temporaryId: null,
      },
      trx,
    );
  };

  for (const chunk of chunks(creates, BATCH)) {
    try {
      await db().transaction(async (trx) => {
        const hlc = await nextHlc(trx);
        for (const entry of chunk) await insert(entry, trx, hlc);
      });
      created += chunk.length;
    } catch (error) {
      log.warn(`A chunk of ${chunk.length} parties did not insert as one; replaying one by one: ${errorText(error)}`);
      for (const entry of chunk) {
        try {
          await db().transaction(async (trx) => insert(entry, trx, await nextHlc(trx)));
          created += 1;
        } catch (rowError) {
          issues.push(failureIssue(rowError, entry.row));
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
      log.warn(`A chunk of ${chunk.length} party updates did not apply as one; replaying one by one: ${errorText(error)}`);
      for (const entry of chunk) {
        try {
          await db().transaction(async (trx) => applyUpdate(entry, await nextHlc(trx), actor.tenantId, trx));
          updated += 1;
        } catch (rowError) {
          issues.push(failureIssue(rowError, entry.row));
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
    unchanged,
    issues,
    sample,
    ignoredColumns: match.ignored,
  });

  if (created + updated > 0) {
    await db().transaction((trx) =>
      activityLog.recordActivity(
        {
          tenantId: actor.tenantId,
          entityType: 'party_list',
          entityId: actor.tenantId,
          action: 'imported',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { count: created + updated, fileName: file.fileName, mode: options.mode, created, updated },
        },
        actor,
        trx,
      ),
    );

    publishChange({
      entity: 'party_bulk',
      action: 'updated',
      id: actor.tenantId,
      payload: { created, updated, skipped: result.skipped, failed: result.failed },
    });
  }

  return result;
}

/** Whether `requirePartyAccess` lets the caller act on a party at this level. */
async function mayAct(partyId: string, level: 'view' | 'manage', actor: ActorContext): Promise<boolean> {
  try {
    await requirePartyAccess(partyId, level, actor);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

/**
 * One update inside the caller's transaction, stamping the per-field clocks
 * the way `catalog.service.ts#updateParty` does, so an offline edit to a field
 * this import did not touch still merges instead of being overwritten.
 */
async function applyUpdate(
  entry: UpdateEntry,
  hlc: string,
  tenantId: string,
  trx: Parameters<typeof partyRepo.updateParty>[4],
): Promise<void> {
  const fieldHlc: Record<string, string> = { ...entry.existing.sync.fieldHlc };
  for (const column of Object.keys(columnPatch(entry.input, PARTY_COLUMNS))) {
    fieldHlc[fieldFor(PARTY_COLUMNS, column)] = hlc;
  }
  const row = await partyRepo.updateParty(tenantId, entry.existing.id, entry.input, { hlc, fieldHlc }, trx);
  if (!row) throw new ValidationError('validation.import.partyCodeUnknown', { code: entry.existing.partyCode });
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A per-row failure the pre-checks could not see (a race, a constraint), named on its row. */
function failureIssue(error: unknown, row: number): PartyImportIssue {
  if (error instanceof AppError) return { row, kind: 'error', messageKey: error.messageKey, params: error.params };
  return { row, kind: 'error', messageKey: 'validation.import.rowFailed', params: { reason: errorText(error) } };
}

function finish(partial: {
  dryRun: boolean;
  mode: PartyImportMode;
  fileName: string;
  totalRows: number;
  created: number;
  updated: number;
  unchanged: number;
  issues: PartyImportIssue[];
  sample: PartyInput[];
  ignoredColumns: string[];
}): PartyImportResult {
  const sorted = [...partial.issues].sort((a, b) => a.row - b.row);
  // Issues are per cell; failures are per row.
  const skipped = new Set(sorted.filter((issue) => issue.kind === 'skipped').map((issue) => issue.row)).size;
  const failed = new Set(sorted.filter((issue) => issue.kind === 'error').map((issue) => issue.row)).size;

  return {
    dryRun: partial.dryRun,
    mode: partial.mode,
    fileName: partial.fileName,
    totalRows: partial.totalRows,
    created: partial.created,
    updated: partial.updated,
    unchanged: partial.unchanged,
    skipped,
    failed,
    issues: sorted.slice(0, MAX_PARTY_IMPORT_ISSUES),
    issuesTruncated: sorted.length > MAX_PARTY_IMPORT_ISSUES,
    ignoredColumns: partial.ignoredColumns,
    sample: partial.sample,
  };
}
