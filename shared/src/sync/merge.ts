/**
 * Field-level merge — the rule that decides what survives when two panels edit
 * the same record while both offline (docs/LEAD_GENERATION_FLOW.md §4.5).
 *
 * The requirement, stated plainly: edits to *different* fields must both
 * survive; edits to the *same* field resolve to the higher HLC, and the losing
 * value is kept visible rather than discarded.
 *
 * That is why records carry `fieldHlc` — a per-field map of who wrote it last —
 * instead of one timestamp per row. A single row-level timestamp would force an
 * all-or-nothing choice and silently drop the other panel's untouched fields.
 *
 * Pure: no database, no clock. The Master calls this inside its write
 * transaction; the tests call it directly.
 */

import type { MutationFieldConflict } from './mutations.js';
import { compareHlc, parseHlc } from './hlc.js';

export interface MergeCandidate {
  /** Fields this edit asserts. Fields outside this list are left alone. */
  fields: string[];
  values: Record<string, unknown>;
  /** Per-field HLC the editing panel believed was current. */
  baseFieldHlc: Record<string, string>;
  hlc: string;
  deviceCode: string;
}

export interface MergeTarget {
  values: Record<string, unknown>;
  fieldHlc: Record<string, string>;
}

export interface MergeOutcome {
  /** Fields to write, already filtered to the ones that won. */
  accepted: Record<string, unknown>;
  /** The record's `fieldHlc` map after the merge. */
  fieldHlc: Record<string, string>;
  /** Every field where two panels disagreed, winner and loser both recorded. */
  conflicts: MutationFieldConflict[];
  /** `merged` when at least one field clashed, `applied` when none did. */
  status: 'applied' | 'merged';
}

/**
 * Fields where a clash is *not* worth surfacing to a human, because
 * last-write-wins is the honest answer and a conflict row would be noise.
 *
 * `updatedAt` and friends are derived bookkeeping — two panels "disagreeing"
 * about them means nothing. Business fields are deliberately absent from this
 * list: a follow-up date or a phone number that got overwritten is exactly
 * what someone needs to be told about.
 */
const NON_CONFLICTING_FIELDS = new Set(['updatedAt', 'version', 'hlc', 'searchVector']);

/**
 * Whether a field's disagreement should be recorded for human review.
 *
 * Split out as its own function because it is a *business* judgement, not a
 * correctness one — the merge is already correct either way, this only decides
 * what a person gets asked about. Widen `NON_CONFLICTING_FIELDS` to make the
 * conflicts screen quieter; narrow it to catch more.
 */
export function isConflictWorthy(field: string): boolean {
  return !NON_CONFLICTING_FIELDS.has(field);
}

export function mergeFields(target: MergeTarget, incoming: MergeCandidate): MergeOutcome {
  const accepted: Record<string, unknown> = {};
  const fieldHlc: Record<string, string> = { ...target.fieldHlc };
  const conflicts: MutationFieldConflict[] = [];

  for (const field of incoming.fields) {
    const incomingValue = incoming.values[field];
    const storedHlc = target.fieldHlc[field];
    const baseHlc = incoming.baseFieldHlc[field];

    // The editor was looking at the value they replaced — an ordinary
    // sequential edit, whichever device made it. Nothing to report.
    if (storedHlc === baseHlc) {
      accepted[field] = incomingValue;
      fieldHlc[field] = incoming.hlc;
      continue;
    }

    // The field moved under the editor's feet. Somebody's value is about to be
    // shadowed, so decide which and keep the other one visible.
    const storedValue = target.values[field];

    if (storedHlc === undefined || compareHlc(incoming.hlc, storedHlc) > 0) {
      accepted[field] = incomingValue;
      fieldHlc[field] = incoming.hlc;

      if (storedHlc !== undefined && !valuesEqual(storedValue, incomingValue)) {
        pushConflict(conflicts, field, {
          losingValue: storedValue,
          winningValue: incomingValue,
          winningHlc: incoming.hlc,
          winningDeviceCode: incoming.deviceCode,
        });
      }
      continue;
    }

    // The stored value is newer: the incoming edit loses and is not written,
    // but it is recorded so the person who made it can see where it went.
    if (!valuesEqual(storedValue, incomingValue)) {
      pushConflict(conflicts, field, {
        losingValue: incomingValue,
        winningValue: storedValue,
        winningHlc: storedHlc,
        winningDeviceCode: safeDeviceCode(storedHlc),
      });
    }
  }

  return {
    accepted,
    fieldHlc,
    conflicts,
    status: conflicts.length > 0 ? 'merged' : 'applied',
  };
}

/**
 * A base for an edit that carries none.
 *
 * The Office outbox stores `{}` as the base of every lead and order edit, so
 * "stored clock newer than the base" would flag every second edit as a clash.
 * With no base at all, each field's stored clock is taken as the base when it
 * predates this edit: a newer edit wins as an ordinary edit, and an older one
 * still loses and is recorded as a conflict.
 */
export function baseForUnversionedEdit(
  fields: readonly string[],
  fieldHlc: Record<string, string>,
  hlc: string,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const field of fields) {
    const stored = fieldHlc[field];
    if (stored && compareHlc(hlc, stored) > 0) base[field] = stored;
  }
  return base;
}

function pushConflict(
  conflicts: MutationFieldConflict[],
  field: string,
  detail: Omit<MutationFieldConflict, 'field'>,
): void {
  if (!isConflictWorthy(field)) return;
  conflicts.push({ field, ...detail });
}

/**
 * Structural comparison, so re-sending an identical value is never reported as
 * a clash. Line-item arrays and custom-field objects both travel through here,
 * which is why this is not `===`.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Cyclic or otherwise unserializable: treat as different rather than throw
    // inside a write transaction.
    return false;
  }
}

function safeDeviceCode(hlc: string): string {
  try {
    return parseHlc(hlc).deviceCode;
  } catch {
    return 'unknown';
  }
}
