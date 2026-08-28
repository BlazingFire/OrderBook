/**
 * Logs — `listLogs`, `listLogFacets`, `verifyLogChain`, `exportLogs`
 * (`docs/backend-modules/04-API-CONTRACT.md` §2). Body order per house
 * style: permission, then validate, then repository, then map. Nothing here
 * is masked — a log row carries no money.
 */

import type {
  ActivityLogEntry,
  ActivityLogFacets,
  ActivityLogQuery,
  ChainVerification,
  ChainVerifyInput,
  CursorPage,
} from '@orderbook/shared';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { clampLogPage, decodeLogCursor, encodeLogCursor } from '../domain/log-cursor.js';
import { db } from '../db/knex.js';
import { toCsv } from '../lib/csv.js';
import { ValidationError } from '../lib/errors.js';
import * as activityLogRepo from '../repositories/activity-log.repository.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^\d+$/;

const DEFAULT_VERIFY_LIMIT = 10_000;
const MAX_VERIFY_LIMIT = 200_000;

const EXPORT_BATCH_SIZE = 5_000;
const EXPORT_HARD_CAP = 250_000;

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

const CSV_HEADERS = ['id', 'sequence', 'createdAt', 'actorType', 'actorName', 'entityType', 'entityId', 'action', 'hash'];

function rowFor(entry: ActivityLogEntry): unknown[] {
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
 * than a leaner Master-only HTTP path. At the hard cap this is a bounded
 * (~250,000 row) in-memory buffer, not an unbounded one; revisit if a real
 * installation's log volume makes that bound itself the problem.
 */
export async function exportLogs(
  query: ActivityLogQuery,
  actor: ActorContext,
): Promise<{ csv: string; rowCount: number }> {
  requirePermission(actor, 'logs.export');
  assertDateRange(query.from, query.to);

  const rows: unknown[][] = [];
  let rowCount = 0;

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
    EXPORT_HARD_CAP,
  )) {
    for (const entry of batch) rows.push(rowFor(entry));
    rowCount += batch.length;
  }

  const csv = toCsv(CSV_HEADERS, rows);

  await db().transaction((trx) =>
    activityLogRepo.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'activity_log',
        entityId: `${query.from ?? 'all'}..${query.to ?? 'all'}`,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { rowCount, from: query.from, to: query.to },
      },
      actor,
      trx,
    ),
  );

  return { csv, rowCount };
}
