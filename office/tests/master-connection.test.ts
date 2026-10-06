/**
 * The Office's link to the Master (`office/src/realtime/master-connection.ts`).
 *
 * The panel announces its protocol and version, learns the Master's from each
 * snapshot or delta, and refuses at once a command the Master is too old for,
 * rather than waiting out the ack timeout. It also uploads the sign-ins it
 * checked offline once the Master has said it can take them.
 *
 * And it never needs a restart: it reconnects after the Master closes the
 * socket or refuses the handshake, keeps its pairing unless its own Master
 * revokes it, reports how long it has been offline and whether it is still
 * catching up, watches the network cable, and moves to a Master's new address
 * only after that address proves itself.
 *
 * Drives the real socket handlers against a fake socket, so no Master is needed.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MASTER_PROOF_CONTEXT,
  masterProofMessage,
  PANEL_PROTOCOL_VERSION,
} from '@orderbook/shared';

let dataDir: string;

vi.mock('../src/config/index.js', () => ({
  get config() {
    return { dataDir, packageRoot: dataDir };
  },
}));

type Ack = { ok: true; data: unknown } | { ok: false; error: string };

/** Stands in for a socket.io-client socket: `emit` here plays an event from the Master. */
class FakeSocket extends EventEmitter {
  /** Every command the panel sent, by event name. */
  sent: Array<{ event: string; args: unknown[] }> = [];
  answer: (event: string, args: unknown[]) => Ack = () => ({ ok: true, data: null });

  /** False once a handshake was refused, as socket.io-client leaves it. */
  active = true;
  connect = vi.fn();
  disconnect = vi.fn();

  constructor(
    readonly url: string,
    readonly options: { auth: (send: (payload: Record<string, unknown>) => void) => void },
  ) {
    super();
  }

  /** The auth this socket would send on its next handshake. */
  handshake(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => this.options.auth(resolve));
  }

  timeout() {
    return {
      emitWithAck: (event: string, ...args: unknown[]) => {
        this.sent.push({ event, args });
        return Promise.resolve(this.answer(event, args));
      },
    };
  }

  commands(event: string) {
    return this.sent.filter((entry) => entry.event === event);
  }
}

let socket: FakeSocket;
let opened = 0;

vi.mock('socket.io-client', () => ({
  io: (url: string, options: FakeSocket['options']) => {
    socket = new FakeSocket(url, options);
    opened += 1;
    return socket;
  },
}));

const MASTER_ID = '6f1c2a4e-0000-4000-8000-000000000001';

const PAIRED = {
  panelId: 'OP0000000001',
  panelSecret: 'secret',
  masterUniqueId: MASTER_ID,
  masterHost: '192.168.1.10',
  masterPort: 4000,
  companyName: 'Acme Ceramics',
  pairedAt: '2026-10-01T00:00:00.000Z',
};

/** The pairing on "disk", and what was done to it. */
const credentials = {
  current: { ...PAIRED } as typeof PAIRED | null,
  saved: [] as Array<typeof PAIRED>,
  cleared: 0,
};

vi.mock('../src/services/credentials.store.js', () => ({
  loadCredentials: () => Promise.resolve(credentials.current),
  masterBaseUrl: (c: typeof PAIRED) => `http://${c.masterHost}:${c.masterPort}`,
  saveCredentials: (next: typeof PAIRED) => {
    credentials.saved.push(next);
    credentials.current = next;
    return Promise.resolve();
  },
  clearCredentials: () => {
    credentials.cleared += 1;
    credentials.current = null;
    return Promise.resolve();
  },
}));

/** Whose cache this is, and why a pairing was lost: what the link tells `master-binding`. */
const binding = { removed: [] as unknown[], cacheOf: [] as string[] };
vi.mock('../src/services/master-binding.js', () => ({
  recordRemoved: (saved: unknown) => {
    binding.removed.push(saved);
    return Promise.resolve();
  },
  noteCacheMaster: (id: string) => {
    binding.cacheOf.push(id);
    return Promise.resolve();
  },
}));

const network = { up: true };
vi.mock('../src/lib/network.js', () => ({ hasNetworkLink: () => network.up }));

const discoverMasters = vi.fn();
vi.mock('../src/discovery/client.js', () => ({
  discoverMasters: (...args: unknown[]) => discoverMasters(...args),
}));

vi.mock('../src/services/panel-report.service.js', () => ({
  buildReport: () => Promise.resolve({}),
  moveStorage: () => Promise.resolve({}),
}));

/** Every Master clock folded into this panel's, in order. */
const observed: string[] = [];
vi.mock('../src/sync/clock.js', () => ({
  observe: (hlc: string) => {
    observed.push(hlc);
    return Promise.resolve();
  },
}));

const local = {
  cursor: null as { bootId: string; lastSeq: number } | null,
  viewer: null as string | null,
};
vi.mock('../src/sync/local-store.js', () => ({
  restore: () => Promise.resolve(null),
  getCursor: () => local.cursor,
  currentViewer: () => local.viewer,
  setSnapshot: () => Promise.resolve(),
  noteApplied: () => {},
  persistCurrent: () => Promise.resolve(),
}));

/** The order the link wired the transport and flushed, across a test. */
const calls: string[] = [];
const flushed = vi.fn(() => {
  calls.push('flush');
  return Promise.resolve();
});
vi.mock('../src/sync/sync.service.js', () => ({
  flush: () => flushed(),
  setTransport: (transport: unknown) => calls.push(transport ? 'transport' : 'no transport'),
  stopSync: () => {},
}));

vi.mock('../src/lib/app-version.js', () => ({ appVersion: () => '1.3.0' }));

const { masterConnection, MasterCommandError, masterProves } =
  await import('../src/realtime/master-connection.js');
const store = await import('../src/services/offline-auth-events.store.js');

/** A snapshot carrying just what the handler reads. */
function snapshot(protocol?: number) {
  return {
    parties: [],
    products: [],
    leads: [],
    serverTime: '2026-10-01T00:00:00.000Z',
    ...(protocol === undefined ? {} : { protocol }),
  };
}

/** Wait for the snapshot handler's background work (persist, flush, upload) to finish. */
async function settle(): Promise<void> {
  const before = flushed.mock.calls.length;
  await vi.waitFor(() => expect(flushed.mock.calls.length).toBeGreaterThan(before));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function connected(): Promise<FakeSocket> {
  await masterConnection.connect();
  socket.emit('connect');
  return socket;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-master-link-'));
  store.resetOfflineAuthEvents();
  flushed.mockClear();
  calls.length = 0;
  credentials.current = { ...PAIRED };
  credentials.saved = [];
  credentials.cleared = 0;
  network.up = true;
  local.cursor = null;
  local.viewer = null;
  discoverMasters.mockReset();
});

afterEach(async () => {
  masterConnection.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the protocol handshake', () => {
  it('announces this build’s protocol and version in the socket auth', async () => {
    const link = await connected();

    expect(await link.handshake()).toMatchObject({
      kind: 'office-panel',
      panelId: 'OP0000000001',
      protocol: PANEL_PROTOCOL_VERSION,
      appVersion: '1.3.0',
    });
  });

  it('builds the auth afresh for every handshake: the current cursor, token and secret', async () => {
    const link = await connected();
    link.emit('sync:snapshot', snapshot(3));
    await settle();

    local.cursor = { bootId: 'boot', lastSeq: 4 };
    const first = await link.handshake();
    expect(first).toMatchObject({ syncCursor: { bootId: 'boot', lastSeq: 4 } });
    expect(first).not.toHaveProperty('actingUserToken');

    // Somebody signs in while the link is down, and the secret is reissued.
    link.emit('disconnect', 'transport close');
    await masterConnection.assume('token-of-sunita');
    local.cursor = { bootId: 'boot', lastSeq: 9 };
    credentials.current = { ...PAIRED, panelSecret: 'reissued' };

    expect(await link.handshake()).toMatchObject({
      syncCursor: { bootId: 'boot', lastSeq: 9 },
      actingUserToken: 'token-of-sunita',
      panelSecret: 'reissued',
    });
    await masterConnection.assume(null);
  });

  describe('somebody who signed in offline', () => {
    it('sends no user-level command until they are re-attached, and still sends the panel’s own traffic', async () => {
      const link = await connected();
      let blocked = true;
      masterConnection.setUserCommandGuard(
        (event) => blocked && !/^(auth|panel|sync|session):/.test(event),
      );

      // Run as the panel, a read would have the panel's role and audience, not the person's.
      await expect(masterConnection.command('dashboard:get')).rejects.toMatchObject({
        code: 'sign_in_again',
        messageKey: 'error.unauthorized.signInAgain',
        unreachable: false,
      });
      expect(link.commands('dashboard:get')).toHaveLength(0);
      await masterConnection.command('auth:reconcile', []);
      expect(link.commands('auth:reconcile')).toHaveLength(1);

      blocked = false;
      await masterConnection.command('dashboard:get');
      expect(link.commands('dashboard:get')).toHaveLength(1);

      masterConnection.setUserCommandGuard(null);
      link.emit('disconnect', 'transport close');
    });

    it('says so on every connect that has no token to re-attach them with', async () => {
      const heard = vi.fn();
      masterConnection.on('session:unattached', heard);

      await connected();
      await vi.waitFor(() => expect(heard).toHaveBeenCalled());

      masterConnection.off('session:unattached', heard);
    });
  });

  describe('a snapshot built for somebody other than the person signed in', () => {
    it('is never shown or kept, and asks for the session to be ended; their own is taken as usual', async () => {
      const link = await connected();
      const shown = vi.fn();
      const unattached = vi.fn();
      masterConnection.on('snapshot', shown);
      masterConnection.on('session:unattached', unattached);
      local.viewer = 'office1';
      const before = masterConnection.getSnapshot();

      link.emit('sync:snapshot', { ...snapshot(5), builtForUserId: 'management1' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(shown).not.toHaveBeenCalled();
      expect(unattached).toHaveBeenCalled();
      expect(masterConnection.getSnapshot()).toBe(before);

      link.emit('sync:snapshot', { ...snapshot(5), builtForUserId: 'office1' });
      await vi.waitFor(() => expect(shown).toHaveBeenCalledTimes(1));

      masterConnection.off('snapshot', shown);
      masterConnection.off('session:unattached', unattached);
      link.emit('disconnect', 'transport close');
    });
  });

  describe('a cache built for somebody else', () => {
    const delta = {
      bootId: 'boot',
      seq: 5,
      events: [
        { entity: 'party', action: 'updated', id: 'P1', payload: { id: 'P1', name: 'Renamed' } },
      ],
      permissions: [],
      partyGrants: [],
      dashboard: { asOf: '2026-10-01T00:00:00.000Z' },
      serverTime: '2026-10-01T00:00:00.000Z',
      protocol: 5,
    };

    it('is not offered a cursor, so the Master answers with a full snapshot for whoever is signed in', async () => {
      const link = await connected();
      link.emit('sync:snapshot', { ...snapshot(5), builtForUserId: 'admin1' });
      await settle();
      local.cursor = { bootId: 'boot', lastSeq: 4 };

      // office1 signed in while the link was down; the cache is admin1's.
      local.viewer = 'office1';
      expect(await link.handshake()).not.toHaveProperty('syncCursor');

      // The same person back again, or a cache from an older Master: the cheap catch-up stays.
      local.viewer = 'admin1';
      expect(await link.handshake()).toMatchObject({ syncCursor: { bootId: 'boot', lastSeq: 4 } });

      // The link forgets the protocol on disconnect, as the later tests expect.
      link.emit('disconnect', 'transport close');
    });

    it('never has a delta folded onto it: it asks for a full snapshot instead', async () => {
      const link = await connected();
      link.emit('sync:snapshot', {
        ...snapshot(5),
        parties: [{ id: 'P1', name: 'Original' }],
        builtForUserId: 'admin1',
      });
      await settle();
      local.viewer = 'office1';
      // What the Master answers for office1: their own snapshot, without admin1's party.
      link.answer = (event) =>
        event === 'sync:request'
          ? { ok: true, data: { ...snapshot(5), parties: [], builtForUserId: 'office1' } }
          : { ok: true, data: null };
      const seen: Array<{ parties: Array<{ name: string }> }> = [];
      masterConnection.on('snapshot', (next) => seen.push(next as never));

      link.emit('sync:delta', delta);
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });

      expect(link.commands('sync:request')).toHaveLength(1);
      // The only snapshot shown is the full one for office1: the delta's rename was never folded in.
      expect(seen[0]?.parties).toEqual([]);
      expect(masterConnection.getSnapshot()?.parties).toEqual([]);
      link.emit('disconnect', 'transport close');
    });
  });

  describe('a newer command sent right after a connect', () => {
    it('waits for the Master to say which protocol it speaks instead of being refused as too old', async () => {
      const link = await connected();

      // Sent in the gap between 'connected' and the first snapshot: the protocol is unknown, not old.
      const pending = masterConnection.command('auth:offlineEvents', []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(link.commands('auth:offlineEvents')).toHaveLength(0);

      link.emit('sync:snapshot', snapshot(10));
      await pending;

      expect(link.commands('auth:offlineEvents')).toHaveLength(1);
      link.emit('disconnect', 'transport close');
    });

    it('is told the Master is unreachable, not that it needs an update, if the protocol never arrives', async () => {
      vi.useFakeTimers();
      const link = await connected();

      const outcome = masterConnection
        .command('auth:offlineEvents', [])
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_001);

      expect(await outcome).toMatchObject({ unreachable: true, code: undefined });
      expect(link.commands('auth:offlineEvents')).toHaveLength(0);
      vi.useRealTimers();
      link.emit('disconnect', 'transport close');
    });

    it('lets go if the link drops while it waits', async () => {
      const link = await connected();

      const outcome = masterConnection
        .command('auth:offlineEvents', [])
        .catch((error: unknown) => error);
      link.emit('disconnect', 'transport close');

      expect(await outcome).toMatchObject({ unreachable: true });
    });
  });

  it('refuses a newer command at once, without sending it, once the Master has said it cannot take it', async () => {
    const link = await connected();

    // An older Master sends no protocol at all: still 1.
    link.emit('sync:snapshot', snapshot());
    await settle();
    const refused = await masterConnection
      .command('auth:offlineEvents', [])
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MasterCommandError);
    expect(refused).toMatchObject({
      code: 'updateNeeded',
      messageKey: 'error.updateNeeded.master',
      unreachable: false,
    });
    expect(link.commands('auth:offlineEvents')).toHaveLength(0);

    // A command that has existed since protocol 1 is unaffected.
    await masterConnection.command('auth:reconcile', []);
    expect(link.commands('auth:reconcile')).toHaveLength(1);

    // A Master that speaks protocol 2 gets it.
    link.emit('sync:snapshot', snapshot(2));
    await settle();
    await masterConnection.command('auth:offlineEvents', []);
    expect(link.commands('auth:offlineEvents')).toHaveLength(1);
  });

  it('learns the protocol from a delta too, and forgets it on disconnect', async () => {
    const link = await connected();
    link.emit('sync:snapshot', snapshot(1));
    await settle();

    link.emit('sync:delta', {
      bootId: 'boot',
      seq: 1,
      events: [],
      permissions: [],
      partyGrants: [],
      dashboard: { asOf: '2026-10-01T00:00:00.000Z' },
      serverTime: '2026-10-01T00:00:00.000Z',
      protocol: 2,
    });
    await settle();
    await masterConnection.command('auth:offlineEvents', []);

    link.emit('disconnect', 'transport close');
    link.emit('connect');
    // Forgotten: the command waits for the new connection to say, and only an answer of 1 refuses it.
    const again = masterConnection
      .command('auth:offlineEvents', [])
      .catch((error: unknown) => error);
    link.emit('sync:snapshot', snapshot(1));
    expect(await again).toMatchObject({ code: 'updateNeeded' });
  });
});

describe('uploading offline sign-ins', () => {
  const EVENTS = [
    { username: 'sunita', userId: 'US000000000C', success: true, at: '2026-10-01T09:00:00.000Z' },
    { username: 'imran', success: false, at: '2026-10-01T09:01:00.000Z' },
  ];

  /** As the store keeps them: each with the id it was given on the way in. */
  const STORED = EVENTS.map((event) => ({ ...event, id: expect.any(String) }));

  beforeEach(async () => {
    for (const event of EVENTS) await store.append(event);
  });

  it('sends them once the Master can take them, and drops them on its acknowledgement', async () => {
    const link = await connected();
    link.answer = (event) =>
      event === 'auth:offlineEvents'
        ? { ok: true, data: { recorded: 2 } }
        : { ok: true, data: null };

    link.emit('sync:snapshot', snapshot(2));
    await settle();

    expect(link.commands('auth:offlineEvents').map((entry) => entry.args[0])).toEqual([STORED]);
    expect(await store.peek()).toEqual([]);
  });

  it('keeps them when the upload fails, and sends them on the next connect', async () => {
    const link = await connected();
    link.answer = (event) =>
      event === 'auth:offlineEvents' ? { ok: false, error: 'boom' } : { ok: true, data: null };

    link.emit('sync:snapshot', snapshot(2));
    await settle();
    expect(link.commands('auth:offlineEvents')).toHaveLength(1);
    expect(await store.peek()).toEqual(STORED);

    // Not again on every change while this connection lasts.
    link.emit('sync:delta', {
      bootId: 'boot',
      seq: 1,
      events: [],
      permissions: [],
      partyGrants: [],
      dashboard: { asOf: '2026-10-01T00:00:00.000Z' },
      serverTime: '2026-10-01T00:00:00.000Z',
      protocol: 2,
    });
    await settle();
    expect(link.commands('auth:offlineEvents')).toHaveLength(1);

    link.answer = () => ({ ok: true, data: { recorded: 2 } });
    link.emit('disconnect', 'transport close');
    link.emit('connect');
    link.emit('sync:snapshot', snapshot(2));
    await settle();

    expect(link.commands('auth:offlineEvents')).toHaveLength(2);
    expect(await store.peek()).toEqual([]);
  });

  it('never sends them to a Master too old for the command, and keeps them', async () => {
    const link = await connected();

    link.emit('sync:snapshot', snapshot());
    await settle();

    expect(link.commands('auth:offlineEvents')).toHaveLength(0);
    expect(await store.peek()).toEqual(STORED);
  });
});

/** An error as socket.io-client hands it over for a refused handshake. */
function refusal(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), { data: { code, ...extra } });
}

/** Let promise callbacks and the I/O queue run once. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('reconnecting without a restart', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // No jitter, so the delays are exact.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('reconnects after the Master closes the socket, but not after it revokes the panel', async () => {
    const link = await connected();

    link.emit('disconnect', 'io server disconnect');
    vi.advanceTimersByTime(1_499);
    expect(link.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(link.connect).toHaveBeenCalledTimes(1);

    link.emit('connect');
    link.emit('panel:revoked');
    link.emit('disconnect', 'io server disconnect');
    vi.advanceTimersByTime(60_000);

    expect(link.connect).toHaveBeenCalledTimes(1);
    expect(link.disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(masterConnection.getStatus().state).toBe('unpaired'));
    expect(credentials.cleared).toBe(1);
  });

  it('remembers that the Master removed this PC, with whose pairing it was, before the pairing is cleared', async () => {
    const link = await connected();
    binding.removed.length = 0;

    link.emit('panel:revoked');

    await vi.waitFor(() => expect(masterConnection.getStatus().state).toBe('unpaired'));
    expect(binding.removed).toEqual([PAIRED]);
    expect(credentials.cleared).toBe(1);
  });

  it('notes whose data the cache holds each time it opens a connection', async () => {
    binding.cacheOf.length = 0;
    await connected();
    expect(binding.cacheOf).toEqual([MASTER_ID]);
  });

  it('backs off when the Master keeps closing the socket, as when two PCs share a pairing', async () => {
    const link = await connected();

    // The first two closes are retried at once, as a Master restart is.
    for (let close = 1; close <= 2; close += 1) {
      link.emit('disconnect', 'io server disconnect');
      vi.advanceTimersByTime(1_500);
      expect(link.connect).toHaveBeenCalledTimes(close);
      link.emit('connect');
    }

    // The third within half a minute waits out the refusal backoff instead.
    link.emit('disconnect', 'io server disconnect');
    vi.advanceTimersByTime(4_999);
    expect(link.connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(link.connect).toHaveBeenCalledTimes(3);
  });

  it('retries a refused handshake with a backoff, which socket.io-client does not', async () => {
    const link = await connected();
    link.emit('disconnect', 'transport close');

    link.active = false;
    link.emit('connect_error', refusal('maintenance'));
    await tick();
    vi.advanceTimersByTime(4_999);
    expect(link.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(link.connect).toHaveBeenCalledTimes(1);

    // Refused again: twice as long.
    link.emit('connect_error', refusal('maintenance'));
    await tick();
    vi.advanceTimersByTime(9_999);
    expect(link.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(link.connect).toHaveBeenCalledTimes(2);
    expect(credentials.cleared).toBe(0);
  });

  it('keeps the pairing when the Master does not recognise the panel, says so, and keeps trying', async () => {
    const link = await connected();
    link.emit('disconnect', 'transport close');

    link.active = false;
    link.emit('connect_error', refusal('panelNotPaired'));
    await tick();
    expect(masterConnection.getStatus().notRecognised).toBe(true);

    expect(credentials.cleared).toBe(0);
    expect(credentials.current).toEqual(PAIRED);
    vi.advanceTimersByTime(5_000);
    expect(link.connect).toHaveBeenCalledTimes(1);

    link.active = true;
    link.emit('connect');
    expect(masterConnection.getStatus().notRecognised).toBe(false);
  });

  it('forgets the pairing on panelRevoked only from the Master it paired with', async () => {
    const link = await connected();
    link.emit('disconnect', 'transport close');
    link.active = false;

    // Another Master (a copy restored on some other PC), or one that does not say.
    link.emit('connect_error', refusal('panelRevoked', { masterUniqueId: 'someone-else' }));
    link.emit('connect_error', refusal('panelRevoked'));
    await tick();
    expect(masterConnection.getStatus().notRecognised).toBe(true);
    expect(credentials.cleared).toBe(0);

    link.emit('connect_error', refusal('panelRevoked', { masterUniqueId: MASTER_ID }));
    await tick();
    await vi.waitFor(() => expect(masterConnection.getStatus().state).toBe('unpaired'));
    expect(credentials.cleared).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(link.connect).not.toHaveBeenCalled();
  });
});

describe('what the status says', () => {
  it('sets disconnectedSince when the link is lost, keeps it through failures, clears it on connect', async () => {
    const link = await connected();
    expect(masterConnection.getStatus().disconnectedSince).toBeNull();

    link.emit('disconnect', 'transport close');
    const since = masterConnection.getStatus().disconnectedSince;
    expect(since).toEqual(expect.any(String));

    link.emit('connect_error', new Error('websocket error'));
    expect(masterConnection.getStatus().disconnectedSince).toBe(since);

    link.emit('connect');
    expect(masterConnection.getStatus().disconnectedSince).toBeNull();
  });

  it('is catching up from connect until the snapshot is stored and the outbox flushed after the transport', async () => {
    const statuses: Array<{ catchingUp: boolean }> = [];
    const listener = (status: { catchingUp: boolean }) => statuses.push(status);
    masterConnection.on('status', listener);

    try {
      const link = await connected();
      expect(masterConnection.getStatus().catchingUp).toBe(true);

      // The flush right after the transport is wired is half of it.
      await vi.waitFor(() => expect(calls).toEqual(['transport', 'flush']));
      expect(masterConnection.getStatus().catchingUp).toBe(true);

      link.emit('sync:snapshot', {
        ...snapshot(3),
        serverTime: new Date(Date.now() - 90_000).toISOString(),
      });
      await vi.waitFor(() => expect(masterConnection.getStatus().catchingUp).toBe(false));
      expect(statuses[statuses.length - 1]).toMatchObject({ catchingUp: false });

      // This PC is about a minute and a half ahead of the Master.
      expect(masterConnection.getStatus().clockSkewMs).toBeGreaterThanOrEqual(90_000);
      expect(masterConnection.getStatus().clockSkewMs).toBeLessThan(100_000);
    } finally {
      masterConnection.off('status', listener);
    }
  });

  it("folds each live change's clock into this panel's, so a later move sorts after it", async () => {
    const link = await connected();
    link.emit('sync:snapshot', snapshot(3));
    observed.length = 0;

    const hlc = '0001900000000000:0000:OP0000000002';
    link.emit('data:changed', {
      entity: 'lead',
      action: 'updated',
      id: 'L1',
      payload: {
        id: 'L1',
        sync: { version: 2, hlc, fieldHlc: { stageId: hlc }, temporaryId: null },
      },
    });
    // A change without a row clock is passed over, not folded.
    link.emit('data:changed', {
      entity: 'lead',
      action: 'deleted',
      id: 'L2',
      payload: { id: 'L2' },
    });

    expect(observed).toEqual([hlc]);
  });

  it('watches the network cable, speaks only on a change, and retries at once when it returns', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const statuses: Array<{ hasNetworkLink: boolean }> = [];
    const listener = (status: { hasNetworkLink: boolean }) => statuses.push(status);

    const link = await connected();
    link.emit('disconnect', 'transport close');
    masterConnection.on('status', listener);

    try {
      vi.advanceTimersByTime(2_000);
      expect(statuses).toEqual([]);

      network.up = false;
      vi.advanceTimersByTime(2_000);
      expect(statuses.map((status) => status.hasNetworkLink)).toEqual([false]);
      vi.advanceTimersByTime(4_000);
      expect(statuses).toHaveLength(1);
      expect(link.connect).not.toHaveBeenCalled();

      network.up = true;
      vi.advanceTimersByTime(2_000);
      expect(statuses.map((status) => status.hasNetworkLink)).toEqual([false, true]);
      expect(link.disconnect).toHaveBeenCalledTimes(1);
      expect(link.connect).toHaveBeenCalledTimes(1);
    } finally {
      masterConnection.off('status', listener);
    }
  });
});

describe('finding a Master that moved', () => {
  const MOVED = {
    masterUniqueId: MASTER_ID,
    companyName: 'Acme Ceramics',
    lanIp: '192.168.1.20',
    addresses: ['192.168.1.20'],
    httpPort: 4000,
    acceptingPairing: false,
    nonce: 'n',
  };

  /** Each test starts well past the previous one's once-a-minute limit. */
  let clock = Date.parse('2027-01-01T00:00:00.000Z');

  beforeEach(() => {
    clock += 10 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'], now: clock });
  });

  /** Three failed attempts in a row on a fresh connection. */
  async function failThrice(): Promise<FakeSocket> {
    const link = await connected();
    link.emit('disconnect', 'transport close');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      link.emit('connect_error', new Error('websocket error'));
    }
    return link;
  }

  /** A `/api/panel/prove` that answers with `answer(nonce)`. */
  function prover(answer: (nonce: string) => string) {
    const fetchSpy = vi.fn((_url: string, init: { body: string }) => {
      const { nonce } = JSON.parse(init.body) as { nonce: string };
      return Promise.resolve(
        new Response(JSON.stringify({ proof: answer(nonce) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  /** What the Master that holds this panel's proof key answers when reached at `host:port`. */
  const answerAt = (host: string, port: number) => (nonce: string) => {
    const key = createHmac('sha256', PAIRED.panelSecret).update(MASTER_PROOF_CONTEXT).digest();
    return createHmac('sha256', key)
      .update(masterProofMessage(nonce, host, port))
      .digest('hex');
  };
  const genuine = answerAt('192.168.1.20', 4000);

  it('does not look before the third failure, nor without a network, nor twice a minute', async () => {
    discoverMasters.mockResolvedValue([]);
    const link = await connected();
    link.emit('disconnect', 'transport close');
    link.emit('connect_error', new Error('websocket error'));
    link.emit('connect_error', new Error('websocket error'));
    expect(discoverMasters).not.toHaveBeenCalled();

    network.up = false;
    link.emit('connect_error', new Error('websocket error'));
    expect(discoverMasters).not.toHaveBeenCalled();

    network.up = true;
    link.emit('connect_error', new Error('websocket error'));
    await vi.waitFor(() => expect(discoverMasters).toHaveBeenCalledWith({ timeoutMs: 3000 }));

    link.emit('connect_error', new Error('websocket error'));
    await tick();
    expect(discoverMasters).toHaveBeenCalledTimes(1);
  });

  it('does not adopt an address that answers with the right Master id but cannot prove it', async () => {
    discoverMasters.mockResolvedValue([MOVED]);
    const fetchSpy = prover(() => 'ab'.repeat(32));
    const before = opened;

    await failThrice();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await tick();

    const [url, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://192.168.1.20:4000/api/panel/prove');
    expect(JSON.parse(init.body)).toEqual({
      panelId: PAIRED.panelId,
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The secret never went there, and nothing connected there.
    expect(init.body).not.toContain(PAIRED.panelSecret);
    expect(opened).toBe(before + 1);
    expect(credentials.saved).toEqual([]);
    expect(masterConnection.getStatus()).toMatchObject({
      masterHost: '192.168.1.10',
      rediscoveredFrom: null,
      // Said on screen, so somebody can look for the device answering there.
      rediscoveryRefused: '192.168.1.20:4000',
    });
  });

  it('trusts neither of two addresses claiming the same Master', async () => {
    discoverMasters.mockResolvedValue([{ ...MOVED, conflictingAddress: true }]);
    const fetchSpy = prover(genuine);
    const before = opened;

    await failThrice();
    await vi.waitFor(() => expect(discoverMasters).toHaveBeenCalled());
    await tick();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opened).toBe(before + 1);
    expect(masterConnection.getStatus().rediscoveryRefused).toBe('192.168.1.20:4000');
  });

  it('refuses an address that relays the real Master’s answer for the real Master’s address', async () => {
    discoverMasters.mockResolvedValue([MOVED]);
    // The device at .20 forwards the nonce to the real Master at .10 and hands back its answer.
    const fetchSpy = prover(answerAt('192.168.1.10', 4000));
    const before = opened;

    await failThrice();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await tick();

    expect(opened).toBe(before + 1);
    expect(credentials.saved).toEqual([]);
    expect(masterConnection.getStatus().rediscoveryRefused).toBe('192.168.1.20:4000');
  });

  it('proves and connects to the address the Master answered from, not the one it claims', async () => {
    // It claims .99 (an adapter this PC cannot reach) but answered from .20.
    discoverMasters.mockResolvedValue([
      { ...MOVED, lanIp: '192.168.1.99', addresses: ['192.168.1.20', '192.168.1.99'] },
    ]);
    const fetchSpy = prover(genuine);
    const before = opened;

    await failThrice();
    await vi.waitFor(() => expect(opened).toBe(before + 2));

    expect((fetchSpy.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://192.168.1.20:4000/api/panel/prove',
    );
    expect(socket.url).toBe('http://192.168.1.20:4000');
  });

  it('tries the next address when the first one cannot prove it', async () => {
    discoverMasters.mockResolvedValue([
      { ...MOVED, lanIp: '192.168.1.20', addresses: ['192.168.1.30', '192.168.1.20'] },
    ]);
    // Only .20 holds the key.
    const fetchSpy = prover(genuine);
    const before = opened;

    await failThrice();
    await vi.waitFor(() => expect(opened).toBe(before + 2));

    expect(fetchSpy.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      'http://192.168.1.30:4000/api/panel/prove',
      'http://192.168.1.20:4000/api/panel/prove',
    ]);
    expect(socket.url).toBe('http://192.168.1.20:4000');
  });

  it('connects to a proven new address, and saves it only once that connection authenticates', async () => {
    discoverMasters.mockResolvedValue([MOVED]);
    prover(genuine);
    const before = opened;

    const old = await failThrice();
    await vi.waitFor(() => expect(opened).toBe(before + 2));

    expect(old.disconnect).toHaveBeenCalled();
    expect(socket.url).toBe('http://192.168.1.20:4000');
    expect(await socket.handshake()).toMatchObject({ panelSecret: PAIRED.panelSecret });
    expect(credentials.saved).toEqual([]);

    // Refused there is not good enough either.
    socket.active = false;
    socket.emit('connect_error', refusal('maintenance'));
    await tick();
    expect(credentials.saved).toEqual([]);

    socket.active = true;
    socket.emit('connect');
    await vi.waitFor(() =>
      expect(credentials.saved).toEqual([
        { ...PAIRED, masterHost: '192.168.1.20', masterPort: 4000 },
      ]),
    );
    expect(masterConnection.getStatus()).toMatchObject({
      state: 'connected',
      masterHost: '192.168.1.20',
      rediscoveredFrom: '192.168.1.10:4000',
    });
  });
});

describe('asking an unproven address for its proof', () => {
  /** A local server that answers `/api/panel/prove` with `respond`. */
  async function serve(respond: (res: http.ServerResponse) => void) {
    const server = http.createServer((_req, res) => respond(res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }

  it('stops reading a body past 1 KB instead of holding it all', async () => {
    let sent = 0;
    const { server, port } = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      // Endless unless the reader goes away.
      const pump = () => {
        while (sent < 64 * 1024 * 1024 && res.write(chunk)) sent += chunk.length;
        if (sent < 64 * 1024 * 1024 && !res.destroyed) res.once('drain', pump);
      };
      res.on('close', () => res.removeAllListeners('drain'));
      pump();
    });
    try {
      expect(await masterProves('127.0.0.1', port, PAIRED)).toBe(false);
      expect(sent).toBeLessThan(16 * 1024 * 1024);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('refuses a declared length over the limit and a redirect', async () => {
    const { server, port } = await serve((res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/api/panel/prove' });
      res.end();
    });
    const big = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 4096 });
      res.end(' '.repeat(4096));
    });
    try {
      expect(await masterProves('127.0.0.1', port, PAIRED)).toBe(false);
      expect(await masterProves('127.0.0.1', big.port, PAIRED)).toBe(false);
    } finally {
      server.close();
      big.server.close();
    }
  });
});

describe('a role or user edit on the Master (1.4 R9)', () => {
  const ACTIVE = {
    status: 'active',
    user: { id: 'US000000000C', permissions: ['leads.view', 'print.send'] },
  };

  // The connection is a singleton: leave nobody signed in for the next test.
  afterEach(async () => {
    await masterConnection.assume(null);
    masterConnection.removeAllListeners('user');
  });

  it('asks again who the signed-in person is when the Master says session:refresh, and hands the answer on', async () => {
    const link = await connected();
    link.answer = (event) => ({ ok: true, data: event === 'auth:assume' ? ACTIVE : null });
    await masterConnection.assume('token-1');
    link.sent.length = 0;
    const users: unknown[] = [];
    masterConnection.on('user', (user: unknown) => users.push(user));

    link.emit('session:refresh');

    await vi.waitFor(() => expect(users).toEqual([ACTIVE.user]));
    expect(link.commands('auth:assume').map((entry) => entry.args[0])).toEqual(['token-1']);
  });

  it('does nothing when nobody is signed in on this panel', async () => {
    const link = await connected();

    link.emit('session:refresh');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(link.commands('auth:assume')).toEqual([]);
  });
});
