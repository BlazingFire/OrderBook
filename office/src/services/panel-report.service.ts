/**
 * What this panel tells the Master about the PC it is installed on.
 *
 * The Master cannot find any of this out for itself: an Office Panel serves its
 * HTTP API on loopback (`config/index.ts`), so nothing on the LAN can ask it a
 * question. Everything the Master's administration screen shows about a
 * machine — its name, its Windows version, where its files are, how full its
 * disk is — reaches it because the panel volunteered it here.
 *
 * Scope is deliberate and narrow: facts about **this** panel's own installation
 * and nothing about the people using it beyond who is signed in, which the
 * Master issued the session for in the first place.
 */

import os from 'node:os';
import type { OfficePanelReportInput, PanelStoragePathInput, PanelStoragePathResult } from '@orderbook/shared';

import { config } from '../config/index.js';
import { appVersion } from '../lib/app-version.js';
import {
  countFiles,
  directorySize,
  diskSpace,
  paths,
  relocateDataDir,
  StorageRelocationError,
} from '../config/paths.js';
import { createLogger } from '../lib/logger.js';
import * as localStore from '../sync/local-store.js';
import * as outbox from '../sync/outbox.store.js';
import { currentSession } from './user-session.service.js';

const log = createLogger('panel-report');

/**
 * Process start, captured at import.
 *
 * `os.uptime()` would be the machine's, not this panel's — and "that PC has
 * been on for six days" answers a different question from "this panel has been
 * running since the power cut this morning".
 */
const startedAt = new Date().toISOString();

export async function buildReport(): Promise<OfficePanelReportInput> {
  const current = paths();

  const [storageBytes, disk, pendingMutations, cachedImages] = await Promise.all([
    directorySize(current.dataDir),
    diskSpace(current.dataDir),
    outbox.pendingCount().catch(() => null),
    countFiles(current.imagesDir),
  ]);

  const session = currentSession();

  return {
    hostname: os.hostname(),
    platform: process.platform,
    osVersion: `${os.type()} ${os.release()}`,
    appVersion: appVersion(),
    nodeVersion: process.version,
    dataDir: current.dataDir,
    imagesDir: current.imagesDir,
    storageBytes,
    diskFreeBytes: disk?.free ?? null,
    diskTotalBytes: disk?.total ?? null,
    localPort: config.http.port,
    startedAt,
    pendingMutations,
    cachedImages,
    lastSnapshotAt: localStore.getRawSnapshot()?.serverTime ?? null,
    signedInUsername: session?.username ?? null,
  };
}

/**
 * Move this panel's files where the Master asked.
 *
 * The refusal path matters more than the happy one: this arrives from another
 * machine, from somebody who cannot see this PC's drives, so "D:\\ does not
 * exist here" has to come back as a sentence they can act on rather than a
 * stack trace. `StorageRelocationError` carries exactly those sentences.
 */
export async function moveStorage(input: PanelStoragePathInput): Promise<PanelStoragePathResult> {
  try {
    const result = await relocateDataDir(input.path, { moveExisting: input.moveExisting !== false });

    return {
      dataDir: result.dataDir,
      previousDataDir: result.previousDataDir,
      filesMoved: result.filesMoved,
      bytesMoved: result.bytesMoved,
      diskFreeBytes: result.diskFreeBytes,
    };
  } catch (error) {
    if (error instanceof StorageRelocationError) throw error;

    log.error('Could not move this panel’s storage', error);
    throw new StorageRelocationError(
      error instanceof Error ? error.message : 'Could not move this panel’s files',
    );
  }
}

