/**
 * The Office Panel's durable outbox and local view
 * (docs/LEAD_GENERATION_FLOW.md §2, §4).
 *
 * These run without a database or a Master, which is the point: the panel's
 * whole job when the link is down is to accept work and not lose it, and that
 * has to be provable without either.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTemporaryId, type SyncSnapshot } from '@orderbook/shared';

let dataDir: string;

/**
 * The config reads its paths at import time, so the temp directory has to be in
 * the environment before anything under `src/` is loaded — hence the dynamic
 * imports and the fresh module registry per test.
 */
async function loadModules() {
  const device = await import('../src/sync/device.js');
  const outbox = await import('../src/sync/outbox.store.js');
  const localStore = await import('../src/sync/local-store.js');
  const clock = await import('../src/sync/clock.js');

  device.resetDeviceCache();
  outbox.resetOutboxCache();
  localStore.resetLocalStore();
  clock.resetClockCache();

  return { device, outbox, localStore, clock };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-office-'));
  process.env.ORDERBOOK_OFFICE_DATA_DIR = dataDir;
  const { vi } = await import('vitest');
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ORDERBOOK_OFFICE_DATA_DIR;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('temporary ids', () => {
  it('mints ids in the documented shape and never repeats one', async () => {
    const { device } = await loadModules();

    const ids = [
      await device.nextTemporaryId(),
      await device.nextTemporaryId(),
      await device.nextTemporaryId(),
    ];

    expect(ids.every(isTemporaryId)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it('does not reissue a number after a restart', async () => {
    const { device } = await loadModules();
    const before = await device.nextTemporaryId();

    // Simulate the process dying and starting again: the counter must come
    // back from disk, not from zero, or the panel would mint ids for records
    // the Master has never seen and cannot tell apart.
    device.resetDeviceCache();

    const after = await device.nextTemporaryId();
    expect(after).not.toBe(before);
  });
});

describe('outbox', () => {
  it('survives a restart with its queue intact', async () => {
    const { outbox } = await loadModules();

    await outbox.enqueue({
      kind: 'lead.create',
      entity: 'lead',
      entityId: 'A3F9K2000000001',
      payload: { partyId: 'PT0000000001' },
    });

    outbox.resetOutboxCache();

    const pending = await outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('lead.create');
  });

  it('stamps each mutation with its own id, clock and device', async () => {
    const { outbox, device } = await loadModules();

    const first = await outbox.enqueue({
      kind: 'lead.create',
      entity: 'lead',
      entityId: 'A3F9K2000000001',
      payload: {},
    });
    const second = await outbox.enqueue({
      kind: 'lead.create',
      entity: 'lead',
      entityId: 'A3F9K2000000002',
      payload: {},
    });

    expect(first.mutationId).not.toBe(second.mutationId);
    expect(first.deviceCode).toBe(await device.deviceCode());
    // The clock advances, so a later edit sorts after an earlier one.
    expect(first.hlc < second.hlc).toBe(true);
  });

  it('records which fields an edit asserts, so a merge can be partial', async () => {
    const { outbox } = await loadModules();

    const mutation = await outbox.enqueue({
      kind: 'lead.update',
      entity: 'lead',
      entityId: 'LD0000000001',
      payload: { notes: 'called back', followUpDate: '2026-09-01' },
    });

    expect(mutation.fields.sort()).toEqual(['followUpDate', 'notes']);
  });

  it('drops only what the Master acknowledged', async () => {
    const { outbox } = await loadModules();

    const first = await outbox.enqueue({
      kind: 'lead.create',
      entity: 'lead',
      entityId: 'A3F9K2000000001',
      payload: {},
    });
    await outbox.enqueue({
      kind: 'lead.create',
      entity: 'lead',
      entityId: 'A3F9K2000000002',
      payload: {},
    });

    await outbox.settle([first.mutationId]);

    const remaining = await outbox.pending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.entityId).toBe('A3F9K2000000002');
  });

  it('rewrites queued follow-ups once the id they name is promoted', async () => {
    const { outbox } = await loadModules();
    const temporaryId = 'A3F9K2000000005';

    // Both were queued offline: the create, and a stage change made minutes
    // later that can only refer to the lead by its temporary id.
    await outbox.enqueue({ kind: 'lead.create', entity: 'lead', entityId: temporaryId, payload: {} });
    await outbox.enqueue({
      kind: 'lead.setStage',
      entity: 'lead',
      entityId: temporaryId,
      payload: { stageId: 's1' },
    });

    await outbox.settle([(await outbox.pending())[0]!.mutationId]);
    await outbox.remapIds(new Map([[temporaryId, 'LD0000000042']]));

    expect((await outbox.pending())[0]?.entityId).toBe('LD0000000042');
  });

  it('serialises concurrent saves rather than losing one', async () => {
    const { outbox } = await loadModules();

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        outbox.enqueue({
          kind: 'lead.create',
          entity: 'lead',
          entityId: `A3F9K200000000${index}`,
          payload: {},
        }),
      ),
    );

    // A last-write-wins file rewrite would silently drop most of these.
    expect(await outbox.pendingCount()).toBe(8);
  });
});

describe('local view', () => {
  const snapshot = {
    parties: [
      {
        id: 'PT0000000001',
        tenantId: 't1',
        name: 'Patel Tiles',
        partyCode: 'P-0001',
        phone: null,
        altPhone: null,
        email: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        state: null,
        pincode: null,
        gstNumber: null,
        notes: null,
        customFields: {},
        isActive: true,
        createdByUserId: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        sync: { version: 1, hlc: 'x', fieldHlc: {}, temporaryId: null },
      },
    ],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [],
    orders: [],
    stock: [],
    pipelines: [
      {
        id: 'p1',
        tenantId: 't1',
        kind: 'lead' as const,
        name: 'Lead pipeline',
        stages: [
          { id: 's1', pipelineId: 'p1', name: 'New', sequence: 1, isDefault: true, isTerminal: false, colour: null, isArchived: false },
          { id: 's2', pipelineId: 'p1', name: 'Quoted', sequence: 2, isDefault: false, isTerminal: false, colour: null, isArchived: false },
        ],
      },
    ],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: { asOf: '2026-08-01T00:00:00.000Z' },
    permissions: ['leads.create'],
    serverHlc: '0000001700000000000-00000-MASTER',
    serverTime: '2026-08-01T00:00:00.000Z',
  };

  it('shows a lead saved offline before the Master has ever seen it', async () => {
    const { outbox, localStore } = await loadModules();
    await localStore.setSnapshot(snapshot);

    await outbox.enqueue({
      kind: 'lead.create',
      entity: 'lead',
      entityId: 'A3F9K2000000001',
      payload: {
        partyId: 'PT0000000001',
        items: [{ productId: 'PR0000000001', quantities: [{ colour: 'Ivory', quantity: 2 }] }],
      },
    });

    const view = await localStore.getView();

    expect(view?.leads).toHaveLength(1);
    expect(view?.leads[0]).toMatchObject({
      id: 'A3F9K2000000001',
      partyName: 'Patel Tiles',
      stageName: 'New',
    });
    // An empty hlc is how the UI knows to draw the pending badge.
    expect(view?.leads[0]?.sync.hlc).toBe('');
    expect(view?.pendingCount).toBe(1);
  });

  it("names a queued party-wise line the party's own way, as the Master will", async () => {
    const { outbox, localStore } = await loadModules();
    // The Master resolves the party's record before the catalogue, so the
    // pending line must not show the catalogue name.
    await localStore.setSnapshot({
      ...snapshot,
      products: [
        {
          id: 'PR0000000001',
          tenantId: 't1',
          name: 'Glazed',
          alias: null,
          size: null,
          multiColour: false,
          variants: [{ id: 'VR1', productId: 'PR0000000001', code: 'GLZ-100', label: null, weightKg: 4 }],
        },
      ],
      partyVariants: [
        {
          id: 'PV1',
          tenantId: 't1',
          partyId: 'PT0000000001',
          productId: 'PR0000000001',
          productName: 'Glazed (Patel)',
          alias: 'GLZ',
        },
      ],
    } as unknown as SyncSnapshot);

    await outbox.enqueue({
      kind: 'lead.create',
      entity: 'lead',
      entityId: 'A3F9K2000000002',
      payload: {
        partyId: 'PT0000000001',
        partyWiseMode: true,
        items: [{ productId: 'PR0000000001', variantId: 'VR1', quantity: 2 }],
      },
    });

    const view = await localStore.getView();
    expect(view?.leads[0]?.items[0]?.productName).toBe('Glazed (Patel)');
    expect(view?.leads[0]?.items[0]?.alias).toBe('GLZ');
    expect(view?.leads[0]?.items[0]?.lineWeightKg).toBe(8);
    expect(view?.leads[0]?.totalWeightKg).toBe(8);
  });

  it('applies a queued stage change on top of a synced lead', async () => {
    const { outbox, localStore } = await loadModules();
    await localStore.setSnapshot({
      ...snapshot,
      leads: [
        {
          id: 'LD0000000001',
          tenantId: 't1',
          partyId: 'PT0000000001',
          partyName: 'Patel Tiles',
          ownerId: 'u1',
          ownerName: null,
          stageId: 's1',
          stageName: 'New',
          stageSequence: 1,
          sourcePlatform: null,
          followUpDate: null,
          partyWiseMode: false,
          notes: null,
          customFields: {},
          incomplete: false,
          missingFields: [],
          convertedOrderId: null,
          convertedAt: null,
          totalWeightKg: 0,
          linesWithoutWeight: 0,
          sourcePanelId: null,
          createdByUserId: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
          sync: { version: 1, hlc: 'y', fieldHlc: {}, temporaryId: null },
          items: [],
          timeline: [],
        },
      ],
    });

    await outbox.enqueue({
      kind: 'lead.setStage',
      entity: 'lead',
      entityId: 'LD0000000001',
      payload: { stageId: 's2' },
    });

    const view = await localStore.getView();
    expect(view?.leads[0]?.stageName).toBe('Quoted');
  });

  it('restores the last snapshot from disk when starting offline', async () => {
    const { localStore } = await loadModules();
    await localStore.setSnapshot(snapshot);

    // A restart with the Master switched off: nothing arrives over the socket,
    // so the panel has to come back with what it last knew.
    localStore.resetLocalStore();

    const restored = await localStore.restore();
    expect(restored?.parties[0]?.name).toBe('Patel Tiles');
  });

  it('reports nothing rather than something wrong before the first sync', async () => {
    const { localStore } = await loadModules();
    expect(await localStore.getView()).toBeNull();
  });
});

/**
 * The merged view is built and stringified on every SSE push and on every
 * `/api/snapshot`, so it is memoised — and the memo has to be keyed on
 * something that actually moves. `setSnapshot` stores the object it is handed
 * and a replayed change mutates that same object, so identity is useless: a
 * memo keyed on the reference would hand back a stale view forever.
 */
describe('the view memo', () => {
  const bare = {
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
    dashboard: { asOf: '2026-08-01T00:00:00.000Z' },
    permissions: [],
    serverHlc: '0000001700000000000-00000-MASTER',
    serverTime: '2026-08-01T00:00:00.000Z',
  };

  it('returns the same object while nothing has changed', async () => {
    const { localStore } = await loadModules();
    await localStore.setSnapshot(bare);

    expect(await localStore.getView()).toBe(await localStore.getView());
  });

  it('rebuilds when a change is applied in place', async () => {
    const { localStore } = await loadModules();
    await localStore.setSnapshot(bare);

    const before = await localStore.getView();
    // What a replayed or live change does: mutate the stored object and say so.
    localStore.noteApplied(7, 'boot-1');

    expect(await localStore.getView()).not.toBe(before);
  });

  it('rebuilds when the outbox moves', async () => {
    const { localStore, outbox } = await loadModules();
    await localStore.setSnapshot(bare);

    const before = await localStore.getView();
    await outbox.enqueue({
      kind: 'party.create',
      entity: 'party',
      entityId: 'A3F9K2000000009',
      payload: { name: 'Memo Traders' },
    });

    expect(await localStore.getView()).not.toBe(before);
    expect(outbox.outboxRevision()).toBeGreaterThan(0);
  });
});

/**
 * The cursor and the snapshot are written together, on purpose: a cursor that
 * survived a crash the snapshot did not would have the panel ask for changes
 * after a position it never reached, looking caught up while missing every row
 * in between.
 */
describe('the sync cursor', () => {
  const bare = {
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
    dashboard: { asOf: '2026-08-01T00:00:00.000Z' },
    permissions: [],
    serverHlc: '0000001700000000000-00000-MASTER',
    serverTime: '2026-08-01T00:00:00.000Z',
  };

  it('comes back from disk beside the snapshot it describes', async () => {
    const first = await loadModules();
    await first.localStore.setSnapshot(bare, { bootId: 'boot-1', lastSeq: 42 });

    const { vi } = await import('vitest');
    vi.resetModules();
    const second = await loadModules();

    expect(await second.localStore.restore()).not.toBeNull();
    expect(second.localStore.getCursor()).toEqual({ bootId: 'boot-1', lastSeq: 42 });
  });

  it('reads a snapshot written before the cursor existed, rather than failing', async () => {
    const { localStore } = await loadModules();
    const paths = await import('../src/config/paths.js');

    // Exactly what an older build left on disk: the bare snapshot, no envelope.
    await fs.mkdir(path.dirname(paths.paths().snapshotFile), { recursive: true });
    await fs.writeFile(paths.paths().snapshotFile, JSON.stringify(bare));

    expect(await localStore.restore()).not.toBeNull();
    // No cursor means "send me everything", which is what it always did.
    expect(localStore.getCursor()).toBeNull();
  });
});
