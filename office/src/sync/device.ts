/**
 * This panel's identity for offline work (docs/LEAD_GENERATION_FLOW.md §7).
 *
 * Two pieces of state, both durable:
 *  · the **device code**, derived from the panel id the Master issued, so it
 *    survives a reinstall and stays the same value the Master has on file;
 *  · a **local counter**, which makes each temporary id unique on this machine.
 *
 * The counter is persisted on every allocation rather than periodically. That
 * is a file write per record created offline, which sounds wasteful until you
 * consider the alternative: a panel that crashes after issuing ids 1–40 and
 * restarts believing it is at 20 would mint duplicates for records the Master
 * has never seen and cannot disambiguate.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { deviceCodeFromSeed, formatTemporaryId } from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { loadCredentials } from '../services/credentials.store.js';

const log = createLogger('device');

interface DeviceState {
  deviceCode: string;
  counter: number;
}

let cached: DeviceState | null = null;

/**
 * Derived from the paired panel id, not stored independently. An unpaired panel
 * still needs *some* code so drafts can be written before pairing completes;
 * it gets one from its hostname, and re-derives the real one once paired.
 */
export async function deviceCode(): Promise<string> {
  const state = await load();
  return state.deviceCode;
}

export async function nextTemporaryId(): Promise<string> {
  const state = await load();
  const counter = state.counter + 1;

  await save({ ...state, counter });
  return formatTemporaryId(state.deviceCode, counter);
}

/**
 * Re-derive the device code after pairing.
 *
 * The counter deliberately does **not** reset: ids minted before pairing were
 * already written into local records, and reusing those numbers under a new
 * code would be fine, but reusing them under the *same* code would not — and
 * the code only changes if pairing changed it.
 */
export async function refreshAfterPairing(): Promise<void> {
  const credentials = await loadCredentials();
  if (!credentials) return;

  const state = await load();
  const derived = deviceCodeFromSeed(credentials.panelId);

  if (derived !== state.deviceCode) {
    log.info(`Device code is now ${derived}`);
    await save({ deviceCode: derived, counter: state.counter });
  }
}

async function load(): Promise<DeviceState> {
  if (cached) return cached;

  try {
    const raw = await fs.readFile(config.deviceFile, 'utf8');
    cached = JSON.parse(raw) as DeviceState;
    return cached;
  } catch {
    const credentials = await loadCredentials();
    const seed = credentials?.panelId ?? config.hostname;

    cached = { deviceCode: deviceCodeFromSeed(seed), counter: 0 };
    await save(cached);
    return cached;
  }
}

async function save(state: DeviceState): Promise<void> {
  cached = state;
  await fs.mkdir(path.dirname(config.deviceFile), { recursive: true });
  await fs.writeFile(config.deviceFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Test seam: drops the in-memory cache so the next read hits disk. */
export function resetDeviceCache(): void {
  cached = null;
}
