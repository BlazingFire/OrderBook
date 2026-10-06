/**
 * Whose queued work the view draws.
 *
 * A party or lead somebody queued offline is shown to them straight away, so a creator
 * still sees their own party before the Master confirms it. It is not shown to whoever
 * signs in next on the same PC: the Master's party scoping only decides who sees a record
 * once it has the record, and until then this view is the only thing standing in the way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Mutation, Party } from '@orderbook/shared';

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

const A = 'US000000000A';
const B = 'US000000000B';

const existing = { id: 'PT0000000001', name: 'Open Co' } as unknown as Party;

function snapshot() {
  return {
    parties: [existing],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [],
    orders: [],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: {} as never,
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-10-06T00:00:00.000Z',
    features: { offlineSignInEnabled: false },
  };
}

const partyCreate = (id: string, name: string, actorUserId: string | null): Mutation =>
  ({
    mutationId: `m-${id}`,
    kind: 'party.create',
    entity: 'party',
    entityId: id,
    payload: { name },
    fields: ['name'],
    hlc: '1',
    deviceCode: 'OF1',
    baseFieldHlc: {},
    actorUserId,
    createdAt: '2026-10-06T00:00:00.000Z',
  }) as Mutation;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-viewer-'));
  localStore.resetLocalStore();
  queued = [
    partyCreate('TMP0000000001', 'A Private Co', A),
    partyCreate('TMP0000000002', 'Shared Co', null),
  ];
  outboxRevision += 1;
  await localStore.setSnapshot(snapshot());
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const names = async () => (await localStore.getView())?.parties.map((party) => party.name).sort();

describe('the view of queued work', () => {
  it('shows a creator their own queued party, and the unattributed one', async () => {
    localStore.setViewer(() => A);
    expect(await names()).toEqual(['A Private Co', 'Open Co', 'Shared Co']);
  });

  it('names the parties the person signed in has queued, for the offline user switch to keep', async () => {
    localStore.setViewer(() => A);
    expect((await localStore.getView())?.ownQueuedPartyIds?.sort()).toEqual([
      'TMP0000000001',
      'TMP0000000002',
    ]);

    localStore.setViewer(() => B);
    expect((await localStore.getView())?.ownQueuedPartyIds).toEqual(['TMP0000000002']);
  });

  it('does not show it to the next person to sign in on the same PC', async () => {
    localStore.setViewer(() => B);
    expect(await names()).toEqual(['Open Co', 'Shared Co']);
  });

  it('does not show it while nobody is signed in', async () => {
    localStore.setViewer(() => null);
    expect(await names()).toEqual(['Open Co', 'Shared Co']);
  });

  it('counts as unsent only what the person signed in may see: their own and the unattributed', async () => {
    localStore.setViewer(() => A);
    expect((await localStore.getView())?.pendingCount).toBe(2);
    expect(await localStore.viewerPendingCount()).toBe(2);

    // The count is what `/api/sync` tells the browser: it must not say somebody else queued work.
    localStore.setViewer(() => B);
    expect((await localStore.getView())?.pendingCount).toBe(1);
    expect(await localStore.viewerPendingCount()).toBe(1);

    localStore.setViewer(() => null);
    expect(await localStore.viewerPendingCount()).toBe(1);
  });

  it('follows the person who signs in, without waiting for another change', async () => {
    localStore.setViewer(() => A);
    expect(await names()).toContain('A Private Co');

    localStore.setViewer(() => B);
    expect(await names()).not.toContain('A Private Co');
  });
});
