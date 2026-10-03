/**
 * A queued lead edit moves the field clocks of the Office's view.
 *
 * The edit form sends the clocks it opened at as the edit's base. Two edits to
 * the same field made before the first is acknowledged (offline, or a slow
 * push) used to send the same old base, so the Master's merge recorded the
 * person's second edit as a clash with their own first one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatHlc, mergeFields } from '@orderbook/shared';
import type { Lead, Mutation } from '@orderbook/shared';

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

const clock = (physical: number) => formatHlc({ physical, counter: 0, deviceCode: 'OF1' });
const H0 = clock(1_727_000_000_000);
const H1 = clock(1_727_000_001_000);
const H2 = clock(1_727_000_002_000);

const lead = {
  id: 'LD0000000001',
  notes: 'start',
  sync: { version: 1, hlc: H0, fieldHlc: { notes: H0 }, temporaryId: null },
} as unknown as Lead;

function snapshot() {
  return {
    parties: [],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [lead],
    orders: [],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: {} as never,
    permissions: [],
    serverHlc: H0,
    serverTime: '2026-10-03T00:00:00.000Z',
    features: { offlineSignInEnabled: false },
  };
}

function notesEdit(notes: string, hlc: string, base: Record<string, string>): Mutation {
  return {
    mutationId: `m-${hlc}`,
    kind: 'lead.update',
    entity: 'lead',
    entityId: lead.id,
    payload: { notes },
    fields: ['notes'],
    hlc,
    deviceCode: 'OF1',
    baseFieldHlc: base,
    actorUserId: null,
    createdAt: '2026-10-03T00:00:00.000Z',
  } as Mutation;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-overlay-'));
  localStore.resetLocalStore();
  queued = [];
  await localStore.setSnapshot(snapshot());
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('a queued lead edit', () => {
  it("becomes the base of the next edit, so the Master's merge sees no clash", async () => {
    const first = notesEdit('A', H1, { notes: H0 });
    queued = [first];
    outboxRevision += 1;

    const view = await localStore.getView();
    const seen = view?.leads.find((candidate) => candidate.id === lead.id);
    expect(seen?.notes).toBe('A');
    expect(seen?.sync.fieldHlc.notes).toBe(H1);
    // Still pending: only the field clocks move, never the acknowledged `hlc`.
    expect(seen?.sync.hlc).toBe(H0);

    // What the Master does with the two edits, in order.
    const second = notesEdit('B', H2, seen?.sync.fieldHlc ?? {});
    const afterFirst = mergeFields(
      { values: { notes: 'start' }, fieldHlc: { notes: H0 } },
      { ...first, values: first.payload },
    );
    const afterSecond = mergeFields(
      { values: { notes: 'A' }, fieldHlc: afterFirst.fieldHlc },
      { ...second, values: second.payload },
    );
    expect(afterSecond.conflicts).toEqual([]);
    expect(afterSecond.accepted).toEqual({ notes: 'B' });
  });
});
