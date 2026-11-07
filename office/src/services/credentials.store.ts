/**
 * Persists the pairing credentials the Master issued to this panel, so the
 * connection screen only appears once and every later launch reconnects
 * silently.
 */

import fs from 'node:fs/promises';

import { paths } from '../config/paths.js';
import { writeDurable } from '../lib/durable-file.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('credentials');

export interface StoredCredentials {
  panelId: string;
  panelSecret: string;
  masterUniqueId: string;
  masterHost: string;
  masterPort: number;
  companyName: string | null;
  pairedAt: string;
}

let cached: StoredCredentials | null | undefined;

export async function loadCredentials(): Promise<StoredCredentials | null> {
  if (cached !== undefined) return cached;

  try {
    const raw = await fs.readFile(paths().credentialsFile, 'utf8');
    cached = JSON.parse(raw) as StoredCredentials;
  } catch {
    // Absent or unreadable file both mean "not paired yet" — the connection
    // screen handles it, there is nothing to recover.
    cached = null;
  }

  return cached;
}

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await writeDurable(paths().credentialsFile, JSON.stringify(credentials, null, 2));
  cached = credentials;
  log.info(`Paired with Master ${credentials.masterUniqueId} at ${credentials.masterHost}:${credentials.masterPort}`);
}

/** Used when the Master reports this panel's pairing was revoked. */
export async function clearCredentials(): Promise<void> {
  await fs.rm(paths().credentialsFile, { force: true });
  cached = null;
  log.warn('Pairing credentials cleared — this panel must pair again');
}

export function masterBaseUrl(credentials: StoredCredentials): string {
  return `http://${credentials.masterHost}:${credentials.masterPort}`;
}
