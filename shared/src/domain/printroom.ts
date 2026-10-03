/**
 * The Printroom (1.3 Phase 7, migration #6): a shared print queue, and the
 * auto-print station that works it.
 *
 * Anybody holding `print.send` can send a pending or a final order's Filling
 * note or Dispatch note; the PC with the printer (a holder of `print.station`)
 * prints it. The Master builds the frozen note itself at send time, so the
 * printer PC never depends on its own snapshot or party scope; the sender only
 * names the record, the copies, an optional vehicle number and a short note.
 *
 * A job is `queued` until a station takes it, `printing` while one holds it,
 * then `printed` (undoable: back to `queued`) or `cancelled` (final). The
 * station's claim is held by the **connection** that made it, so a station that
 * drops releases the job and two stations never print the same sheet.
 *
 * Pure: no clock, no I/O.
 */

import type { MessageKey } from '../i18n/keys.js';
import type { IsoTimestamp, UserAvatar, Uuid } from './entities.js';
import type { NoteDocument, NoteKind, NoteSource } from './order-note.js';
import { NOTE_MAX_COPIES, cleanVehicleNumber } from './order-note.js';
import type { RoleTier } from './permissions.js';

/**
 * The first panel protocol that speaks Printroom: its eight commands
 * (`COMMAND_MIN_PROTOCOL`) and the `print:changed` push. Frozen here, never tied
 * to `PANEL_PROTOCOL_VERSION`, which keeps rising.
 */
export const PRINTROOM_MIN_PROTOCOL = 6;

export const PRINT_JOB_STATUSES = ['queued', 'printing', 'printed', 'cancelled'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/** What the list screens ask for: the Waiting tab is queued and printing together. */
export type PrintJobFilter = 'waiting' | 'printed' | 'cancelled' | 'all';

export const PRINT_LIMITS = {
  noteMax: 200,
  stationNameMax: 60,
  printerNameMax: 200,
  pageSize: 30,
  pageMax: 100,
  /** Longest a station may hold a job before another may take it (ms). */
  claimStaleMs: 10 * 60 * 1000,
  /** A station heard from within this long is shown online (ms). */
  stationOnlineMs: 90_000,
  /** How often a running station says it is alive (ms). */
  stationBeatMs: 60_000,
  /** A printed or cancelled job's frozen note is dropped after this many days. */
  payloadKeepDays: 30,
} as const;

export const MAX_PRINT_COPIES = NOTE_MAX_COPIES;

/** Who is named on a job: the sender, or whoever printed or cancelled it. */
export interface PrintPerson {
  id: string;
  displayName: string;
  avatar: UserAvatar | null;
  tier: RoleTier;
}

/** A job as the lists and the push show it: never the frozen note itself. */
export interface PrintJobSummary {
  id: Uuid;
  kind: NoteKind;
  source: NoteSource;
  sourceId: string;
  /** The PO number at send time; null before the record had one. */
  sourceNumber: string | null;
  partyName: string;
  copies: number;
  note: string | null;
  targetStation: { id: Uuid; name: string } | null;
  status: PrintJobStatus;
  sender: PrintPerson | null;
  /** The sender's PC: a panel's device code, `master`, or `lan`. */
  requestedFrom: string | null;
  requestedAt: IsoTimestamp;
  claimedAt: IsoTimestamp | null;
  /** The station holding a `printing` job. */
  claimedStationName: string | null;
  printedBy: PrintPerson | null;
  printedAt: IsoTimestamp | null;
  printerName: string | null;
  printedStationName: string | null;
  cancelledBy: PrintPerson | null;
  cancelledAt: IsoTimestamp | null;
  /** False once the frozen note has been dropped (30 days after printing or cancelling). */
  hasDocument: boolean;
}

/** One job with the sheet it prints. `document` is null once dropped. */
export interface PrintJob extends PrintJobSummary {
  document: NoteDocument | null;
}

export interface PrintJobInput {
  /** 32 hex characters made by the sender, so a retried send returns the same job. */
  requestId: string;
  kind: NoteKind;
  source: NoteSource;
  sourceId: string;
  copies: number;
  targetStationId?: string | null;
  vehicleNumber?: string | null;
  note?: string | null;
}

export interface PrintJobQuery {
  status?: PrintJobFilter;
  /** Only the jobs the acting person sent. A sender without `print.station` is always limited to these. */
  mine?: boolean;
  cursor?: string | null;
  limit?: number;
}

export interface PrintJobPage {
  jobs: PrintJobSummary[];
  nextCursor: string | null;
  /** Jobs waiting for paper (queued or printing) in the acting person's view. */
  waitingCount: number;
}

export interface PrintStation {
  id: Uuid;
  name: string;
  printerName: string | null;
  autoPrint: boolean;
  online: boolean;
  lastSeenAt: IsoTimestamp | null;
  /** This PC's own station (the caller's). */
  isSelf: boolean;
}

export interface PrintStationInput {
  displayName?: string;
  printerName: string | null;
  autoPrint: boolean;
}

/** What the push carries: the summary, addressed to one person by `forUserId`. */
export type PrintPush = PrintJobSummary;

/** Request ids are 32 hex characters (`crypto.getRandomValues`; `randomUUID` is absent on insecure origins). */
export const PRINT_REQUEST_ID = /^[0-9a-f]{32}$/;

/** A station key is derived on the Master, never read from a body. */
export const MASTER_STATION_KEY = 'master';
export const panelStationKey = (panelId: string): string => `panel:${panelId}`;

/** Copies as a whole number 1..50, or null for anything else (the Master refuses, it does not round). */
export function parsePrintCopies(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PRINT_COPIES
    ? value
    : null;
}

export type CleanPrintInput = { value: Required<PrintJobInput> } | { errorKey: MessageKey };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for the uuid shape station ids have. */
export function isStationId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Validates a send. Nothing is rounded or defaulted silently: a bad field is a
 * refusal naming itself. The vehicle number is cleaned, and kept only for a
 * Dispatch note (a Filling note has no vehicle line).
 */
export function cleanPrintJobInput(raw: unknown): CleanPrintInput {
  const input = (raw ?? {}) as Record<string, unknown>;

  if (typeof input.requestId !== 'string' || !PRINT_REQUEST_ID.test(input.requestId)) {
    return { errorKey: 'validation.print.requestId' };
  }
  if (input.kind !== 'filling' && input.kind !== 'dispatch') return { errorKey: 'validation.print.kind' };
  if (input.source !== 'lead' && input.source !== 'order') return { errorKey: 'validation.print.source' };
  if (typeof input.sourceId !== 'string' || !ID_PATTERN.test(input.sourceId)) {
    return { errorKey: 'validation.print.source' };
  }
  const copies = parsePrintCopies(input.copies);
  if (copies === null) return { errorKey: 'validation.print.copies' };

  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') return { errorKey: 'validation.print.note' };
    const trimmed = input.note.trim();
    if (trimmed.length > PRINT_LIMITS.noteMax) return { errorKey: 'validation.print.note' };
    note = trimmed === '' ? null : trimmed;
  }

  let targetStationId: string | null = null;
  if (input.targetStationId !== undefined && input.targetStationId !== null) {
    if (!isStationId(input.targetStationId)) return { errorKey: 'validation.print.station' };
    targetStationId = input.targetStationId;
  }

  let vehicleNumber: string | null = null;
  if (input.vehicleNumber !== undefined && input.vehicleNumber !== null) {
    if (typeof input.vehicleNumber !== 'string') return { errorKey: 'validation.print.vehicle' };
    const cleaned = cleanVehicleNumber(input.vehicleNumber).trim();
    if (cleaned.length > 20) return { errorKey: 'validation.print.vehicle' };
    vehicleNumber = cleaned === '' || input.kind !== 'dispatch' ? null : cleaned;
  }

  return {
    value: {
      requestId: input.requestId,
      kind: input.kind,
      source: input.source,
      sourceId: input.sourceId,
      copies,
      targetStationId,
      vehicleNumber,
      note,
    },
  };
}

/** The Waiting tab's statuses. */
export function isWaiting(status: PrintJobStatus): boolean {
  return status === 'queued' || status === 'printing';
}

/** Whether a station heard from at `lastSeenAt` is online at `nowMs`. */
export function stationOnline(lastSeenAt: string | null, nowMs: number): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && nowMs - seen <= PRINT_LIMITS.stationOnlineMs;
}

/** The query a screen sends, cleaned: a known filter, a page size in range. */
export function normalisePrintQuery(raw: unknown): Required<Omit<PrintJobQuery, 'cursor'>> & { cursor: string | null } {
  const q = (raw ?? {}) as Record<string, unknown>;
  const filters: readonly string[] = ['waiting', 'printed', 'cancelled', 'all'];
  const limit =
    typeof q.limit === 'number' && Number.isFinite(q.limit)
      ? Math.min(PRINT_LIMITS.pageMax, Math.max(1, Math.floor(q.limit)))
      : PRINT_LIMITS.pageSize;
  return {
    status: typeof q.status === 'string' && filters.includes(q.status) ? (q.status as PrintJobFilter) : 'waiting',
    mine: q.mine === true,
    cursor: typeof q.cursor === 'string' && q.cursor !== '' ? q.cursor : null,
    limit,
  };
}
