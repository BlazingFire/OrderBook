/**
 * A new pending order's save waits for its number (1.3 Phase 4, rule 2).
 *
 * `awaitSettled` is what lets `POST /api/leads` answer with the Master's
 * PO number while the link is up, and fall back to Provisional when it is not.
 * These drive the real outbox and sync service against a fake transport, so no
 * Master or database is needed.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Mutation, SyncPushResponse, SyncSnapshot } from '@orderbook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-settle-'));
  process.env.ORDERBOOK_OFFICE_DATA_DIR = dataDir;
  // Long enough that only the rerun flag, never the retry timer, can explain a
  // second push inside a test.
  process.env.OFFICE_SYNC_RETRY_MS = '60000';
  vi.resetModules();
});

afterEach(async () => {
  const sync = await import('../src/sync/sync.service.js');
  sync.stopSync();
  delete process.env.ORDERBOOK_OFFICE_DATA_DIR;
  delete process.env.OFFICE_SYNC_RETRY_MS;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function loadModules() {
  const device = await import('../src/sync/device.js');
  const outbox = await import('../src/sync/outbox.store.js');
  const localStore = await import('../src/sync/local-store.js');
  const clock = await import('../src/sync/clock.js');
  const sync = await import('../src/sync/sync.service.js');

  device.resetDeviceCache();
  outbox.resetOutboxCache();
  localStore.resetLocalStore();
  clock.resetClockCache();

  return { outbox, localStore, sync };
}

const SNAPSHOT = {
  parties: [],
  products: [],
  categories: [],
  partyVariants: [],
  leads: [],
  orders: [],
  pipelines: [],
  optionLists: [],
  customFields: [],
  conflicts: [],
  dashboard: { asOf: '2026-10-01T00:00:00.000Z' },
  permissions: ['leads.create'],
  serverHlc: '',
  serverTime: '2026-10-01T00:00:00.000Z',
} as unknown as SyncSnapshot;

const newLead = (temporaryId: string) => ({
  kind: 'lead.create' as const,
  entity: 'lead' as const,
  entityId: temporaryId,
  payload: { partyId: 'PT0000000001', items: [] },
});

/** The Master numbering every `lead.create` it is handed, from 41 on. */
function numberingMaster() {
  let next = 41;
  const pushes: Mutation[][] = [];
  const answer = (mutations: Mutation[]): SyncPushResponse => {
    pushes.push(mutations);
    const numbered = mutations.map((mutation) => {
      next += 1;
      return { mutation, permanentId: `LD00000000${next}`, number: `PO/2026-27/000${next}` };
    });
    return {
      results: numbered.map(({ mutation, permanentId, number }) => ({
        mutationId: mutation.mutationId,
        status: 'applied',
        entityId: permanentId,
        conflicts: [],
        number,
      })),
      idMappings: numbered.map(({ mutation, permanentId }) => ({
        tenantId: 't1',
        entity: 'lead',
        temporaryId: mutation.entityId,
        permanentId,
        deviceCode: 'A3F9K2',
        createdAt: '2026-10-01T00:00:00.000Z',
      })),
      serverHlc: '',
    };
  };
  return { pushes, answer };
}

describe('awaitSettled', () => {
  it('resolves with the permanent id and PO number once the push is answered', async () => {
    const { sync } = await loadModules();
    const master = numberingMaster();
    sync.setTransport(async (mutations) => master.answer(mutations));

    const numbered: unknown[] = [];
    sync.onNumbered((event) => numbered.push(event));

    const mutation = await sync.submit(newLead('A3F9K2000000001'));
    const settled = await sync.awaitSettled(mutation.mutationId, 2000);

    expect(settled).toMatchObject({
      permanentId: 'LD0000000042',
      poNumber: 'PO/2026-27/00042',
      result: { status: 'applied' },
    });
    expect(numbered).toEqual([
      {
        entity: 'lead',
        temporaryId: 'A3F9K2000000001',
        permanentId: 'LD0000000042',
        poNumber: 'PO/2026-27/00042',
        announced: true,
        forUserId: null,
      },
    ]);
  });

  it('resolves null on timeout while there is no Master, and the lead stays queued', async () => {
    const { outbox, sync } = await loadModules();

    const mutation = await sync.submit(newLead('A3F9K2000000001'));
    const settled = await sync.awaitSettled(mutation.mutationId, 50);

    expect(settled).toBeNull();
    expect(await outbox.pendingCount()).toBe(1);
  });

  it('survives a flush already in flight: the second save is pushed straight after', async () => {
    const { sync } = await loadModules();
    const master = numberingMaster();

    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    sync.setTransport(async (mutations) => {
      calls += 1;
      if (calls === 1) await firstHeld;
      return master.answer(mutations);
    });

    const first = await sync.submit(newLead('A3F9K2000000001'));
    // The first flush has taken its batch and is blocked in the transport.
    await vi.waitFor(() => expect(calls).toBe(1));

    const second = await sync.submit(newLead('A3F9K2000000002'));
    const waiting = sync.awaitSettled(second.mutationId, 2000);
    releaseFirst();

    const settled = await waiting;
    expect(settled?.permanentId).toBeDefined();
    expect(settled?.poNumber).toMatch(/^PO\/2026-27\/\d{5}$/);
    // Two pushes, so the second save did not ride the first one's batch.
    expect(master.pushes).toHaveLength(2);
    expect(master.pushes[0]?.map((m) => m.mutationId)).toEqual([first.mutationId]);
    expect(master.pushes[1]?.map((m) => m.mutationId)).toEqual([second.mutationId]);
  });

  it('answers a waiter that arrives after the push already came back', async () => {
    const { outbox, sync } = await loadModules();
    const master = numberingMaster();
    sync.setTransport(async (mutations) => master.answer(mutations));

    const mutation = await sync.submit(newLead('A3F9K2000000001'));
    await vi.waitFor(async () => expect(await outbox.pendingCount()).toBe(0));

    expect(await sync.awaitSettled(mutation.mutationId, 50)).toMatchObject({
      poNumber: 'PO/2026-27/00042',
    });
  });

  it('announces a number nobody waited for, so the open screen can follow it', async () => {
    const { outbox, sync } = await loadModules();
    await outbox.enqueue({ ...newLead('A3F9K2000000001'), actorUserId: 'U-saver' });

    const numbered: Array<{ announced: boolean }> = [];
    sync.onNumbered((event) => numbered.push(event));
    const master = numberingMaster();
    sync.setTransport(async (mutations) => master.answer(mutations));
    // Queued work goes up while its author is the one signed in.
    sync.setActingUser(() => 'U-saver');

    await sync.flush();

    expect(numbered).toEqual([
      expect.objectContaining({
        announced: false,
        poNumber: 'PO/2026-27/00042',
        forUserId: 'U-saver',
      }),
    ]);
  });
});

describe('the local view after a lead is numbered', () => {
  it('keeps the lead under its temporary id until the permanent record replaces it', async () => {
    const { localStore, sync } = await loadModules();
    await localStore.setSnapshot({ ...SNAPSHOT, leads: [] });
    const master = numberingMaster();
    sync.setTransport(async (mutations) => master.answer(mutations));

    const mutation = await sync.submit(newLead('A3F9K2000000001'));
    await sync.awaitSettled(mutation.mutationId, 2000);

    // Settled, and the Master's data:changed has not landed yet.
    const before = await localStore.getView();
    expect(before?.pendingCount).toBe(0);
    expect(before?.leads.map((lead) => [lead.id, lead.poNumber])).toEqual([
      ['A3F9K2000000001', 'PO/2026-27/00042'],
    ]);

    // The permanent record arrives, the way master-connection applies it.
    const raw = localStore.getRawSnapshot();
    raw?.leads.push({ ...before!.leads[0]!, id: 'LD0000000042' });
    localStore.noteApplied(undefined, null);

    const after = await localStore.getView();
    expect(after?.leads.map((lead) => lead.id)).toEqual(['LD0000000042']);
  });
});
