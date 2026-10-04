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

/** What `panel:leave` does: the test says. `commandWithin(ms)` is the link's own way to send a command. */
const leave = vi.fn(async (_event: string) => null);
const link = {
  disconnect: vi.fn(),
  markUnpaired: vi.fn(),
  commandWithin: vi.fn((_ms: number) => leave),
};

vi.mock('../src/realtime/master-connection.js', () => ({ masterConnection: link }));

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-binding-'));
  process.env.ORDERBOOK_OFFICE_DATA_DIR = dataDir;
  link.disconnect.mockReset();
  link.markUnpaired.mockReset();
  link.commandWithin.mockClear();
  leave.mockReset();
  leave.mockResolvedValue(null);
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

  it('pairing with a different Master wipes the old id and secret too', async () => {
    const { binding } = await load();
    // The PC left on its own and the Master was never told: the secret is kept.
    await binding.rememberLastPanel('11111111-1111-4111-8111-111111111111', 'secret', 'master-A');
    expect((await binding.previousPanel())?.secret).toBe('secret');

    await binding.adoptMaster({
      ...pairedWith('master-B'),
      panelId: '33333333-3333-4333-8333-333333333333',
    });

    expect(await binding.previousPanel()).toBeNull();
    expect(await read('master-binding.json')).toMatchObject({ lastPanelSecret: null });
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

  it('keeps this PC’s last id with the reason, until it is paired again', async () => {
    const { binding } = await load();
    expect(await binding.previousPanel()).toBeNull();

    await binding.recordRemoved(pairedWith('master-A'));
    binding.resetBindingCache();
    // A removal by the Master, or a leave it acknowledged: the row is dead, so is the secret.
    expect(await binding.previousPanel()).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      secret: null,
      masterUniqueId: 'master-A',
    });

    await binding.adoptMaster({
      ...pairedWith('master-A'),
      panelId: '22222222-2222-4222-8222-222222222222',
    });
    // Wiped once pairing has worked: the old secret is not kept a day longer than it is useful.
    expect(await binding.previousPanel()).toBeNull();
    expect(await read('master-binding.json')).toMatchObject({
      lastPanelId: null,
      lastPanelSecret: null,
    });
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

  it('remembers the id it had, to send as the previous one when it pairs again', async () => {
    const { unpairService, binding } = await paired();
    await unpairService.unpair();
    binding.resetBindingCache();
    // A removal by the Master, or a leave it acknowledged: the row is dead, so is the secret.
    expect(await binding.previousPanel()).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      secret: null,
      masterUniqueId: 'master-A',
    });
  });

  it('keeps the id and secret in a file only its owner can read', async () => {
    const { unpairService } = await paired();
    await unpairService.unpair();
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(dataDir, 'master-binding.json'))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // And it is not one of the files a backup carries.
    const { readFileSync } = await import('node:fs');
    const backup = readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'backup-export.service.ts'),
      'utf8',
    );
    expect(backup).not.toContain('masterBindingFile');
  });

  it('tells the Master this PC is leaving, when connected, and waits only a few seconds for the answer', async () => {
    const { unpairService } = await paired();

    const result = await unpairService.unpair();

    expect(result.notifiedMaster).toBe(true);
    expect(leave).toHaveBeenCalledWith('panel:leave');
    const waited = link.commandWithin.mock.calls[0]?.[0] ?? 0;
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(5000);
    // Before the link is closed: a closed one cannot carry it.
    expect(leave.mock.invocationCallOrder[0]!).toBeLessThan(
      link.disconnect.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves locally all the same when the Master is off, too old, silent or refuses', async () => {
    for (const failure of [
      Object.assign(new Error('Not connected to the Master Panel'), { unreachable: true }),
      Object.assign(new Error('The Master Panel needs an update before it can do this'), {
        code: 'updateNeeded',
      }),
      new Error('The Master Panel did not respond'),
    ]) {
      leave.mockRejectedValueOnce(failure);
      const { unpairService, credentials, binding } = await paired();

      const result = await unpairService.unpair();

      expect(result).toMatchObject({ ok: true, notifiedMaster: false });
      expect(await credentials.loadCredentials()).toBeNull();
      // Not told, so the id and secret are what lets the Master recognise this PC later.
      expect(await binding.previousPanel()).toMatchObject({
        secret: 'secret',
        masterUniqueId: 'master-A',
      });
      binding.resetBindingCache();
      await fs.rm(path.join(dataDir, 'master-binding.json'), { force: true });
    }
  });

  it('does not tell the Master anything when it refuses for unsent work', async () => {
    const { unpairService, outbox } = await paired();
    await queueWork(outbox);

    await expect(unpairService.unpair()).rejects.toMatchObject({ code: 'pending_changes' });

    expect(leave).not.toHaveBeenCalled();
  });

  it('refuses while this PC is not paired', async () => {
    const { unpairService } = await load();
    await expect(unpairService.unpair()).rejects.toMatchObject({ code: 'not_paired' });
  });

  it('clears the pairing and the cache, and tells the link', async () => {
    const { unpairService, credentials } = await paired();

    expect(await unpairService.unpair()).toEqual({
      ok: true,
      notifiedMaster: true,
      keptChanges: 0,
      discardedChanges: 0,
    });

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
      notifiedMaster: true,
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
      notifiedMaster: true,
      keptChanges: 0,
      discardedChanges: 2,
    });
    expect(await outbox.pendingCount()).toBe(0);
  });
});
