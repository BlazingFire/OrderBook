/**
 * Whose data this PC holds, why a pairing was lost, and leaving a Master on purpose.
 *
 * Real files in a throwaway data folder (the stores read `paths()` on every call);
 * only the socket and the sign-in session are stand-ins.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

const link = { disconnect: vi.fn(), markUnpaired: vi.fn() };

vi.mock('../src/realtime/master-connection.js', () => ({ masterConnection: link }));

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-binding-'));
  process.env.ORDERBOOK_OFFICE_DATA_DIR = dataDir;
  link.disconnect.mockReset();
  link.markUnpaired.mockReset();
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ORDERBOOK_OFFICE_DATA_DIR;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function load() {
  const binding = await import('../src/services/master-binding.js');
  const credentials = await import('../src/services/credentials.store.js');
  const outbox = await import('../src/sync/outbox.store.js');
  const device = await import('../src/sync/device.js');
  const unpairService = await import('../src/services/unpair.service.js');
  return { binding, credentials, outbox, device, unpairService };
}

const pairedWith = (masterUniqueId: string, companyName = 'Shree Ceramics') => ({
  panelId: '11111111-1111-4111-8111-111111111111',
  panelSecret: 'secret',
  masterUniqueId,
  masterHost: '192.168.1.10',
  masterPort: 4100,
  companyName,
  pairedAt: '2026-10-04T10:00:00.000Z',
});

const read = async (name: string) =>
  JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8')) as unknown;
const exists = (name: string) =>
  fs.access(path.join(dataDir, name)).then(
    () => true,
    () => false,
  );

/** A file each Master's data would have left behind. */
async function leaveCache() {
  await fs.writeFile(
    path.join(dataDir, 'snapshot.json'),
    '{"version":2,"snapshot":{"parties":[]},"cursor":null}',
  );
  await fs.writeFile(path.join(dataDir, 'users.json'), '{"users":[]}');
  await fs.writeFile(path.join(dataDir, 'sign-in-attempts.json'), '{}');
}

async function queueWork(outbox: Awaited<ReturnType<typeof load>>['outbox']) {
  await outbox.enqueue({
    kind: 'party.update',
    entity: 'party',
    entityId: 'p-1',
    payload: { name: 'Sharma' },
  });
  await outbox.enqueue({
    kind: 'party.update',
    entity: 'party',
    entityId: 'p-2',
    payload: { name: 'Gupta' },
  });
}

describe('adopting a Master after pairing', () => {
  it('a first pairing, or the same Master again, keeps the cache and the unsent work', async () => {
    const { binding, outbox } = await load();
    await leaveCache();
    await queueWork(outbox);

    expect(await binding.adoptMaster(pairedWith('master-A'))).toEqual({
      newMaster: false,
      parkedChanges: 0,
    });
    expect(await binding.adoptMaster(pairedWith('master-A'))).toEqual({
      newMaster: false,
      parkedChanges: 0,
    });

    expect(await exists('snapshot.json')).toBe(true);
    expect(await exists('users.json')).toBe(true);
    expect(await outbox.pendingCount()).toBe(2);
    expect(await binding.parkedChangeCount()).toBe(0);
  });

  it('a different Master starts from a clean cache, and unsent work is set aside, not deleted and not kept to be sent', async () => {
    const { binding, outbox } = await load();
    await binding.noteCacheMaster('master-A');
    await leaveCache();
    await queueWork(outbox);

    const result = await binding.adoptMaster(pairedWith('master-B'));

    expect(result).toEqual({ newMaster: true, parkedChanges: 2 });
    // The old company's data is gone from the places that would be shown or offered to the new one.
    for (const file of ['snapshot.json', 'users.json', 'sign-in-attempts.json'])
      expect(await exists(file), file).toBe(false);
    expect(await outbox.pendingCount()).toBe(0);
    // And the work is still on disk, labelled with whose it was.
    const parked = (await read('parked-outbox.json')) as Array<{
      masterUniqueId: string;
      mutations: Array<{ entityId: string }>;
    }>;
    expect(parked).toHaveLength(1);
    expect(parked[0]?.masterUniqueId).toBe('master-A');
    expect(parked[0]?.mutations.map((mutation) => mutation.entityId)).toEqual(['p-1', 'p-2']);
    expect(await binding.parkedChangeCount()).toBe(2);
  });

  it('after that, the new Master is the one the cache belongs to', async () => {
    const { binding, outbox } = await load();
    await binding.noteCacheMaster('master-A');
    await binding.adoptMaster(pairedWith('master-B'));
    await leaveCache();
    await queueWork(outbox);

    expect((await binding.adoptMaster(pairedWith('master-B'))).newMaster).toBe(false);
    expect(await exists('snapshot.json')).toBe(true);
  });

  it('a panel paired before this existed learns whose cache it has the first time it connects, and only then', async () => {
    const { binding } = await load();
    await binding.noteCacheMaster('master-A');
    // A later, different id must not overwrite: only pairing (adoptMaster) may change it.
    await binding.noteCacheMaster('master-B');

    expect(((await read('master-binding.json')) as { cacheMaster: string }).cacheMaster).toBe(
      'master-A',
    );
  });
});

describe('remembering that the Master removed this PC', () => {
  it('is kept across a restart and shown until the PC is paired again', async () => {
    const { binding } = await load();
    await binding.recordRemoved(pairedWith('master-A', 'Shree Ceramics'));

    // A restart: nothing in memory.
    binding.resetBindingCache();
    expect(await binding.removedNote()).toMatchObject({
      companyName: 'Shree Ceramics',
      masterUniqueId: 'master-A',
      host: '192.168.1.10',
      port: 4100,
    });

    await binding.adoptMaster(pairedWith('master-A'));
    expect(await binding.removedNote()).toBeNull();
  });

  it('does nothing when there was no pairing to remember', async () => {
    const { binding } = await load();
    await binding.recordRemoved(null);
    expect(await binding.removedNote()).toBeNull();
  });
});

describe('leaving a Master on purpose', () => {
  async function paired() {
    const loaded = await load();
    await loaded.credentials.saveCredentials(pairedWith('master-A'));
    await loaded.binding.noteCacheMaster('master-A');
    await leaveCache();
    return loaded;
  }

  it('refuses while this PC is not paired', async () => {
    const { unpairService } = await load();
    await expect(unpairService.unpair()).rejects.toMatchObject({ code: 'not_paired' });
  });

  it('clears the pairing and the cache, and tells the link', async () => {
    const { unpairService, credentials } = await paired();

    expect(await unpairService.unpair()).toEqual({ ok: true, keptChanges: 0, discardedChanges: 0 });

    expect(await credentials.loadCredentials()).toBeNull();
    for (const file of ['snapshot.json', 'users.json', 'pairing.json'])
      expect(await exists(file), file).toBe(false);
    expect(link.disconnect).toHaveBeenCalled();
    expect(link.markUnpaired).toHaveBeenCalled();
  });

  it('will not drop unsent work without being told what to do with it, and then changes nothing', async () => {
    const { unpairService, credentials, outbox } = await paired();
    await queueWork(outbox);

    await expect(unpairService.unpair()).rejects.toMatchObject({
      code: 'pending_changes',
      count: 2,
    });

    expect(await credentials.loadCredentials()).not.toBeNull();
    expect(await exists('snapshot.json')).toBe(true);
    expect(await outbox.pendingCount()).toBe(2);
    expect(link.disconnect).not.toHaveBeenCalled();
  });

  it('"keep" leaves the work on this PC and remembers whose it is, so a different Master gets it set aside', async () => {
    const { unpairService, outbox, binding } = await paired();
    await queueWork(outbox);

    expect(await unpairService.unpair({ pending: 'keep' })).toEqual({
      ok: true,
      keptChanges: 2,
      discardedChanges: 0,
    });
    expect(await outbox.pendingCount()).toBe(2);
    expect(await exists('snapshot.json')).toBe(false);

    expect((await binding.adoptMaster(pairedWith('master-B'))).parkedChanges).toBe(2);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('"keep" and then the same Master again sends the work as before', async () => {
    const { unpairService, outbox, binding } = await paired();
    await queueWork(outbox);

    await unpairService.unpair({ pending: 'keep' });
    expect((await binding.adoptMaster(pairedWith('master-A'))).parkedChanges).toBe(0);
    expect(await outbox.pendingCount()).toBe(2);
  });

  it('"discard" removes the work', async () => {
    const { unpairService, outbox } = await paired();
    await queueWork(outbox);

    expect(await unpairService.unpair({ pending: 'discard' })).toEqual({
      ok: true,
      keptChanges: 0,
      discardedChanges: 2,
    });
    expect(await outbox.pendingCount()).toBe(0);
  });
});
