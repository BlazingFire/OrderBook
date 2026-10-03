/**
 * The Printroom's tables: `print_jobs` and `print_stations` (1.3 Phase 7,
 * migration #6).
 *
 * All SQL for them lives here. A function that changes rows takes the caller's
 * `TransactionContext`; reads take a runner and default to the pool. Every query
 * names the company, so a caller can only reach its own rows.
 *
 * Rows come back raw, with person ids rather than people: turning them into the
 * wire types needs the names and tiers they point at, which is the service's job.
 * The frozen note (`payload`) is selected only when asked for, so a list never
 * carries sheets.
 */

import type { NoteDocument, NoteKind, NoteSource, PrintJobStatus } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { toIso, toRequiredIso } from './mappers.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;
type Row = Record<string, unknown>;

// --- Row shapes ---------------------------------------------------------------

export interface PrintJobRow {
  id: string;
  tenantId: string;
  requestId: string;
  kind: NoteKind;
  sourceType: NoteSource;
  sourceId: string;
  sourceNumber: string | null;
  partyName: string;
  /** Only when read with `withPayload`; otherwise always null. */
  payload: NoteDocument | null;
  /** Whether a frozen note is held at all (true even when `payload` was not selected). */
  hasPayload: boolean;
  copies: number;
  note: string | null;
  targetStationId: string | null;
  targetStationName: string | null;
  status: PrintJobStatus;
  senderId: string;
  requestedFrom: string | null;
  requestedAt: string;
  /** Microseconds since the epoch, exact: the paging cursor (a JS date keeps only milliseconds). */
  requestedUs: string;
  claimedBy: string | null;
  claimedStationId: string | null;
  claimedStationName: string | null;
  claimedAt: string | null;
  claimSocket: string | null;
  printedBy: string | null;
  printedStationId: string | null;
  printedStationName: string | null;
  printedAt: string | null;
  printerName: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

export interface PrintStationRow {
  id: string;
  tenantId: string;
  stationKey: string;
  displayName: string;
  printerName: string | null;
  autoPrint: boolean;
  lastSeenAt: string | null;
}

function mapJob(row: Row): PrintJobRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    requestId: String(row.request_id),
    kind: row.kind as NoteKind,
    sourceType: row.source_type as NoteSource,
    sourceId: String(row.source_id),
    sourceNumber: (row.source_number as string | null) ?? null,
    partyName: String(row.party_name),
    payload: (row.payload as NoteDocument | null | undefined) ?? null,
    hasPayload: row.has_payload === true,
    copies: Number(row.copies),
    note: (row.note as string | null) ?? null,
    targetStationId: (row.target_station_id as string | null) ?? null,
    targetStationName: (row.target_station_name as string | null) ?? null,
    status: row.status as PrintJobStatus,
    senderId: String(row.sender_id),
    requestedFrom: (row.requested_from as string | null) ?? null,
    requestedAt: toRequiredIso(row.requested_at),
    requestedUs: String(row.requested_us),
    claimedBy: (row.claimed_by as string | null) ?? null,
    claimedStationId: (row.claimed_station_id as string | null) ?? null,
    claimedStationName: (row.claimed_station_name as string | null) ?? null,
    claimedAt: toIso(row.claimed_at),
    claimSocket: (row.claim_socket as string | null) ?? null,
    printedBy: (row.printed_by as string | null) ?? null,
    printedStationId: (row.printed_station_id as string | null) ?? null,
    printedStationName: (row.printed_station_name as string | null) ?? null,
    printedAt: toIso(row.printed_at),
    printerName: (row.printer_name as string | null) ?? null,
    cancelledBy: (row.cancelled_by as string | null) ?? null,
    cancelledAt: toIso(row.cancelled_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

function mapStation(row: Row): PrintStationRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    stationKey: String(row.station_key),
    displayName: String(row.display_name),
    printerName: (row.printer_name as string | null) ?? null,
    autoPrint: row.auto_print === true,
    lastSeenAt: toIso(row.last_seen_at),
  };
}

/**
 * Every column but the payload, plus whether there is one, the exact request
 * time and the two station names a list shows. The payload is added by
 * `withPayload`.
 */
function jobColumns(runner: Runner, withPayload: boolean): Knex.QueryBuilder {
  const query = runner('print_jobs as j')
    .leftJoin('print_stations as ts', 'ts.id', 'j.target_station_id')
    .leftJoin('print_stations as ps', 'ps.id', 'j.printed_station_id')
    .leftJoin('print_stations as cs', 'cs.id', 'j.claimed_station_id')
    .select(
      'j.id',
      'j.tenant_id',
      'j.request_id',
      'j.kind',
      'j.source_type',
      'j.source_id',
      'j.source_number',
      'j.party_name',
      'j.copies',
      'j.note',
      'j.target_station_id',
      'j.status',
      'j.sender_id',
      'j.requested_from',
      'j.requested_at',
      'j.claimed_by',
      'j.claimed_station_id',
      'j.claimed_at',
      'j.claim_socket',
      'j.printed_by',
      'j.printed_station_id',
      'j.printed_at',
      'j.printer_name',
      'j.cancelled_by',
      'j.cancelled_at',
      'j.updated_at',
      'ts.display_name as target_station_name',
      'ps.display_name as printed_station_name',
      'cs.display_name as claimed_station_name',
      runner.raw('(j.payload IS NOT NULL) as has_payload'),
      runner.raw('(extract(epoch from j.requested_at) * 1000000)::bigint as requested_us'),
    );
  if (withPayload) query.select('j.payload');
  return query;
}

// --- Jobs ---------------------------------------------------------------------

export interface NewPrintJob {
  tenantId: string;
  requestId: string;
  kind: NoteKind;
  sourceType: NoteSource;
  sourceId: string;
  sourceNumber: string | null;
  partyName: string;
  payload: NoteDocument;
  copies: number;
  note: string | null;
  targetStationId: string | null;
  senderId: string;
  requestedFrom: string | null;
}

/**
 * Inserts a job, or finds the one this sender already made with this request
 * id. `created` says which, so a retried send is not announced twice.
 */
export async function insertJob(
  trx: TransactionContext,
  job: NewPrintJob,
): Promise<{ row: PrintJobRow; created: boolean }> {
  const inserted = await trx('print_jobs')
    .insert({
      tenant_id: job.tenantId,
      request_id: job.requestId,
      kind: job.kind,
      source_type: job.sourceType,
      source_id: job.sourceId,
      source_number: job.sourceNumber,
      party_name: job.partyName,
      payload: JSON.stringify(job.payload),
      copies: job.copies,
      note: job.note,
      target_station_id: job.targetStationId,
      sender_id: job.senderId,
      requested_from: job.requestedFrom,
    })
    .onConflict(['tenant_id', 'sender_id', 'request_id'])
    .ignore()
    .returning('id');

  const created = inserted.length > 0;
  const row = await jobColumns(trx, false)
    .where({ 'j.tenant_id': job.tenantId, 'j.sender_id': job.senderId, 'j.request_id': job.requestId })
    .first();
  return { row: mapJob(row as Row), created };
}

/**
 * Drops the frozen note of jobs printed or cancelled more than `days` ago. One
 * UPDATE piggybacked on each send: there is no scheduler, and the rows (who
 * sent, printed or cancelled, and when) stay.
 */
export async function stripOldPayloads(trx: TransactionContext, tenantId: string, days: number): Promise<number> {
  return trx('print_jobs')
    .where({ tenant_id: tenantId })
    .whereIn('status', ['printed', 'cancelled'])
    .whereNotNull('payload')
    .whereRaw(`updated_at < now() - (? * interval '1 day')`, [days])
    .update({ payload: null });
}

export interface JobFilter {
  statuses: readonly PrintJobStatus[] | null;
  senderId: string | null;
}

/** `cursor` is `<microseconds>:<id>`; the Waiting list runs oldest first, the rest newest first. */
export async function listJobs(
  tenantId: string,
  filter: JobFilter,
  paging: { cursor: string | null; limit: number; oldestFirst: boolean },
  runner: Runner = db(),
): Promise<PrintJobRow[]> {
  const query = jobColumns(runner, false).where('j.tenant_id', tenantId);
  if (filter.statuses) query.whereIn('j.status', [...filter.statuses]);
  if (filter.senderId) query.where('j.sender_id', filter.senderId);

  const key = '((extract(epoch from j.requested_at) * 1000000)::bigint, j.id)';
  if (paging.cursor) {
    const at = paging.cursor.indexOf(':');
    const us = paging.cursor.slice(0, at);
    const id = paging.cursor.slice(at + 1);
    if (at > 0 && /^[0-9]+$/.test(us) && /^[0-9a-f-]{36}$/i.test(id)) {
      query.whereRaw(`${key} ${paging.oldestFirst ? '>' : '<'} (?::bigint, ?::uuid)`, [us, id]);
    }
  }
  query.orderByRaw(
    paging.oldestFirst ? 'j.requested_at ASC, j.id ASC' : 'j.requested_at DESC, j.id DESC',
  );
  const rows = await query.limit(paging.limit);
  return rows.map(mapJob);
}

/** Jobs waiting for paper (queued or printing). */
export async function countWaiting(tenantId: string, senderId: string | null, runner: Runner = db()): Promise<number> {
  const query = runner('print_jobs').where({ tenant_id: tenantId }).whereIn('status', ['queued', 'printing']);
  if (senderId) query.where({ sender_id: senderId });
  const row = (await query.count<Array<{ count: string }>>({ count: '*' }))[0];
  return Number(row?.count ?? 0);
}

export async function findJob(
  tenantId: string,
  id: string,
  options: { withPayload: boolean; lock?: boolean },
  runner: Runner = db(),
): Promise<PrintJobRow | null> {
  const query = jobColumns(runner, options.withPayload).where({ 'j.tenant_id': tenantId, 'j.id': id });
  if (options.lock) query.forUpdate('j');
  const row = await query.first();
  return row ? mapJob(row as Row) : null;
}

/** Printed from `queued` or `printing`. Null when the job is in any other state. */
export async function markPrinted(
  trx: TransactionContext,
  tenantId: string,
  id: string,
  by: { userId: string | null; stationId: string | null; printerName: string | null },
): Promise<boolean> {
  const updated = await trx('print_jobs')
    .where({ tenant_id: tenantId, id })
    .whereIn('status', ['queued', 'printing'])
    .update({
      status: 'printed',
      printed_by: by.userId,
      printed_station_id: by.stationId,
      printed_at: trx.fn.now(),
      printer_name: by.printerName,
      claim_socket: null,
      updated_at: trx.fn.now(),
    });
  return updated > 0;
}

/** Back to the queue from `printed`; the printed fields and any claim are cleared. */
export async function markQueued(trx: TransactionContext, tenantId: string, id: string): Promise<boolean> {
  const updated = await trx('print_jobs').where({ tenant_id: tenantId, id, status: 'printed' }).update({
    status: 'queued',
    printed_by: null,
    printed_station_id: null,
    printed_at: null,
    printer_name: null,
    claimed_by: null,
    claimed_station_id: null,
    claimed_at: null,
    claim_socket: null,
    updated_at: trx.fn.now(),
  });
  return updated > 0;
}

/** Final, and only from `queued`. */
export async function cancelJob(
  trx: TransactionContext,
  tenantId: string,
  id: string,
  userId: string | null,
): Promise<boolean> {
  const updated = await trx('print_jobs').where({ tenant_id: tenantId, id, status: 'queued' }).update({
    status: 'cancelled',
    cancelled_by: userId,
    cancelled_at: trx.fn.now(),
    updated_at: trx.fn.now(),
  });
  return updated > 0;
}

/**
 * Takes a job for a station, atomically: it must be queued, or held by a claim
 * older than `staleMs`; it must still have its note; and when it names a
 * station, that must be this one. Null when somebody else got there first (or
 * it is none of those).
 */
export async function claimJob(
  tenantId: string,
  id: string,
  claim: { stationId: string; userId: string | null; socketId: string; staleMs: number },
): Promise<boolean> {
  const updated = await db()('print_jobs')
    .where({ tenant_id: tenantId, id })
    .whereNotNull('payload')
    .where((where) =>
      where
        .where('status', 'queued')
        .orWhere((stale) =>
          stale.where('status', 'printing').whereRaw(`claimed_at < now() - (? * interval '1 millisecond')`, [claim.staleMs]),
        ),
    )
    .where((target) => target.whereNull('target_station_id').orWhere('target_station_id', claim.stationId))
    .update({
      status: 'printing',
      claimed_by: claim.userId,
      claimed_station_id: claim.stationId,
      claimed_at: db().fn.now(),
      claim_socket: claim.socketId,
      updated_at: db().fn.now(),
    });
  return updated > 0;
}

/** The claimant gives one job back. Only the connection that holds it can. */
export async function releaseClaim(
  trx: TransactionContext,
  tenantId: string,
  id: string,
  socketId: string,
): Promise<boolean> {
  const updated = await trx('print_jobs')
    .where({ tenant_id: tenantId, id, status: 'printing', claim_socket: socketId })
    .update({
      status: 'queued',
      claimed_by: null,
      claimed_station_id: null,
      claimed_at: null,
      claim_socket: null,
      updated_at: trx.fn.now(),
    });
  return updated > 0;
}

/** A dropped connection's claims go back in the queue. Returns the ids so the caller can say so. */
export async function releaseClaimsOf(socketId: string): Promise<Array<{ tenantId: string; id: string }>> {
  const rows = await db()('print_jobs')
    .where({ claim_socket: socketId, status: 'printing' })
    .update({
      status: 'queued',
      claimed_by: null,
      claimed_station_id: null,
      claimed_at: null,
      claim_socket: null,
      updated_at: db().fn.now(),
    })
    .returning(['tenant_id', 'id']);
  return (rows as Row[]).map((row) => ({ tenantId: String(row.tenant_id), id: String(row.id) }));
}

/** At Master boot no connection survives, so no claim may. */
export async function releaseAllClaims(): Promise<number> {
  return db()('print_jobs').where({ status: 'printing' }).update({
    status: 'queued',
    claimed_by: null,
    claimed_station_id: null,
    claimed_at: null,
    claim_socket: null,
    updated_at: db().fn.now(),
  });
}

// --- Stations -----------------------------------------------------------------

const STATION_COLUMNS = ['id', 'tenant_id', 'station_key', 'display_name', 'printer_name', 'auto_print', 'last_seen_at'] as const;

export async function upsertStation(
  tenantId: string,
  stationKey: string,
  value: { displayName: string; printerName: string | null; autoPrint: boolean },
): Promise<PrintStationRow> {
  const rows = await db()('print_stations')
    .insert({
      tenant_id: tenantId,
      station_key: stationKey,
      display_name: value.displayName,
      printer_name: value.printerName,
      auto_print: value.autoPrint,
      last_seen_at: db().fn.now(),
    })
    .onConflict(['tenant_id', 'station_key'])
    .merge({
      display_name: value.displayName,
      printer_name: value.printerName,
      auto_print: value.autoPrint,
      last_seen_at: db().fn.now(),
      updated_at: db().fn.now(),
    })
    .returning([...STATION_COLUMNS]);
  return mapStation((rows as Row[])[0] as Row);
}

export async function listStations(tenantId: string, runner: Runner = db()): Promise<PrintStationRow[]> {
  const rows = await runner('print_stations')
    .where({ tenant_id: tenantId })
    .orderByRaw('lower(display_name), id')
    .select(...STATION_COLUMNS);
  return rows.map(mapStation);
}

export async function findStationByKey(
  tenantId: string,
  stationKey: string,
  runner: Runner = db(),
): Promise<PrintStationRow | null> {
  const row = await runner('print_stations')
    .where({ tenant_id: tenantId, station_key: stationKey })
    .first(...STATION_COLUMNS);
  return row ? mapStation(row as Row) : null;
}

export async function findStationById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<PrintStationRow | null> {
  const row = await runner('print_stations')
    .where({ tenant_id: tenantId, id })
    .first(...STATION_COLUMNS);
  return row ? mapStation(row as Row) : null;
}

/** The database's clock, so "online" and "stale" are never judged against a drifting Node clock. */
export async function databaseNow(runner: Runner = db()): Promise<Date> {
  const result = await runner.raw('SELECT now() AS now');
  return (result.rows as Array<{ now: Date }>)[0]!.now;
}
