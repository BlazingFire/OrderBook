/**
 * A chat post speaks for the person who wrote it, so the outbox holds it back
 * until that person is the one signed in on this PC. Held posts must never go
 * up under the panel's own role or another person's session, and must never
 * stand in front of lead and order work (a refused batch would stall it).
 *
 * Real outbox in a temp folder, a fake transport.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Mutation, SyncPushResponse } from '@orderbook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-office-hold-'));
  process.env.ORDERBOOK_OFFICE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ORDERBOOK_OFFICE_DATA_DIR;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function load() {
  const device = await import('../src/sync/device.js');
  const outbox = await import('../src/sync/outbox.store.js');
  const sync = await import('../src/sync/sync.service.js');
  device.resetDeviceCache();
  outbox.resetOutboxCache();
  return { outbox, sync };
}

function acceptAll(sent: Mutation[][]) {
  return async (mutations: Mutation[]): Promise<SyncPushResponse> => {
    sent.push(mutations);
    return {
      results: mutations.map((mutation) => ({
        mutationId: mutation.mutationId,
        status: 'applied' as const,
        entityId: mutation.entityId,
        conflicts: [],
      })),
      idMappings: [],
      serverHlc: '',
    };
  };
}

const post = (actorUserId: string | null) => ({
  kind: 'chat.post' as const,
  entity: 'chat_message' as const,
  entityId: 'TMP000000000001',
  payload: { roomId: 'room-1', body: 'hello' },
  actorUserId,
});

const lead = {
  kind: 'lead.update' as const,
  entity: 'lead' as const,
  entityId: 'LD0000000001',
  payload: { notes: 'a note' },
  actorUserId: null,
};

describe('holding a chat post for its author', () => {
  it("sends the lead work and keeps a signed-out author's post in the queue", async () => {
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));
    sync.setActingUser(() => null);

    await outbox.enqueue(post('US000000000A'));
    await outbox.enqueue(lead);
    const outcome = await sync.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((mutation) => mutation.kind)).toEqual(['lead.update']);
    expect(outcome.applied).toBe(1);
    expect((await outbox.pending()).map((mutation) => mutation.kind)).toEqual(['chat.post']);
    sync.stopSync();
  });

  it('does not call the Master at all, nor spin a retry, when only held posts are left', async () => {
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));
    sync.setActingUser(() => 'US000000000B');
    vi.useFakeTimers();

    try {
      await outbox.enqueue(post('US000000000A'));
      await sync.flush();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(await outbox.pendingCount()).toBe(1);
    } finally {
      vi.useRealTimers();
      sync.stopSync();
    }
  });

  it("never sends A's post while B is signed in, and sends it when A is back", async () => {
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));
    await outbox.enqueue(post('US000000000A'));

    sync.setActingUser(() => 'US000000000B');
    await sync.flush();
    expect(sent).toEqual([]);

    sync.setActingUser(() => 'US000000000A');
    const outcome = await sync.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((mutation) => mutation.kind)).toEqual(['chat.post']);
    expect(outcome.remaining).toBe(0);
    sync.stopSync();
  });

  it('holds a post that names no author at all', async () => {
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));
    sync.setActingUser(() => 'US000000000A');
    await outbox.enqueue(post(null));

    await sync.flush();
    expect(sent).toEqual([]);
    sync.stopSync();
  });
});

describe('holding any work for its author', () => {
  const partyCreate = (actorUserId: string | null) => ({
    kind: 'party.create' as const,
    entity: 'party' as const,
    entityId: 'TMP000000000009',
    payload: { name: 'Sharma Tiles' },
    actorUserId,
  });

  it('never sends A’s offline party under B’s session, and sends it when A signs in again', async () => {
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));
    await outbox.enqueue(partyCreate('US000000000A'));

    // B signs in: the Master would take the push as B's, make B its creator and give B the grant.
    sync.setActingUser(() => 'US000000000B');
    await sync.flush();
    expect(sent).toEqual([]);
    expect(await outbox.pendingCount()).toBe(1);

    sync.setActingUser(() => 'US000000000A');
    const outcome = await sync.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((mutation) => mutation.kind)).toEqual(['party.create']);
    expect(outcome.remaining).toBe(0);
    sync.stopSync();
  });

  it('holds lead work the same way, and lets B’s own and unattributed work go past it', async () => {
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));
    await outbox.enqueue({ ...partyCreate('US000000000A'), entityId: 'TMP00000000000A' });
    await outbox.enqueue({ ...lead, actorUserId: 'US000000000A' });
    await outbox.enqueue({ ...lead, entityId: 'LD0000000002', actorUserId: 'US000000000B' });
    await outbox.enqueue(lead);

    sync.setActingUser(() => 'US000000000B');
    await sync.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((mutation) => mutation.entityId)).toEqual(['LD0000000002', 'LD0000000001']);
    expect((await outbox.pending()).map((mutation) => mutation.actorUserId)).toEqual([
      'US000000000A',
      'US000000000A',
    ]);
    sync.stopSync();
  });

  it('holds A’s work while nobody is signed in', async () => {
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));
    sync.setActingUser(() => null);
    await outbox.enqueue(partyCreate('US000000000A'));

    await sync.flush();
    expect(sent).toEqual([]);
    sync.stopSync();
  });

  it('is still held after a restart, and goes when A signs in', async () => {
    const first = await load();
    await first.outbox.enqueue(partyCreate('US000000000A'));
    first.sync.stopSync();

    // The process restarts: modules and the in-memory cache are gone, the file is not.
    vi.resetModules();
    const { outbox, sync } = await load();
    const sent: Mutation[][] = [];
    sync.setTransport(acceptAll(sent));

    sync.setActingUser(() => 'US000000000B');
    await sync.flush();
    expect(sent).toEqual([]);

    sync.setActingUser(() => 'US000000000A');
    await sync.flush();
    expect(sent).toHaveLength(1);
    expect(await outbox.pendingCount()).toBe(0);
    sync.stopSync();
  });
});
