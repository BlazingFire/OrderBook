/**
 * Hybrid Logical Clocks — the ordering primitive the whole offline story rests
 * on (docs/LEAD_GENERATION_FLOW.md §4.5, §7).
 *
 * A plain wall clock cannot order edits made on two panels that were never
 * connected: their clocks drift, and a laptop whose battery died can come back
 * minutes behind. A plain logical counter orders them consistently but produces
 * timestamps a human cannot read. An HLC is both — it tracks wall time closely
 * enough to be meaningful in a UI, while guaranteeing that if edit A causally
 * precedes edit B then `compareHlc(A, B) < 0`, whatever the clocks say.
 *
 * Encoded as a fixed-width string so that **lexicographic order is causal
 * order**. That is what lets Postgres sort by it with a plain btree index and
 * lets the merge code compare with `<` — no parsing on the hot path.
 *
 *     0001755870000000-00003-A3F9K2
 *     └ physical ms ──┘ └cnt┘ └device┘
 *
 * This module is pure: no I/O, no clock reads of its own. The caller passes the
 * current time in, which is what makes the merge logic testable.
 */

import { DEVICE_CODE_LENGTH } from './ids.js';

/** Wall-clock milliseconds, zero-padded so string order matches numeric order. */
const PHYSICAL_DIGITS = 16;
/** Ticks within the same millisecond. 99_999 events in one ms is not reachable. */
const COUNTER_DIGITS = 5;
const COUNTER_MAX = 10 ** COUNTER_DIGITS - 1;


export interface HlcParts {
  /** Milliseconds since the epoch, as tracked by the clock (never moves backwards). */
  physical: number;
  /** Disambiguates events sharing a physical millisecond. */
  counter: number;
  /** The device that produced the event — the final, deterministic tie-break. */
  deviceCode: string;
}

/** An HLC timestamp in its encoded, sortable form. */
export type Hlc = string;

export function formatHlc(parts: HlcParts): Hlc {
  const physical = String(parts.physical).padStart(PHYSICAL_DIGITS, '0');
  const counter = String(parts.counter).padStart(COUNTER_DIGITS, '0');
  return `${physical}-${counter}-${parts.deviceCode}`;
}

export function parseHlc(value: Hlc): HlcParts {
  const physical = Number(value.slice(0, PHYSICAL_DIGITS));
  const counter = Number(value.slice(PHYSICAL_DIGITS + 1, PHYSICAL_DIGITS + 1 + COUNTER_DIGITS));
  const deviceCode = value.slice(PHYSICAL_DIGITS + COUNTER_DIGITS + 2);

  if (!Number.isFinite(physical) || !Number.isFinite(counter) || !deviceCode) {
    throw new Error(`Malformed HLC timestamp: ${value}`);
  }

  return { physical, counter, deviceCode };
}

/**
 * Total order over HLC timestamps. Because the encoding is fixed-width, this is
 * just a string comparison — but it is worth having as a named function so call
 * sites read as intent ("which edit is newer") rather than as string trivia.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A device's clock. Deliberately a value + pure transitions rather than a class
 * with a hidden `Date.now()`: the Master persists its clock state across
 * restarts, and the tests need to drive time by hand.
 */
export interface HlcState {
  readonly deviceCode: string;
  readonly physical: number;
  readonly counter: number;
}

export function initialHlcState(deviceCode: string): HlcState {
  if (deviceCode.length !== DEVICE_CODE_LENGTH) {
    throw new Error(`Device code must be ${DEVICE_CODE_LENGTH} characters, got "${deviceCode}"`);
  }
  return { deviceCode, physical: 0, counter: 0 };
}

/**
 * Stamp a locally-originated event.
 *
 * The clock never runs backwards: if the wall clock has gone back (NTP
 * correction, a user changing the date on the shop PC), the logical part
 * advances instead. Edits made after a clock correction therefore still sort
 * after edits made before it.
 */
export function tickHlc(state: HlcState, wallClockMs: number): { state: HlcState; hlc: Hlc } {
  const physical = Math.max(state.physical, Math.floor(wallClockMs));
  const counter = physical === state.physical ? state.counter + 1 : 0;

  assertCounterInRange(counter, physical);

  const next: HlcState = { deviceCode: state.deviceCode, physical, counter };
  return { state: next, hlc: formatHlc(next) };
}

/**
 * Fold a timestamp received from another device into this clock.
 *
 * This is what makes the ordering *causal* rather than merely per-device: after
 * observing a remote edit, everything this device stamps afterwards sorts after
 * that edit — even if this machine's wall clock is behind the other one's.
 */
export function observeHlc(
  state: HlcState,
  remote: Hlc,
  wallClockMs: number,
): { state: HlcState; hlc: Hlc } {
  const incoming = parseHlc(remote);
  const physical = Math.max(state.physical, incoming.physical, Math.floor(wallClockMs));

  let counter: number;
  if (physical === state.physical && physical === incoming.physical) {
    counter = Math.max(state.counter, incoming.counter) + 1;
  } else if (physical === state.physical) {
    counter = state.counter + 1;
  } else if (physical === incoming.physical) {
    counter = incoming.counter + 1;
  } else {
    counter = 0;
  }

  assertCounterInRange(counter, physical);

  const next: HlcState = { deviceCode: state.deviceCode, physical, counter };
  return { state: next, hlc: formatHlc(next) };
}

function assertCounterInRange(counter: number, physical: number): void {
  if (counter > COUNTER_MAX) {
    // Only reachable if the wall clock is stuck while thousands of edits land.
    // Failing loudly beats silently wrapping and producing an out-of-order id.
    throw new Error(`HLC counter overflow at physical time ${physical}`);
  }
}
