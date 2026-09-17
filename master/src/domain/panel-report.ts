/**
 * Pure normalisation for the five-minute `panel:report` an Office Panel posts.
 *
 * The handler chain had no validation anywhere. `hub.ts` passes the socket
 * payload through verbatim (its comment there is about auth, not shape),
 * `panel.service.ts` routes it straight on, and
 * `office-panel.repository.ts#updateDeviceReport` writes it into typed columns:
 * `storageBytes`/`diskFreeBytes`/`diskTotalBytes` into BIGINTs, and
 * `report.startedAt ? new Date(report.startedAt) : null` into a timestamp.
 *
 * **The failure that matters is not the dropped report.** A `startedAt` that
 * does not parse makes `new Date(…)` an `Invalid Date`, and Postgres's date
 * serializer throws `RangeError: Invalid time value`. `refreshPanelReport`
 * routes through the same function, so an administrator merely *opening that
 * panel's detail card* hits the same throw and the panel administration screen
 * 500s until somebody fixes the row by hand. A non-integer or absurd
 * `storageBytes` reaches the BIGINT the same way.
 *
 * Strings are clamped rather than rejected: `dataDir` and `imagesDir` are
 * unbounded `TEXT`, so a panel could otherwise post a multi-megabyte hostname
 * every five minutes and nothing would stop it. Clamping keeps the useful part
 * of a long-but-honest value; rejecting would throw away a whole report because
 * one field was odd.
 *
 * Hand-written, matching the `assert*`/`normalise*` style this codebase already
 * uses (`field-values.ts`, `access.ts`). There is no schema-validation library
 * here and this is not the reason to add one.
 */

import type { IsoTimestamp, OfficePanelReportInput } from '@orderbook/shared';

/** Identifiers and version strings. Generous, but finite. */
const MAX_LABEL = 255;
/** Filesystem paths. Windows allows long paths; nothing sane reaches this. */
const MAX_PATH = 1024;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function nullableText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

/**
 * A byte count, or null.
 *
 * `Number.isSafeInteger` rather than `typeof === 'number'`: `1.5` and `1e30`
 * are both numbers and neither is a BIGINT. Negative is not a smaller disk, it
 * is a broken reading.
 */
function byteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function port(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : 0;
}

/**
 * An ISO timestamp the database will accept, or null.
 *
 * Re-serialised from the parsed date rather than passed through, so what lands
 * in the column is a value this process has already proved `Date` can read.
 */
function timestamp(value: unknown): IsoTimestamp | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : (parsed.toISOString() as IsoTimestamp);
}

/** A count of things the panel is holding right now, or null when it did not say. */
function runtimeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalisePanelReport(report: unknown): OfficePanelReportInput {
  const raw = (typeof report === 'object' && report !== null ? report : {}) as Record<
    string,
    unknown
  >;

  return {
    hostname: text(raw.hostname, MAX_LABEL),
    platform: text(raw.platform, MAX_LABEL),
    osVersion: text(raw.osVersion, MAX_LABEL),
    appVersion: text(raw.appVersion, MAX_LABEL),
    nodeVersion: text(raw.nodeVersion, MAX_LABEL),
    dataDir: text(raw.dataDir, MAX_PATH),
    imagesDir: text(raw.imagesDir, MAX_PATH),
    storageBytes: byteCount(raw.storageBytes),
    diskFreeBytes: byteCount(raw.diskFreeBytes),
    diskTotalBytes: byteCount(raw.diskTotalBytes),
    localPort: port(raw.localPort),
    // The column is nullable and the type is not, which is the one place these
    // two disagree; an unparseable time is stored as "we do not know" rather
    // than as a value that cannot be written at all.
    startedAt: timestamp(raw.startedAt) as IsoTimestamp,
    pendingMutations: runtimeCount(raw.pendingMutations),
    cachedImages: runtimeCount(raw.cachedImages),
    lastSnapshotAt: timestamp(raw.lastSnapshotAt),
    signedInUsername: nullableText(raw.signedInUsername, MAX_LABEL),
  };
}
