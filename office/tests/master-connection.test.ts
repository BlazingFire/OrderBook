/**
 * The Office half of the protocol handshake
 * (`office/src/realtime/master-connection.ts`).
 *
 * The panel announces its protocol and version, learns the Master's from each
 * snapshot or delta, and refuses at once a command the Master is too old for,
 * rather than waiting out the ack timeout. It also uploads the sign-ins it
 * checked offline once the Master has said it can take them.
 *
 * Drives the real socket handlers against a fake socket, so no Master is needed.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_PROTOCOL_VERSION } from '@orderbook/shared';

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

  constructor(readonly options: { auth: Record<string, unknown> }) {
    super();
  }

  timeout() {
    return {
      emitWithAck: (event: string, ...args: unknown[]) => {
        this.sent.push({ event, args });
        return Promise.resolve(this.answer(event, args));
      },
    };
  }

  disconnect(): void {}

  commands(event: string) {
    return this.sent.filter((entry) => entry.event === event);
  }
}

let socket: FakeSocket;

vi.mock('socket.io-client', () => ({
  io: (_url: string, options: { auth: Record<string, unknown> }) => {
    socket = new FakeSocket(options);
    return socket;
  },
}));

vi.mock('../src/services/credentials.store.js', () => ({
  loadCredentials: () =>
    Promise.resolve({
      panelId: 'OP0000000001',
      panelSecret: 'secret',
      masterHost: '192.168.1.10',
      masterPort: 4000,
      companyName: 'Acme Ceramics',
    }),
  masterBaseUrl: () => 'http://192.168.1.10:4000',
  saveCredentials: () => Promise.resolve(),
  clearCredentials: () => Promise.resolve(),
}));

vi.mock('../src/services/panel-report.service.js', () => ({
  buildReport: () => Promise.resolve({}),
  moveStorage: () => Promise.resolve({}),
}));

vi.mock('../src/sync/clock.js', () => ({ observe: () => Promise.resolve() }));

vi.mock('../src/sync/local-store.js', () => ({
  restore: () => Promise.resolve(null),
  getCursor: () => null,
  setSnapshot: () => Promise.resolve(),
  noteApplied: () => {},
  persistCurrent: () => Promise.resolve(),
}));

const flushed = vi.fn(() => Promise.resolve());
vi.mock('../src/sync/sync.service.js', () => ({
  flush: () => flushed(),
  setTransport: () => {},
  stopSync: () => {},
}));

vi.mock('../src/lib/app-version.js', () => ({ appVersion: () => '1.3.0' }));

const { masterConnection, MasterCommandError } =
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
});

afterEach(async () => {
  masterConnection.disconnect();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the protocol handshake', () => {
  it('announces this build’s protocol and version in the socket auth', async () => {
    const link = await connected();

    expect(link.options.auth).toMatchObject({
      kind: 'office-panel',
      panelId: 'OP0000000001',
      protocol: PANEL_PROTOCOL_VERSION,
      appVersion: '1.3.0',
    });
  });

  it('refuses a newer command at once, without sending it, until the Master says it can take it', async () => {
    const link = await connected();

    // Before any snapshot the Master's protocol is unknown, which counts as 1.
    const early = await masterConnection
      .command('auth:offlineEvents', [])
      .catch((error: unknown) => error);
    expect(early).toBeInstanceOf(MasterCommandError);
    expect(early).toMatchObject({
      code: 'updateNeeded',
      messageKey: 'error.updateNeeded.master',
      unreachable: false,
    });

    // An older Master sends no protocol at all: still 1.
    link.emit('sync:snapshot', snapshot());
    await settle();
    await expect(masterConnection.command('auth:offlineEvents', [])).rejects.toMatchObject({
      code: 'updateNeeded',
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
    await expect(masterConnection.command('auth:offlineEvents', [])).rejects.toMatchObject({
      code: 'updateNeeded',
    });
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
