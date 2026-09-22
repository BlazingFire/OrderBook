/**
 * Restoring the snapshot from disk, and the window that used to exist inside it.
 *
 * `restore()` set `loaded = true` before awaiting the `readFile`, so a second
 * caller arriving in that window was told the store was loaded and handed a
 * `snapshot` still sitting at `null`. That was harmless while every reader
 * treated null as "no data yet". It stopped being harmless when
 * `cachedFeatures()` started answering `security.offlineSignInEnabled` from it:
 * a millisecond-wide fail-open on a security gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let dataDir: string;

vi.mock('../src/config/index.js', () => ({
  get config() {
    return { dataDir, packageRoot: dataDir };
  },
}));

const localStore = await import('../src/sync/local-store.js');

function snapshotWith(offlineSignInEnabled: boolean) {
  return {
    parties: [],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [],
    orders: [],
    stock: [],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: {} as never,
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-09-18T00:00:00.000Z',
    features: { freeToSell: true, offlineSignInEnabled },
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-store-'));
  localStore.resetLocalStore();
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('restore', () => {
  it('gives every concurrent caller the snapshot, not the first one only', async () => {
    await localStore.setSnapshot(snapshotWith(false));
    localStore.resetLocalStore();

    // Started together, deliberately without awaiting the first: this is the
    // window. Before the shared promise, the second call returned null.
    const [first, second, third] = await Promise.all([
      localStore.restore(),
      localStore.restore(),
      localStore.restore(),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
  });

  it('answers the cached switch the same way to concurrent callers', async () => {
    // The consequence that matters. Two sign-in attempts landing together on a
    // freshly restarted panel must not get different answers about whether this
    // company allows signing in offline.
    await localStore.setSnapshot(snapshotWith(false));
    localStore.resetLocalStore();

    const answers = await Promise.all([
      localStore.cachedFeatures(),
      localStore.cachedFeatures(),
      localStore.cachedFeatures(),
    ]);

    for (const features of answers) {
      expect(features?.offlineSignInEnabled).toBe(false);
    }
  });

  it('answers null when the panel has never synced', async () => {
    // Not an error, and every caller resolves it to the setting's own fallback
    // rather than deciding for itself.
    expect(await localStore.cachedFeatures()).toBeNull();
  });

  it('answers null rather than throwing on a torn snapshot file', async () => {
    // snapshot.json is written with a plain writeFile, not the temp-then-rename
    // the outbox uses, so a power cut mid-write leaves exactly this.
    await fs.writeFile(path.join(dataDir, 'snapshot.json'), '{"snapshot":{"par');
    expect(await localStore.cachedFeatures()).toBeNull();
  });
});
