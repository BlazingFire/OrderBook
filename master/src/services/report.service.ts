/**
 * Reports (`docs/backend-modules/04-API-CONTRACT.md` §3).
 *
 * **Who may ask, and about whom** is decided here and nowhere else
 * (`shared/src/domain/report-access.ts` states the rule, the screens only
 * read it): `reports.view` (and `reports.export` to export), then the company
 * switch for the caller's tier (`assertReportsVisible`), then the subject
 * (`resolveSubject`) — an administrator may ask about anybody or everybody, the
 * Office and Management tiers about themselves only, whatever the request says.
 * Every query then carries both that owner and the caller's Party Access scope
 * (`report.repository.ts`'s `DateRange`).
 *
 * **Two ways to read a report.** The three legacy kinds keep their typed
 * answers (`dispatchReport`, `leadOutcomeReport`, `topPartiesReport`) for
 * Offices that predate the table API. Every kind — those three included — is
 * also a `ReportTable` (`reportTable`), which is what both panels' screen draws
 * and what an export writes. The legacy CSV is byte-identical to what it always
 * was; the golden strings in `reports.integration.test.ts` pin it.
 */

import type {
  DispatchColourBucket,
  DispatchesReport,
  DispatchMonthBucket,
  LeadOutcome,
  LeadOutcomesReport,
  Locale,
  MessageKey,
  ReportColumn,
  ReportExportOptions,
  ReportKind,
  ReportOptions,
  ReportRange,
  ReportRangeInput,
  ReportRow,
  ReportSubject,
  ReportTable,
  TopCityRow,
  TopPartiesReport,
  TopPartyRow,
} from '@orderbook/shared';
import {
  REPORT_COLUMNS,
  REPORT_EXPORT_CAPS,
  REPORT_META,
  REPORT_TABLE_ROW_CAP,
  SUMMABLE_UNITS,
  isLegacyReportKind,
  isReportFormat,
  mayReportOnOthers,
  reportsVisibleForTier,
  t,
  type ReportQuery,
  type RoleTier,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { renderReportPdf } from '../pdf/table-renderer.js';
import { getSetting } from './settings.service.js';
import { companyFeatures } from './company-features.js';
import { rangeSubtitle, resolveReportRange, type DateComponents } from '../domain/report-range.js';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { toCsv } from '../lib/csv.js';
import { ForbiddenError, ValidationError } from '../lib/errors.js';
import { streamXlsxTable, XLSX_CONTENT_TYPE } from '../lib/spreadsheet.js';
import * as activityLogRepo from '../repositories/activity-log.repository.js';
import * as reportRepo from '../repositories/report.repository.js';

const DEFAULT_TOP_LIMIT = 10;
const MIN_TOP_LIMIT = 5;
const MAX_TOP_LIMIT = 50;

function todayInTimeZone(tz: string): DateComponents {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

function buildRange(input: ReportRangeInput): { range: ReportRange; fromDate: string; toDateExclusive: string } {
  const tz = config.locale.timeZone;
  const resolved = resolveReportRange(input, todayInTimeZone(tz));
  return {
    range: {
      period: resolved.period,
      fromDate: resolved.fromDate,
      toDateExclusive: resolved.toDateExclusive,
      months: resolved.months,
      timeZone: tz,
    },
    fromDate: resolved.fromDate,
    toDateExclusive: resolved.toDateExclusive,
  };
}

function clampTopLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_TOP_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), MIN_TOP_LIMIT), MAX_TOP_LIMIT);
}

// --- Who may ask, and about whom ---------------------------------------------

function tierOf(actor: ActorContext): RoleTier {
  return actor.permissions?.tier ?? 'office';
}

/**
 * Refuse a tier the company has switched Reports off for. An administrator is
 * never switched off. Named, so the screen can say why instead of "forbidden".
 */
export async function assertReportsVisible(actor: ActorContext): Promise<void> {
  if (reportsVisibleForTier(tierOf(actor), await companyFeatures(actor.tenantId))) return;
  throw new ForbiddenError('reports.view', 'error.forbidden.reportsHidden');
}

/**
 * Whose figures this request gets: the owner id every query is restricted to
 * (`null` is everyone) and the subject echoed back.
 *
 * The Office and Management tiers are always themselves — asking for anybody
 * else is refused, not silently answered with their own. An administrator who
 * names nobody gets everyone; one who names somebody gets that live user, and
 * another administrator is a fair subject.
 */
export async function resolveSubject(
  subjectId: string | undefined,
  actor: ActorContext,
): Promise<{ ownerId: string | null; subject: ReportSubject }> {
  if (mayReportOnOthers(tierOf(actor))) {
    if (!subjectId) return { ownerId: null, subject: { id: null, name: null } };
    const found = await reportRepo.findSubject(actor.tenantId, subjectId);
    if (!found) throw new ValidationError('validation.reports.subject.unknown', {}, { field: 'subjectId' });
    return { ownerId: found.id, subject: { id: found.id, name: found.name } };
  }

  // Their own records need to know who "their own" is: a panel acting with no
  // signed-in person has no figures to show, and showing everyone's instead
  // would be the failure this module exists to prevent.
  const self = actorUserId(actor);
  if (!self) throw new ForbiddenError('reports.view', 'validation.reports.subject.forbidden');
  if (subjectId && subjectId !== self) {
    throw new ForbiddenError('reports.view', 'validation.reports.subject.forbidden');
  }
  const found = await reportRepo.findSubject(actor.tenantId, self);
  return { ownerId: self, subject: { id: self, name: found?.name ?? actor.actorName } };
}

/** What the screen needs before it can draw: the kinds on offer, the people to pick from, and whether to offer an export. */
export async function reportOptions(actor: ActorContext): Promise<ReportOptions> {
  requirePermission(actor, 'reports.view');
  await assertReportsVisible(actor);

  const subjects = mayReportOnOthers(tierOf(actor))
    ? (await reportRepo.listSubjects(actor.tenantId)).map((row) => ({ id: row.id, name: row.name }))
    : null;

  return {
    kinds: Object.keys(REPORT_META) as ReportKind[],
    subjects,
    canExport: actorCanExport(actor),
  };
}

function actorCanExport(actor: ActorContext): boolean {
  try {
    requirePermission(actor, 'reports.export');
    return true;
  } catch {
    return false;
  }
}

interface Context {
  dateRange: reportRepo.DateRange;
  range: ReportRange;
  subject: ReportSubject;
}

/** Permission, visibility, subject and range — in that order, so the cheapest refusal comes first. */
async function contextFor(
  input: ReportRangeInput & { subjectId?: string },
  actor: ActorContext,
  permission: 'reports.view' | 'reports.export' = 'reports.view',
): Promise<Context> {
  // An export is a view of a report written to a file: it needs both keys, as
  // it did in 1.2, so a role holding only `reports.export` cannot read figures
  // it cannot open on screen. `reports.view` is checked first, so that is the
  // key a refusal names.
  requirePermission(actor, 'reports.view');
  if (permission === 'reports.export') requirePermission(actor, 'reports.export');
  await assertReportsVisible(actor);
  const { ownerId, subject } = await resolveSubject(input.subjectId, actor);
  const { range, fromDate, toDateExclusive } = buildRange(input);
  return {
    dateRange: { tenantId: actor.tenantId, fromDate, toDateExclusive, scope: resolvePartyScope(actor), ownerId },
    range,
    subject,
  };
}

// --- The three legacy reports, typed ------------------------------------------

async function buildDispatches(ctx: Context): Promise<DispatchesReport> {
  const { range, dateRange } = ctx;
  const [monthRows, colourRows] = await Promise.all([
    reportRepo.dispatchesByMonth(dateRange),
    reportRepo.dispatchesByColour(dateRange),
  ]);

  const byMonth = new Map(monthRows.map((row) => [row.month, row]));
  const months: DispatchMonthBucket[] = range.months.map((month) => {
    const row = byMonth.get(month);
    return { month, orderCount: row?.orderCount ?? 0, boxCount: row?.boxCount ?? 0 };
  });

  const colours: DispatchColourBucket[] = colourRows.map((row) => ({ colour: row.colour, boxCount: row.boxCount }));

  const totals = months.reduce(
    (acc, bucket) => {
      acc.orderCount += bucket.orderCount;
      acc.boxCount += bucket.boxCount;
      return acc;
    },
    { orderCount: 0, boxCount: 0 },
  );

  return { range, months, colours, totals };
}

export async function dispatchReport(input: ReportRangeInput, actor: ActorContext): Promise<DispatchesReport> {
  return buildDispatches(await contextFor(input, actor));
}

const OUTCOMES: readonly LeadOutcome[] = ['converted', 'lost', 'quiet', 'open'];

async function buildLeadOutcomes(ctx: Context, tenantId: string): Promise<LeadOutcomesReport> {
  const { range, dateRange } = ctx;

  // Read once and handed to the SQL classifier, so the number in the query and
  // the number in the caption below are the same number.
  const quietAfterDays = await getSetting(tenantId, 'leads.quietAfterDays');
  const rows = await reportRepo.leadOutcomesByMonth(dateRange, quietAfterDays);

  const byMonth = new Map<string, Record<LeadOutcome, number>>();
  for (const month of range.months) byMonth.set(month, { converted: 0, lost: 0, quiet: 0, open: 0 });
  for (const row of rows) {
    const bucket = byMonth.get(row.month);
    if (bucket) bucket[row.outcome] += row.count;
  }

  const months = range.months.map((month) => ({ month, ...(byMonth.get(month) as Record<LeadOutcome, number>) }));

  const totals: Record<LeadOutcome, number> = { converted: 0, lost: 0, quiet: 0, open: 0 };
  for (const bucket of months) {
    for (const outcome of OUTCOMES) totals[outcome] += bucket[outcome];
  }

  return { range, months, totals, quietAfterDays };
}

export async function leadOutcomeReport(input: ReportRangeInput, actor: ActorContext): Promise<LeadOutcomesReport> {
  return buildLeadOutcomes(await contextFor(input, actor), actor.tenantId);
}

async function buildTopParties(ctx: Context, limitInput: number | undefined): Promise<TopPartiesReport> {
  const { range, dateRange } = ctx;
  const limit = clampTopLimit(limitInput);

  const [partyRows, cityRows] = await Promise.all([
    reportRepo.topPartiesByOrderCount(dateRange, limit),
    reportRepo.topPartiesByCity(dateRange),
  ]);

  const parties: TopPartyRow[] = partyRows.map((row) => ({
    partyId: row.partyId,
    partyName: row.partyName,
    partyCode: row.partyCode,
    city: row.city,
    orderCount: row.orderCount,
  }));

  const cities: TopCityRow[] = cityRows.map((row) => ({
    city: row.city,
    partyCount: row.partyCount,
    orderCount: row.orderCount,
  }));

  return { range, parties, cities, limit };
}

export async function topPartiesReport(
  input: ReportRangeInput & { limit?: number },
  actor: ActorContext,
): Promise<TopPartiesReport> {
  return buildTopParties(await contextFor(input, actor), input.limit);
}

// --- The table every kind answers ---------------------------------------------

/**
 * A catalogue string for a key that is only known as `MessageKey`.
 *
 * The same cast `lib/errors.ts` makes, for the same reason: at this boundary
 * the key is the whole union, so `ParamsFor<K>` cannot be checked per call the
 * way a literal `t('en', 'some.key')` can. Every key reached here is a column
 * or report label with no placeholders — `shared/tests/i18n-coverage.test.ts`
 * is what keeps that true.
 */
function label(key: MessageKey, lang: Locale = 'en', params?: Record<string, string | number>): string {
  return (t as (locale: Locale, key: MessageKey, params?: Record<string, string | number>) => string)(lang, key, params);
}

/** The units the three legacy kinds' export columns never declared, by key. */
const LEGACY_UNITS: Record<string, ReportColumn['unit']> = {
  month: 'text',
  orderCount: 'count',
  boxCount: 'count',
  converted: 'count',
  lost: 'count',
  quiet: 'count',
  open: 'count',
  partyId: 'text',
  partyName: 'text',
  partyCode: 'text',
  city: 'text',
};

/** The columns a table or an export carries: every declared one, with a unit on each. */
function columnsOf(kind: ReportKind): ReportColumn[] {
  return REPORT_COLUMNS[kind].map((column) => ({ ...column, unit: column.unit ?? LEGACY_UNITS[column.key] ?? 'text' }));
}

/** The columns the screen draws: the legacy Top parties id is a key for a program, not a column for a person. */
function screenColumnsOf(kind: ReportKind): ReportColumn[] {
  return columnsOf(kind).filter((column) => !(kind === 'top-parties' && column.key === 'partyId'));
}

interface Rows {
  rows: ReportRow[];
  sections: ReportTable['sections'];
  quietAfterDays?: number;
}

/**
 * The rows of one report, as raw values keyed by column. `cap` is how many the
 * caller can use; the repository is asked for one more so a report that does
 * not fit is known to be cut instead of looking complete.
 */
async function rowsOf(kind: ReportKind, ctx: Context, input: ReportQuery, cap: number, tenantId: string): Promise<Rows> {
  const limit = cap + 1;
  const { dateRange } = ctx;

  switch (kind) {
    case 'dispatches': {
      const report = await buildDispatches(ctx);
      return {
        rows: report.months.map((month) => ({ month: month.month, orderCount: month.orderCount, boxCount: month.boxCount })),
        sections: [
          {
            titleToken: 'reports.dispatches.byColour',
            columns: [
              { key: 'colour', labelToken: 'reports.column.colour', unit: 'text' },
              { key: 'boxCount', labelToken: 'reports.column.boxCount', unit: 'count' },
            ],
            rows: report.colours.map((colour) => ({ colour: colour.colour, boxCount: colour.boxCount })),
          },
        ],
      };
    }
    case 'lead-outcomes': {
      const report = await buildLeadOutcomes(ctx, tenantId);
      return {
        rows: report.months.map((month) => ({
          month: month.month,
          converted: month.converted,
          lost: month.lost,
          quiet: month.quiet,
          open: month.open,
        })),
        sections: [],
        quietAfterDays: report.quietAfterDays,
      };
    }
    case 'top-parties': {
      const report = await buildTopParties(ctx, input.limit);
      return {
        rows: report.parties.map((party) => ({
          partyId: party.partyId,
          partyName: party.partyName,
          partyCode: party.partyCode ?? '',
          city: party.city ?? '',
          orderCount: party.orderCount,
        })),
        sections: [
          {
            titleToken: 'reports.topParties.cities',
            columns: [
              { key: 'city', labelToken: 'reports.column.city', unit: 'text' },
              { key: 'partyCount', labelToken: 'reports.column.parties', unit: 'count' },
              { key: 'orderCount', labelToken: 'reports.column.orderCount', unit: 'count' },
            ],
            rows: report.cities.map((city) => ({ city: city.city ?? '', partyCount: city.partyCount, orderCount: city.orderCount })),
          },
        ],
      };
    }
    case 'by-user':
      return { rows: await reportRepo.byUser(dateRange, limit), sections: [] };
    case 'user-daily':
      return { rows: await reportRepo.userDaily(dateRange, limit), sections: [] };
    case 'by-party':
      return { rows: await reportRepo.byParty(dateRange, limit), sections: [] };
    case 'party-dormant':
      return { rows: await reportRepo.partyDormant(dateRange, limit), sections: [] };
    case 'by-city':
      return { rows: await reportRepo.byCity(dateRange, limit), sections: [] };
    case 'by-product':
      return { rows: await reportRepo.byProduct(dateRange, limit), sections: [] };
    case 'by-variant':
      return { rows: await reportRepo.byVariant(dateRange, limit), sections: [] };
    case 'by-brand':
      return { rows: await reportRepo.byBrand(dateRange, limit), sections: [] };
    case 'stage-ageing':
      return { rows: await reportRepo.stageAgeing(dateRange, limit), sections: [] };
    case 'lead-sources':
      return { rows: await reportRepo.leadSources(dateRange, limit), sections: [] };
    case 'conversion-time':
      return { rows: await reportRepo.conversionTime(dateRange, limit), sections: [] };
    case 'open-pending-orders':
      return { rows: await reportRepo.openPendingOrders(dateRange, limit), sections: [] };
    default:
      throw new ValidationError('validation.reports.kind.unknown', {}, { field: 'report' });
  }
}

/** Sums of the count-like columns, over every row. Null when no column of the report sums. */
function totalsOf(columns: readonly ReportColumn[], rows: readonly ReportRow[]): Record<string, number> | null {
  const summable = columns.filter((column) => column.unit && SUMMABLE_UNITS.includes(column.unit));
  if (summable.length === 0) return null;
  const totals: Record<string, number> = {};
  for (const column of summable) {
    const sum = rows.reduce((running, row) => running + (typeof row[column.key] === 'number' ? (row[column.key] as number) : 0), 0);
    totals[column.key] = Math.round(sum * 1000) / 1000;
  }
  return totals;
}

/** One report as the table both panels draw. */
export async function reportTable(kind: ReportKind, input: ReportQuery, actor: ActorContext): Promise<ReportTable> {
  const ctx = await contextFor(input, actor);
  const loaded = await rowsOf(kind, ctx, input, REPORT_EXPORT_CAPS.csv, actor.tenantId);
  if (loaded.rows.length > REPORT_EXPORT_CAPS.csv) {
    throw new ValidationError('validation.reports.tooManyRows', { max: REPORT_EXPORT_CAPS.csv });
  }

  const columns = screenColumnsOf(kind);
  return {
    kind,
    range: ctx.range,
    subject: ctx.subject,
    columns,
    rows: loaded.rows.slice(0, REPORT_TABLE_ROW_CAP),
    totals: totalsOf(columns, loaded.rows),
    rowCount: loaded.rows.length,
    truncated: loaded.rows.length > REPORT_TABLE_ROW_CAP,
    sections: loaded.sections,
    ...(loaded.quietAfterDays !== undefined ? { quietAfterDays: loaded.quietAfterDays } : {}),
  };
}

// --- Export --------------------------------------------------------------------

/**
 * One exported report, in whichever shape was asked for.
 *
 * A discriminated union rather than an optional `bytes`, because the Office
 * panel forwards this over a socket and has to know which door to send it out
 * of: a CSV becomes a `text/csv` body, a PDF or a workbook becomes a file
 * download. It used to cast the ack to `{ csv: string }` unconditionally and
 * always set `text/csv` — so the moment a second format existed, a PDF would
 * have arrived as a corrupt CSV.
 */
export type ExportedReport =
  | { format: 'csv'; csv: string; rowCount: number }
  | {
      format: 'pdf' | 'xlsx';
      fileName: string;
      contentType: string;
      bytes: Buffer;
      rowCount: number;
    };

/**
 * The columns this export will carry, in order.
 *
 * A `columns` list narrows and reorders; an unknown key is ignored rather than
 * refused, so a bookmarked URL keeps working when a column is renamed. Asking
 * for nothing recognisable falls back to everything, because an empty
 * spreadsheet is never what somebody meant.
 */
function chosenColumns(kind: ReportKind, requested: string[] | undefined): ReportColumn[] {
  const all = columnsOf(kind);
  if (!requested || requested.length === 0) return all;

  const picked = requested
    .map((key) => all.find((column) => column.key === key))
    .filter((column): column is ReportColumn => column !== undefined);

  return picked.length > 0 ? picked : all;
}

/** A figure as a person reads it in a PDF cell: no trailing zeros, no float noise. */
function printed(value: unknown, column: ReportColumn): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'number') return String(value);
  const text = String(Math.round(value * 1000) / 1000);
  return column.unit === 'percent' ? `${text}%` : text;
}

/** A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`. */
function sheetNameOf(title: string): string {
  const cleaned = title.replace(/[\][:*?/\\]/g, ' ').trim();
  return (cleaned || 'Report').slice(0, 31);
}

type NormalizedExportOptions = Required<Omit<ReportExportOptions, 'columns'>> & Pick<ReportExportOptions, 'columns'>;

/**
 * What an export asked for, read defensively. The socket and the REST route both
 * hand over what a client sent; anything that is not a known value becomes the
 * default instead of reaching a lookup (`REPORT_EXPORT_CAPS[format]`) or a
 * renderer. Defaults reproduce the byte-identical CSV of every column.
 */
export function normalizeExportOptions(raw: unknown): NormalizedExportOptions {
  const src = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    format: isReportFormat(src.format) ? src.format : 'csv',
    columns: Array.isArray(src.columns) ? src.columns.filter((key): key is string => typeof key === 'string') : undefined,
    totals: src.totals === true,
    paperSize: src.paperSize === 'letter' ? 'letter' : 'a4',
    orientation: src.orientation === 'portrait' ? 'portrait' : 'landscape',
    lang: src.lang === 'hi' ? 'hi' : 'en',
  };
}

export async function exportReport(
  kind: ReportKind,
  rawInput: ReportQuery & ReportExportOptions,
  actor: ActorContext,
): Promise<ExportedReport> {
  const input = { ...rawInput, ...normalizeExportOptions(rawInput) };
  const ctx = await contextFor(input, actor, 'reports.export');
  const format = input.format;
  const cap = REPORT_EXPORT_CAPS[format];

  const loaded = await rowsOf(kind, ctx, input, cap, actor.tenantId);
  if (loaded.rows.length > cap) throw new ValidationError('validation.reports.tooManyRows', { max: cap });

  const rows = loaded.rows;
  const columns = chosenColumns(kind, input.columns);

  const cell = (row: ReportRow, column: ReportColumn): string | number => {
    const value = row[column.key];
    return value === null || value === undefined ? '' : value;
  };

  const body = rows.map((row) => columns.map((column) => cell(row, column)));

  /*
   * A totals row, when asked for. Only the numeric columns sum — a total of a
   * month name is nonsense.
   */
  let totals: Array<string | number> | undefined;
  if (input.totals) {
    // The label goes in the first column that cannot hold a number, not
    // unconditionally in position 0 — `?columns=` can narrow and reorder the
    // list, and a caller who puts a numeric column first would
    // otherwise have its grand total silently replaced with the word
    // "Totals". Computed once, outside the map, so exactly one cell gets the
    // label even when several columns qualify; -1 (no safe column at all)
    // leaves every cell to fall through to the sum/blank logic below.
    // The three legacy kinds sum every numeric column, as they always did. The
    // others sum only the additive units (`SUMMABLE_UNITS`): a total of days or
    // of percentages is a number nobody can use.
    const legacy = isLegacyReportKind(kind);
    const sums = (column: ReportColumn): boolean =>
      rows.some((row) => typeof row[column.key] === 'number') &&
      (legacy || (column.unit !== undefined && SUMMABLE_UNITS.includes(column.unit)));
    const labelIndex = columns.findIndex((column) => !sums(column));

    totals = columns.map((column, index) => {
      if (index === labelIndex) return label('reports.export.totals', input.lang);
      if (!sums(column)) return '';

      const sum = rows.reduce((running, row) => {
        const value = row[column.key];
        return typeof value === 'number' ? running + value : running;
      }, 0);

      return legacy ? sum : Math.round(sum * 1000) / 1000;
    });
  }

  await db().transaction((trx) =>
    activityLogRepo.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'report',
        entityId: kind,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          report: kind,
          from: ctx.range.fromDate,
          to: ctx.range.toDateExclusive,
          rowCount: rows.length,
          format,
          // Null is everyone.
          subjectId: ctx.subject.id,
        },
      },
      actor,
      trx,
    ),
  );

  if (format === 'csv') {
    // Header keys, not translated labels: the default output has to stay
    // byte-identical to what it was, because somebody's spreadsheet is pointing
    // at it.
    const csv = toCsv(
      columns.map((column) => column.key),
      totals ? [...body, totals] : body,
    );
    // The new kinds carry names in any script, and Excel reads a BOM-less file as
    // ANSI; the three legacy kinds stay byte-identical to what they always were.
    return { format: 'csv', csv: isLegacyReportKind(kind) ? csv : `\uFEFF${csv}`, rowCount: rows.length };
  }

  const lang: Locale = input.lang ?? 'en';
  const title = label(REPORT_META[kind].titleToken, lang);

  if (format === 'xlsx') {
    const bytes = await streamXlsxTable({
      sheetName: sheetNameOf(title),
      columns: columns.map((column) => ({ header: label(column.labelToken, lang), width: column.unit === 'text' ? 26 : 16 })),
      rows: totals ? [...body, totals] : body,
    });
    return { format: 'xlsx', fileName: `${kind}.xlsx`, contentType: XLSX_CONTENT_TYPE, bytes, rowCount: rows.length };
  }

  const bytes = await renderReportPdf({
    title,
    subtitle: rangeSubtitle(ctx.range.fromDate, ctx.range.toDateExclusive),
    preamble: ctx.subject.name ? [label('reports.generatedFor', lang, { name: ctx.subject.name })] : undefined,
    columns: columns.map((column) => ({
      label: label(column.labelToken, lang),
      numeric: column.unit !== 'text' && column.unit !== 'date',
    })),
    rows: body.map((row) => row.map((value, index) => printed(value, columns[index] as ReportColumn))),
    totals: totals?.map((value, index) => printed(value, columns[index] as ReportColumn)),
    paperSize: input.paperSize ?? 'a4',
    orientation: input.orientation ?? 'landscape',
  });

  return {
    format: 'pdf',
    fileName: `${kind}.pdf`,
    contentType: 'application/pdf',
    bytes,
    rowCount: rows.length,
  };
}
