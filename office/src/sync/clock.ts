/**
 * This panel's hybrid logical clock.
 *
 * Persisted for the same reason the Master's is: a clock that rewinds on
 * restart would let an edit made after the restart sort *before* one made just
 * before it, and the merge would then silently prefer the older value.
 *
 * Writes are debounced — unlike the id counter, a clock that loses its last few
 * ticks is harmless. The physical component recovers from the wall clock, and
 * the counter only matters within a single millisecond.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { initialHlcState, observeHlc, tickHlc, type HlcState } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { deviceCode } from './device.js';

const PERSIST_DEBOUNCE_MS = 1000;

let state: HlcState | null = null;
let persistTimer: NodeJS.Timeout | null = null;

/** Stamp a locally-originated edit. */
export async function stamp(): Promise<string> {
  const current = await load();
  const next = tickHlc(current, Date.now());

  state = next.state;
  schedulePersist();
  return next.hlc;
}

/**
 * Fold the Master's clock into this one.
 *
 * Called with every snapshot, which is what keeps a panel's later edits sorting
 * after everything it has already been told about — even if this PC's clock is
 * minutes behind the Master's.
 */
export async function observe(remoteHlc: string): Promise<void> {
  const current = await load();
  state = observeHlc(current, remoteHlc, Date.now()).state;
  schedulePersist();
}

async function load(): Promise<HlcState> {
  if (state) return state;

  const code = await deviceCode();

  try {
    const raw = await fs.readFile(paths().clockFile, 'utf8');
    const stored = JSON.parse(raw) as HlcState;

    // The device code can change at pairing; the clock's progress should not be
    // thrown away with it.
    state = { deviceCode: code, physical: stored.physical, counter: stored.counter };
  } catch {
    state = initialHlcState(code);
  }

  return state;
}

function schedulePersist(): void {
  if (persistTimer) return;

  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (state) void persist(state);
  }, PERSIST_DEBOUNCE_MS);

  // Never hold the process open just to write a clock file.
  persistTimer.unref?.();
}

async function persist(value: HlcState): Promise<void> {
  await fs.mkdir(path.dirname(paths().clockFile), { recursive: true });
  await fs.writeFile(paths().clockFile, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** Test seam. */
export function resetClockCache(): void {
  state = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
