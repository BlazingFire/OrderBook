/**
 * The Printroom (1.3 Phase 7): a shared print queue and the stations that work
 * it.
 *
 * **The Master builds the note.** A send names a record, not a sheet: this
 * service reads the lead or order itself (through `getLead` / `getOrder`, so the
 * sender's own view and Party Access decide whether they may print it at all),
 * adds the party header and the PO number, and freezes the result in the job.
 * The printer PC therefore never needs the record, its party or a snapshot big
 * enough to hold it. The sender supplies only the copies, a vehicle number and a
 * short note, all cleaned here.
 *
 * **Who sees what.** `print.send` sees and cancels its own jobs. `print.station`
 * sees every job, prints, marks and unmarks, cancels any queued one, and
 * registers a station; it is a deliberate cross-party grant, because the sender
 * addressed the printroom and not a person.
 *
 * **The claim belongs to a connection.** `claimJob` flips a job to `printing`
 * for one station and one socket. A dropped socket releases its claims
 * (`releaseClaimsOf`), a claim older than ten minutes may be taken by another
 * station, and every claim is cleared at Master boot, so two stations never
 * print the same sheet and a crashed one never strands a job.
 *
 * **Audit.** Sent, printed, unprinted and cancelled are written to the activity
 * log inside the same transaction as the change (details `{number, kind}`).
 * Claims and heartbeats are not.
 *
 * Nothing here is in the change ring: live updates travel on the change bus's
 * own print channel, addressed per recipient by the hub.
 */

import type {
  PrintJob,
  PrintJobInput,
  PrintJobPage,
  PrintJobSummary,
  PrintPerson,
  PrintStation,
  PrintStationInput,
  NoteDocument,
} from '@orderbook/shared';
import {
  MASTER_STATION_KEY,
  PRINT_LIMITS,
  cleanPrintJobInput,
  noteDocument,
  noteNumber,
  normalisePrintQuery,
  stationOnline,
} from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { ForbiddenError, NotFoundError, ValidationError, toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityRepo from '../repositories/activity-log.repository.js';
import * as chatRepo from '../repositories/chat.repository.js';
import * as identityRepo from '../repositories/identity.repository.js';
import * as panelRepo from '../repositories/office-panel.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as printRepo from '../repositories/print.repository.js';
import type { PrintJobRow, PrintStationRow } from '../repositories/print.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { publishPrintJob } from './change-bus.js';
import * as leadService from './lead.service.js';
import { notify } from './notification.service.js';
import * as orderService from './order.service.js';

const log = createLogger('print');

/**
 * Where a call came from, worked out by the transport and never taken from a
 * body. `stationKey` is `master` for the Master PC's own window and
 * `panel:<id>` for an Office Panel's socket; null for a LAN browser, which is
 * not a place anything can be printed from. `holder` is the connection that
 * would hold a claim.
 */
export interface PrintOrigin {
  /** A panel's device code, `master` or `lan`: stored on the job. */
  from: string;
  stationKey: string | null;
  holder: string | null;
}

// --- Gates ----------------------------------------------------------------------

const isStation = (actor: ActorContext): boolean => actorCan(actor, 'print.station');

/** Either key opens the room; the finer rules are per function. */
function requireRoom(actor: ActorContext): void {
  if (actorCan(actor, 'print.send') || isStation(actor)) return;
  throw new ForbiddenError('print.send');
}

/** The person acting. A panel with nobody signed in has none and may only run a station. */
function requireSender(actor: ActorContext): string {
  requirePermission(actor, 'print.send');
  if (!actor.userId) throw new ForbiddenError('print.send');
  return actor.userId;
}

// --- Hydration -------------------------------------------------------------------

async function peopleOf(tenantId: string, rows: readonly PrintJobRow[]): Promise<Map<string, PrintPerson>> {
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.senderId);
    if (row.printedBy) ids.add(row.printedBy);
    if (row.cancelledBy) ids.add(row.cancelledBy);
  }
  const people = await chatRepo.listPeopleByIds(tenantId, [...ids]);
  return new Map(people.map((person) => [person.id, person as PrintPerson]));
}

function toSummary(row: PrintJobRow, people: Map<string, PrintPerson>): PrintJobSummary {
  const person = (id: string | null): PrintPerson | null => {
    if (!id) return null;
    // A person who has since been removed from the book still reads as who they were.
    return people.get(id) ?? { id, displayName: id, avatar: null, tier: 'office' };
  };
  return {
    id: row.id,
    kind: row.kind,
    source: row.sourceType,
    sourceId: row.sourceId,
    sourceNumber: row.sourceNumber,
    partyName: row.partyName,
    copies: row.copies,
    note: row.note,
    targetStation: row.targetStationId
      ? { id: row.targetStationId, name: row.targetStationName ?? '' }
      : null,
    status: row.status,
    sender: person(row.senderId),
    requestedFrom: row.requestedFrom,
    requestedAt: row.requestedAt,
    claimedAt: row.status === 'printing' ? row.claimedAt : null,
    claimedStationName: row.status === 'printing' ? row.claimedStationName : null,
    printedBy: person(row.printedBy),
    printedAt: row.printedAt,
    printerName: row.printerName,
    printedStationName: row.printedStationName,
    cancelledBy: person(row.cancelledBy),
    cancelledAt: row.cancelledAt,
    hasDocument: row.hasPayload,
  };
}

async function summariesOf(tenantId: string, rows: readonly PrintJobRow[]): Promise<PrintJobSummary[]> {
  const people = await peopleOf(tenantId, rows);
  return rows.map((row) => toSummary(row, people));
}

async function summaryOf(tenantId: string, row: PrintJobRow): Promise<PrintJobSummary> {
  return (await summariesOf(tenantId, [row]))[0] as PrintJobSummary;
}

function publish(tenantId: string, job: PrintJobSummary): void {
  publishPrintJob({ tenantId, job });
}

async function reread(tenantId: string, id: string): Promise<PrintJobRow> {
  const row = await printRepo.findJob(tenantId, id, { withPayload: false });
  if (!row) throw new NotFoundError('Print job');
  return row;
}

const audit = (
  trx: TransactionContext,
  actor: ActorContext,
  row: { id: string; sourceNumber: string | null; sourceId: string; kind: string },
  action: 'sent' | 'printed' | 'unprinted' | 'cancelled',
): Promise<void> =>
  activityRepo.recordActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'print_job',
      entityId: row.id,
      action,
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { number: row.sourceNumber ?? row.sourceId, kind: row.kind },
    },
    actor,
    trx,
  );

// --- Sending ---------------------------------------------------------------------

/**
 * Queue a note. Needs `print.send` and the note's own export right
 * (`leads.export` for a pending order, `orders.export` for a final one). A
 * retry with the same `requestId` returns the job it already made and announces
 * nothing.
 */
export async function sendJob(raw: unknown, actor: ActorContext, origin: PrintOrigin): Promise<PrintJob> {
  const userId = requireSender(actor);

  const cleaned = cleanPrintJobInput(raw);
  if ('errorKey' in cleaned) throw new ValidationError(cleaned.errorKey);
  const input: Required<PrintJobInput> = cleaned.value;

  requirePermission(actor, input.source === 'lead' ? 'leads.export' : 'orders.export');

  // The same lookups the sender's own screens use, so their view and Party Access apply.
  const id = await identityRepo.resolveId(actor.tenantId, input.sourceId);
  const record =
    input.source === 'lead'
      ? await leadService.getLead(id, actor)
      : await orderService.getOrder(id, actor);
  const party = await partyRepo.findPartyById(actor.tenantId, record.partyId);

  if (input.targetStationId) {
    const station = await printRepo.findStationById(actor.tenantId, input.targetStationId);
    if (!station) throw new ValidationError('validation.print.station');
  }

  // A vehicle number typed in the dialog wins; a final order falls back to the one it holds.
  const saved = input.source === 'order' ? ((record as { vehicleNumber?: string | null }).vehicleNumber ?? null) : null;
  const vehicle = input.kind === 'dispatch' ? (input.vehicleNumber ?? saved) : null;
  const document: NoteDocument = noteDocument(record, input.source, party, vehicle);

  const { row, created } = await db().transaction(async (trx) => {
    const made = await printRepo.insertJob(trx, {
      tenantId: actor.tenantId,
      requestId: input.requestId,
      kind: input.kind,
      sourceType: input.source,
      sourceId: record.id,
      sourceNumber: noteNumber(record),
      partyName: record.partyName,
      payload: document,
      copies: input.copies,
      note: input.note,
      targetStationId: input.targetStationId,
      senderId: userId,
      requestedFrom: origin.from,
    });
    if (made.created) {
      await printRepo.stripOldPayloads(trx, actor.tenantId, PRINT_LIMITS.payloadKeepDays);
      await audit(trx, actor, made.row, 'sent');
    }
    return made;
  });

  const summary = await summaryOf(actor.tenantId, row);
  if (created) publish(actor.tenantId, summary);
  return { ...summary, document };
}

// --- Reading ---------------------------------------------------------------------

export async function listJobs(raw: unknown, actor: ActorContext): Promise<PrintJobPage> {
  requireRoom(actor);
  const query = normalisePrintQuery(raw);
  const station = isStation(actor);

  // A sender without `print.station` is always limited to the jobs they sent.
  let senderId: string | null = null;
  if (!station || query.mine) {
    if (!actor.userId) throw new ForbiddenError('print.station');
    senderId = actor.userId;
  }

  const statuses =
    query.status === 'waiting'
      ? (['queued', 'printing'] as const)
      : query.status === 'printed'
        ? (['printed'] as const)
        : query.status === 'cancelled'
          ? (['cancelled'] as const)
          : null;

  const rows = await printRepo.listJobs(
    actor.tenantId,
    { statuses, senderId },
    { cursor: query.cursor, limit: query.limit + 1, oldestFirst: query.status === 'waiting' },
  );

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    jobs: await summariesOf(actor.tenantId, page),
    nextCursor: rows.length > query.limit && last ? `${last.requestedUs}:${last.id}` : null,
    waitingCount: await printRepo.countWaiting(actor.tenantId, senderId),
  };
}

/** A job with its sheet. A sender sees only their own; a stranger is told it does not exist. */
export async function getJob(id: unknown, actor: ActorContext): Promise<PrintJob> {
  requireRoom(actor);
  if (typeof id !== 'string') throw new NotFoundError('Print job');
  const row = await printRepo.findJob(actor.tenantId, id, { withPayload: true });
  if (!row || (!isStation(actor) && row.senderId !== actor.userId)) throw new NotFoundError('Print job');
  return { ...(await summaryOf(actor.tenantId, row)), document: row.payload };
}

// --- Changing --------------------------------------------------------------------

function cleanPrinter(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > PRINT_LIMITS.printerNameMax) {
    throw new ValidationError('validation.print.printer');
  }
  return value;
}

/**
 * Mark a job printed, or (`printed: false`) put a printed one back in the queue.
 * Asking for the state a job is already in is a no-op, so a double click is
 * harmless; a cancelled job cannot be marked at all.
 */
export async function markJob(
  raw: { id?: unknown; printed?: unknown; printerName?: unknown } | null | undefined,
  actor: ActorContext,
  origin: PrintOrigin,
): Promise<PrintJobSummary> {
  requirePermission(actor, 'print.station');
  if (typeof raw?.id !== 'string') throw new NotFoundError('Print job');
  const id = raw.id;
  const printed = raw.printed === true;
  const printerName = cleanPrinter(raw.printerName);
  const station = origin.stationKey ? await printRepo.findStationByKey(actor.tenantId, origin.stationKey) : null;

  const outcome = await db().transaction(async (trx) => {
    const row = await printRepo.findJob(actor.tenantId, id, { withPayload: false, lock: true }, trx);
    if (!row) throw new NotFoundError('Print job');
    if (row.status === 'cancelled') throw new ValidationError('validation.print.notPrintable');

    if (printed) {
      if (row.status === 'printed') return { changed: false, row };
      await printRepo.markPrinted(trx, actor.tenantId, id, {
        userId: actor.userId,
        stationId: station?.id ?? null,
        printerName: printerName ?? station?.printerName ?? null,
      });
      await audit(trx, actor, row, 'printed');
      return { changed: true, row };
    }

    // A station whose print failed gives its own claim back; nobody else's.
    // A claim is not audited, so neither is giving one back.
    if (row.status === 'printing' && origin.holder !== null && row.claimSocket === origin.holder) {
      await printRepo.releaseClaim(trx, actor.tenantId, id, origin.holder);
      return { changed: true, row };
    }
    if (row.status !== 'printed') return { changed: false, row };
    await printRepo.markQueued(trx, actor.tenantId, id);
    await audit(trx, actor, row, 'unprinted');
    return { changed: true, row };
  });

  const fresh = await reread(actor.tenantId, id);
  const summary = await summaryOf(actor.tenantId, fresh);
  if (outcome.changed) {
    publish(actor.tenantId, summary);
    // Told once, and not about their own jobs.
    if (printed && fresh.senderId !== actor.userId) {
      void notify(actor.tenantId, [fresh.senderId], {
        kind: 'print.printed',
        params: { name: actor.actorName ?? station?.displayName ?? '', party: fresh.partyName },
        link: { kind: 'print', id: fresh.id },
        dedupeKey: `print.printed:${fresh.id}`,
      }).catch((error: unknown) => log.warn(`Could not notify a sender: ${toErrorMessage(error)}`));
    }
  }
  return summary;
}

/** The sender may cancel their own queued job; a station holder any queued one. Cancelled is final. */
export async function cancelJob(id: unknown, actor: ActorContext): Promise<PrintJobSummary> {
  requireRoom(actor);
  if (typeof id !== 'string') throw new NotFoundError('Print job');

  const changed = await db().transaction(async (trx) => {
    const row = await printRepo.findJob(actor.tenantId, id, { withPayload: false, lock: true }, trx);
    // A job that is not yours to see does not exist.
    if (!row || (!isStation(actor) && row.senderId !== actor.userId)) throw new NotFoundError('Print job');
    if (row.status === 'cancelled') return false;
    if (row.status !== 'queued') throw new ValidationError('validation.print.notQueued');

    await printRepo.cancelJob(trx, actor.tenantId, id, actor.userId);
    await audit(trx, actor, row, 'cancelled');
    return true;
  });

  const summary = await summaryOf(actor.tenantId, await reread(actor.tenantId, id));
  if (changed) publish(actor.tenantId, summary);
  return summary;
}

/**
 * Take a job for this connection's station. `null` means somebody else holds
 * it (or it was cancelled, printed, aimed at another station, or has lost its
 * note), which is an ordinary outcome for a runner racing another one.
 */
export async function claimJob(id: unknown, actor: ActorContext, origin: PrintOrigin): Promise<PrintJob | null> {
  requirePermission(actor, 'print.station');
  if (typeof id !== 'string') throw new NotFoundError('Print job');
  if (!origin.stationKey || !origin.holder) throw new ForbiddenError('print.station', 'validation.print.stationNeedsDesktop');

  const station = await printRepo.findStationByKey(actor.tenantId, origin.stationKey);
  if (!station) throw new ValidationError('validation.print.stationUnknown');
  if (!(await printRepo.findJob(actor.tenantId, id, { withPayload: false }))) throw new NotFoundError('Print job');

  const won = await printRepo.claimJob(actor.tenantId, id, {
    stationId: station.id,
    userId: actor.userId,
    socketId: origin.holder,
    staleMs: PRINT_LIMITS.claimStaleMs,
  });
  if (!won) return null;

  const row = (await printRepo.findJob(actor.tenantId, id, { withPayload: true })) as PrintJobRow;
  const summary = await summaryOf(actor.tenantId, row);
  publish(actor.tenantId, summary);
  return { ...summary, document: row.payload };
}

/** A connection dropped: the jobs it held go back in the queue, and everybody who watches is told. */
export async function releaseClaimsOf(socketId: string): Promise<void> {
  try {
    for (const { tenantId, id } of await printRepo.releaseClaimsOf(socketId)) {
      const row = await printRepo.findJob(tenantId, id, { withPayload: false });
      if (row) publish(tenantId, await summaryOf(tenantId, row));
    }
  } catch (error) {
    log.warn(`Could not release the claims of a closed connection: ${toErrorMessage(error)}`);
  }
}

/** Boot: no connection survives a restart, so no claim may. */
export async function releaseAllClaimsAtBoot(): Promise<void> {
  try {
    const released = await printRepo.releaseAllClaims();
    if (released > 0) log.info(`Released ${released} print claim(s) held when the Master last stopped`);
  } catch (error) {
    log.warn(`Could not clear print claims at boot: ${toErrorMessage(error)}`);
  }
}

// --- Stations --------------------------------------------------------------------

function toStation(row: PrintStationRow, nowMs: number, selfKey: string | null): PrintStation {
  return {
    id: row.id,
    name: row.displayName,
    printerName: row.printerName,
    autoPrint: row.autoPrint,
    online: stationOnline(row.lastSeenAt, nowMs),
    lastSeenAt: row.lastSeenAt,
    isSelf: selfKey !== null && row.stationKey === selfKey,
  };
}

/** Who a sender can aim at, and which of them are awake. */
export async function listStations(actor: ActorContext, origin: PrintOrigin): Promise<PrintStation[]> {
  requireRoom(actor);
  const [rows, now] = await Promise.all([printRepo.listStations(actor.tenantId), printRepo.databaseNow()]);
  return rows.map((row) => toStation(row, now.getTime(), origin.stationKey));
}

/**
 * Register this PC as a station, or say it is still alive. The key comes from
 * the connection; a browser that is neither the Master PC nor an Office Panel
 * has none and is refused, because it cannot print silently or list printers.
 */
export async function saveStation(raw: unknown, actor: ActorContext, origin: PrintOrigin): Promise<PrintStation> {
  requirePermission(actor, 'print.station');
  if (!origin.stationKey) throw new ForbiddenError('print.station', 'validation.print.stationNeedsDesktop');

  const input = (raw ?? {}) as Partial<PrintStationInput>;
  if (typeof input.autoPrint !== 'boolean') throw new ValidationError('validation.print.station');
  const printerName = cleanPrinter(input.printerName);

  const existing = await printRepo.findStationByKey(actor.tenantId, origin.stationKey);
  let displayName = existing?.displayName ?? (await defaultStationName(actor, origin.stationKey));
  if (input.displayName !== undefined) {
    const trimmed = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (trimmed === '' || trimmed.length > PRINT_LIMITS.stationNameMax) throw new ValidationError('validation.print.station');
    displayName = trimmed;
  }

  const row = await printRepo.upsertStation(actor.tenantId, origin.stationKey, {
    displayName,
    printerName,
    autoPrint: input.autoPrint,
  });
  return toStation(row, (await printRepo.databaseNow()).getTime(), origin.stationKey);
}

async function defaultStationName(_actor: ActorContext, stationKey: string): Promise<string> {
  if (stationKey === MASTER_STATION_KEY) return 'Master PC';
  const panel = await panelRepo.findPanelById(stationKey.slice('panel:'.length));
  return panel?.name?.slice(0, PRINT_LIMITS.stationNameMax) || 'Office PC';
}
