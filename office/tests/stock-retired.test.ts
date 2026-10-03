/**
 * A snapshot cached before stock and inventory were removed (1.4) must still load.
 *
 * The Office keeps its last snapshot on disk, so the first start after an update
 * reads a file written by the old program: `stock: [...]`, `reservations` on
 * every order, and a `lowStockCount` on the dashboard. A file written by the new
 * program has no `stock` key at all. Both must restore and build a view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Mutation } from '@orderbook/shared';

let dataDir: string;
let queued: Mutation[] = [];
let outboxRevision = 0;

vi.mock('../src/config/index.js', () => ({
  get config() {
    return { dataDir, packageRoot: dataDir };
  },
}));

vi.mock('../src/sync/outbox.store.js', () => ({
  pending: async () => queued,
  outboxRevision: () => outboxRevision,
}));

const localStore = await import('../src/sync/local-store.js');

const NOW = '2026-10-03T00:00:00.000Z';

function baseSnapshot() {
  return {
    parties: [],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [],
    orders: [{ id: 'OR0000000001', items: [], timeline: [] }],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: {} as never,
    permissions: [],
    serverHlc: '0',
    serverTime: NOW,
    features: { offlineSignInEnabled: false },
  };
}

const QUEUED_EDIT = {
  mutationId: 'm1',
  kind: 'lead.create',
  entity: 'lead',
  entityId: 'LD0000000001',
  payload: {},
  fields: [],
  hlc: '1',
  deviceCode: 'OF1',
  baseFieldHlc: {},
  actorUserId: null,
  createdAt: NOW,
} as unknown as Mutation;

/** What 1.3 wrote: stock rows, reservations on orders, a stock figure on the dashboard. */
function oldSnapshot() {
  const snapshot = baseSnapshot();
  snapshot.orders = [
    { id: 'OR0000000001', items: [], timeline: [], reservations: [{ id: 'RS1', boxes: 2 }] },
  ] as never;
  return {
    ...snapshot,
    stock: [{ productId: 'PR0000000001', quantityBoxes: 10, reservedBoxes: 2, availableBoxes: 8 }],
    dashboard: { lowStockCount: 2 } as never,
    features: { freeToSell: true, offlineSignInEnabled: false },
  };
}

async function writeFile(snapshot: unknown): Promise<void> {
  await fs.writeFile(path.join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-stock-retired-'));
  localStore.resetLocalStore();
  queued = [];
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('a cached snapshot from before stock was removed', () => {
  it('restores and builds its view with the old stock rows and reservations still in it', async () => {
    await writeFile(oldSnapshot());

    const idle = await localStore.getView();
    expect(idle?.orders).toHaveLength(1);

    // A queued edit forces the full rebuild path (`buildView`) rather than the spread.
    queued = [QUEUED_EDIT];
    outboxRevision += 1;
    await expect(localStore.getView()).resolves.toMatchObject({ orders: [{ id: 'OR0000000001' }] });
    expect((await localStore.cachedFeatures())?.offlineSignInEnabled).toBe(false);
  });

  it('restores and builds its view with no stock key at all', async () => {
    const snapshot: Record<string, unknown> = baseSnapshot();
    expect('stock' in snapshot).toBe(false);
    await writeFile(snapshot);

    const view = await localStore.getView();
    expect(view?.orders).toHaveLength(1);
    expect(view?.pendingCount).toBe(0);

    queued = [QUEUED_EDIT];
    outboxRevision += 1;
    await expect(localStore.getView()).resolves.toMatchObject({ pendingCount: 1 });
  });
});
