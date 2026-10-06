/**
 * A refusal names the record somebody queued and the Master's reason, and the refusals file
 * belongs to the PC, not to a person. So each person is shown their own (and any that name
 * nobody), and can only clear their own.
 *
 * Real outbox in a temp folder.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Mutation } from '@orderbook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-office-refusals-'));
  process.env.ORDERBOOK_OFFICE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ORDERBOOK_OFFICE_DATA_DIR;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function load() {
  const outbox = await import('../src/sync/outbox.store.js');
  const localStore = await import('../src/sync/local-store.js');
  const sync = await import('../src/sync/sync.service.js');
  outbox.resetOutboxCache();
  return { outbox, localStore, sync };
}

const refusal = (mutationId: string, actorUserId: string | null) => ({
  mutation: {
    mutationId,
    kind: 'party.create',
    entity: 'party',
    entityId: `TMP-${mutationId}`,
    actorUserId,
  } as Mutation,
  result: {
    mutationId,
    status: 'rejected' as const,
    entityId: `TMP-${mutationId}`,
    error: 'Missing permission: parties.create',
    conflicts: [],
  },
  refusedAt: '2026-10-06T00:00:00.000Z',
});

const ids = async (sync: Awaited<ReturnType<typeof load>>['sync']) =>
  (await sync.recentRejections()).map((result) => result.mutationId).sort();

describe('the refusals a person is shown', () => {
  it('are their own and the unattributed ones, never somebody else’s', async () => {
    const { outbox, localStore, sync } = await load();
    await outbox.recordRefusals([
      refusal('from-a', 'US-A'),
      refusal('from-b', 'US-B'),
      refusal('from-nobody', null),
    ]);

    localStore.setViewer(() => 'US-A');
    expect(await ids(sync)).toEqual(['from-a', 'from-nobody']);

    localStore.setViewer(() => 'US-B');
    expect(await ids(sync)).toEqual(['from-b', 'from-nobody']);

    localStore.setViewer(() => null);
    expect(await ids(sync)).toEqual(['from-nobody']);
  });

  it('can be cleared only by the person they belong to', async () => {
    const { outbox, localStore, sync } = await load();
    await outbox.recordRefusals([refusal('from-a', 'US-A'), refusal('from-b', 'US-B')]);
    localStore.setViewer(() => 'US-A');

    // Naming another person's refusal clears nothing of theirs.
    await sync.acknowledgeRejections(['from-b']);
    expect((await outbox.refusals()).map((entry) => entry.result.mutationId).sort()).toEqual([
      'from-a',
      'from-b',
    ]);

    // "Clear all" is all of mine.
    await sync.acknowledgeRejections();
    expect((await outbox.refusals()).map((entry) => entry.result.mutationId)).toEqual(['from-b']);
  });
});
