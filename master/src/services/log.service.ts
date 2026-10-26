/**
 * Logs — `listLogs`, `listLogFacets`, `verifyLogChain`, `exportLogs`
 * (`docs/backend-modules/04-API-CONTRACT.md` §2). Body order per house
 * style: permission, then validate, then repository, then map.
 */

import type {
  ActivityLogEntry,
  ActivityLogFacets,
  ActivityLogQuery,
  ChainVerification,
  ChainVerifyInput,
  CursorPage,
  Translator,
} from '@orderbook/shared';
import { createTranslator, renderActivity } from '@orderbook/shared';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { clampLogPage, decodeLogCursor, encodeLogCursor } from '../domain/log-cursor.js';
import { db } from '../db/knex.js';
import { csvLinesViaRust, toCsvViaRust } from '../lib/csv-via-rust.js';
import { ValidationError } from '../lib/errors.js';
import * as activityLogRepo from '../repositories/activity-log.repository.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^\d+$/;

const DEFAULT_VERIFY_LIMIT = 10_000;
const MAX_VERIFY_LIMIT = 200_000;

const EXPORT_BATCH_SIZE = 5_000;

type ExportLimits = { maxRows: number; maxBytes: number };

/**
 * The Master's own download. The row cap is the 1.2 one; the byte cap keeps
 * the in-memory file well inside a low-RAM PC now that each row also carries
 * a rendered sentence and its details as JSON.
 */
export const HTTP_EXPORT_LIMITS: ExportLimits = { maxRows: 250_000, maxBytes: 128 * 1024 * 1024 };

/**
 * An Office export travels back as one Socket.IO ack, and the ws client drops
 * the whole Master connection on a frame over 100 MiB. The ack is JSON, which
 * writes each quote, backslash and line break of the CSV as two bytes, so the
 * frame can be up to twice the file. The socket path keeps the same row cap
 * with a byte cap under half the frame limit.
 */
export const SOCKET_EXPORT_LIMITS: ExportLimits = { maxRows: 250_000, maxBytes: 45 * 1024 * 1024 };

function assertDateRange(from: string | undefined, to: string | undefined): void {
  if (from !== undefined && !DATE_PATTERN.test(from)) {
    throw new ValidationError('validation.logs.date.invalid', {}, { field: 'from' });
  }
  if (to !== undefined && !DATE_PATTERN.test(to)) {
    throw new ValidationError('validation.logs.date.invalid', {}, { field: 'to' });
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new ValidationError('validation.logs.date.invalid', {}, { field: 'from' });
  }
}

export async function listLogs(
  query: ActivityLogQuery,
  actor: ActorContext,
): Promise<CursorPage<ActivityLogEntry>> {
  requirePermission(actor, 'logs.view');
  assertDateRange(query.from, query.to);

  const direction = query.direction === 'newer' ? 'newer' : 'older';
  if (query.direction !== undefined && query.direction !== 'older' && query.direction !== 'newer') {
    throw new ValidationError('validation.logs.direction.invalid', {}, { field: 'direction' });
  }

  const limit = clampLogPage(query.limit);
  const afterId = query.cursor ? decodeLogCursor(query.cursor) : undefined;

  const { entries, hasMore } = await activityLogRepo.listEntries(actor.tenantId, {
    scope: resolvePartyScope(actor),
    actorType: query.actorType,
    actorId: query.actorId,
    entityType: query.entityType,
    action: query.action,
    from: query.from,
    to: query.to,
    q: query.q,
    direction,
    afterId,
    limit,
  });

  // Newest-first display order always — `listEntries` already reverses a
  // `'newer'` walk before returning. `oldest`/`newest` are then just the
  // page's last/first element regardless of which direction fetched it.
  const oldest = entries.at(-1);
  const newest = entries[0];

  let nextCursor: string | null = null; // the "Older" button
  let prevCursor: string | null = null; // the "Newer" button

  if (direction === 'older') {
    nextCursor = hasMore && oldest ? encodeLogCursor(oldest.id) : null;
    // "Newer" is only offered once the caller is not already at the top —
    // the top page is the one reached with no cursor at all.
    prevCursor = query.cursor && newest ? encodeLogCursor(newest.id) : null;
  } else {
    prevCursor = hasMore && newest ? encodeLogCursor(newest.id) : null;
    nextCursor = oldest ? encodeLogCursor(oldest.id) : null;
  }

  return { items: entries, nextCursor, prevCursor, limit };
}

export async function listLogFacets(
  query: { from?: string; to?: string },
  actor: ActorContext,
): Promise<ActivityLogFacets> {
  requirePermission(actor, 'logs.view');
  assertDateRange(query.from, query.to);
  return activityLogRepo.listFacets(actor.tenantId, {
    from: query.from,
    to: query.to,
    scope: resolvePartyScope(actor),
  });
}

export async function verifyLogChain(input: ChainVerifyInput, actor: ActorContext): Promise<ChainVerification> {
  requirePermission(actor, 'logs.verifyChain');

  const limit = input.limit ?? DEFAULT_VERIFY_LIMIT;
  if (limit > MAX_VERIFY_LIMIT || limit <= 0) {
    throw new ValidationError('validation.logs.verify.limitExceeded', {}, { field: 'limit', max: MAX_VERIFY_LIMIT });
  }

  const bounds = await activityLogRepo.chainBounds(actor.tenantId);
  if (bounds.maxSequence === null) {
    return {
      ok: true,
      checkedCount: 0,
      skippedPreChainCount: 0,
      fromSequence: null,
      toSequence: null,
      firstBreak: null,
      truncated: false,
    };
  }

  const toSequence = input.toSequence ?? bounds.maxSequence;
  if (!DECIMAL_PATTERN.test(toSequence)) {
    throw new ValidationError('validation.logs.verify.fromSequenceInvalid', {}, { field: 'toSequence' });
  }

  let fromSequence: string;
  if (input.fromSequence !== undefined) {
    if (!DECIMAL_PATTERN.test(input.fromSequence) || BigInt(input.fromSequence) > BigInt(toSequence)) {
      throw new ValidationError('validation.logs.verify.fromSequenceInvalid', {}, { field: 'fromSequence' });
    }
    fromSequence = input.fromSequence;
  } else {
    const minBound = BigInt(bounds.minSequence ?? '1');
    const candidate = BigInt(toSequence) - BigInt(limit) + 1n;
    fromSequence = String(candidate < minBound ? minBound : candidate);
  }

  let truncated = false;
  const width = BigInt(toSequence) - BigInt(fromSequence) + 1n;
  if (width > BigInt(MAX_VERIFY_LIMIT)) {
    fromSequence = String(BigInt(toSequence) - BigInt(MAX_VERIFY_LIMIT) + 1n);
    truncated = true;
  }

  const result = await activityLogRepo.verifyChain(actor.tenantId, { fromSequence, toSequence });
  const final: ChainVerification = { ...result, truncated: truncated || result.truncated };

  // Written *after* the scan, in its own transaction — listing the log
  // writes nothing, or the trail would become mostly about itself.
  await db().transaction((trx) =>
    activityLogRepo.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'activity_log',
        entityId: `${fromSequence}-${toSequence}`,
        action: 'verified',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { fromSequence, toSequence, ok: final.ok, checkedCount: final.checkedCount },
      },
      actor,
      trx,
    ),
  );

  return final;
}

/**
 * The first nine columns are the original export, in their original order;
 * `sentence` and `details` are appended so a sheet built on the old columns
 * keeps working.
 */
const CSV_HEADERS = [
  'id',
  'sequence',
  'createdAt',
  'actorType',
  'actorName',
  'entityType',
  'entityId',
  'action',
  'hash',
  'sentence',
  'details',
];

function rowFor(entry: ActivityLogEntry, t: Translator): unknown[] {
  return [
    entry.id,
    entry.sequence ?? '',
    entry.createdAt,
    entry.actor.type,
    entry.actor.name ?? '',
    entry.entityType,
    entry.entityId,
    entry.action,
    entry.hash ?? '',
    renderActivity(t, {
      entityType: entry.entityType,
      action: entry.action,
      actorName: entry.actor.name,
      details: entry.details,
    }),
    JSON.stringify(entry.details ?? {}),
  ];
}

/**
 * **Deviation from `04-API-CONTRACT.md` §2.5, disclosed rather than
 * silent:** the spec asks for the HTTP route to stream so a 250,000-row
 * export is "never loaded whole into memory." This returns the assembled
 * string instead, because the Office path (§10.2) has to buffer the whole
 * CSV into one socket ack regardless — there is no streaming transport
 * between the Office server and its browser for this call — and one
 * function serving both transports identically was judged more valuable
 * than a leaner Master-only HTTP path. The file is built a batch at a time
 * against a running byte count. As in 1.2, an export past the row cap keeps
 * the newest rows and stops rather than refusing; past the byte cap it stops
 * at the last whole batch that fits. Either way `truncated` says so, and the
 * export's own log entry records it.
 */
export async function exportLogs(
  query: ActivityLogQuery,
  actor: ActorContext,
  limits: ExportLimits = HTTP_EXPORT_LIMITS,
): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
  requirePermission(actor, 'logs.export');
  assertDateRange(query.from, query.to);

  const t = createTranslator('en');
  const chunks = [await toCsvViaRust(CSV_HEADERS, [])];
  let bytes = Buffer.byteLength(chunks[0] as string);
  let rowCount = 0;
  let truncated = false;

  for await (const batch of activityLogRepo.streamForExport(
    actor.tenantId,
    {
      scope: resolvePartyScope(actor),
      actorType: query.actorType,
      actorId: query.actorId,
      entityType: query.entityType,
      action: query.action,
      from: query.from,
      to: query.to,
      q: query.q,
    },
    EXPORT_BATCH_SIZE,
    // One past the limit, so going over it can be told apart from landing on it.
    limits.maxRows + 1,
  )) {
    const room = limits.maxRows - rowCount;
    const rows = batch.length > room ? batch.slice(0, room) : batch;
    const chunk = await csvLinesViaRust(rows.map((entry) => rowFor(entry, t)));
    if (bytes + Buffer.byteLength(chunk) > limits.maxBytes) {
      truncated = true;
      break;
    }
    bytes += Buffer.byteLength(chunk);
    chunks.push(chunk);
    rowCount += rows.length;
    if (rows.length < batch.length) {
      truncated = true;
      break;
    }
  }

  const csv = chunks.join('');

  await db().transaction((trx) =>
    activityLogRepo.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'activity_log',
        entityId: `${query.from ?? 'all'}..${query.to ?? 'all'}`,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { rowCount, from: query.from, to: query.to, ...(truncated ? { truncated } : {}) },
      },
      actor,
      trx,
    ),
  );

  return { csv, rowCount, truncated };
}
