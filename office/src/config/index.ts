/**
 * Office Panel configuration. Like the Master, every value works out of the
 * box; environment variables exist for development and for running two panels
 * on one machine during testing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

import { loadEnvFiles } from '../lib/env-file.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..');

// See master/src/config/index.ts — same precedence, package file wins.
loadEnvFiles(path.join(packageRoot, '.env'), path.join(repoRoot, '.env'));

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const dataDir = process.env.ORDERBOOK_OFFICE_DATA_DIR
  ? path.resolve(process.env.ORDERBOOK_OFFICE_DATA_DIR)
  : path.join(packageRoot, 'data');

export const config = {
  packageRoot,
  dataDir,
  /** Pairing credentials issued by the Master. The only state this panel keeps. */
  credentialsFile: path.join(dataDir, 'pairing.json'),

  http: {
    // Loopback only: staff use the browser on this same PC, and nothing else
    // on the network has any reason to reach an Office Panel.
    host: process.env.OFFICE_HOST ?? '127.0.0.1',
    port: intFromEnv('OFFICE_PORT', 4200),
  },

  panelName: process.env.OFFICE_PANEL_NAME ?? `${hostname()} Office Panel`,
  hostname: hostname(),

  discovery: {
    /** How long to keep broadcasting before reporting that no Master answered. */
    timeoutMs: intFromEnv('OFFICE_DISCOVERY_TIMEOUT_MS', 8000),
  },
} as const;

export type Config = typeof config;
