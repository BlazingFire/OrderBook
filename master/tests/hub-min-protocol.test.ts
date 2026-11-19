/**
 * The Master turns away an Office too old for the 1.5.9 catalogue (owner, 2026-11-19).
 *
 * A 1.5.8 Office speaks protocol 12 and reads `product.variants`, which a protocol-13 Product
 * no longer carries; synced, its search and order entry would break. Refused at the handshake
 * with `panelUpdateRequired`, it keeps working offline on its saved catalogue until it updates.
 * `vitest.setup.ts` lowers the floor for the suites that model an older Office; this one runs
 * with the real one.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PANEL_MIN_PROTOCOL, PANEL_PROTOCOL_VERSION } from '@orderbook/shared';

vi.mock('../src/services/panel.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authenticatePanel: vi.fn(async (panelId: string) => ({ id: panelId, tenantId: 'tenant', deviceCode: 'A' })),
  markPanelConnected: vi.fn(async () => undefined),
  markPanelDisconnected: vi.fn(async () => undefined),
  listPanelsWithPresence: vi.fn(async () => []),
  scheduleLongOfflineNoticesAtBoot: vi.fn(async () => undefined),
}));
vi.mock('../src/services/panel-actor.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePanelActor: vi.fn(async () => ({
    actor: {
      tenantId: 'tenant',
      actorType: 'office_panel',
      actorId: 'panel-1',
      userId: null,
      permissions: null,
      deviceCode: 'A',
      actorName: 'Panel',
    },
  })),
}));
vi.mock('../src/services/snapshot.service.js', () => ({ buildSnapshot: vi.fn(async () => ({ seq: 0 })) }));

const { createRealtimeHub } = await import('../src/realtime/hub.js');

let server: HttpServer;
let hub: Awaited<ReturnType<typeof createRealtimeHub>>;
const sockets: Socket[] = [];
const floorBefore = process.env.ORDERBOOK_MIN_PANEL_PROTOCOL;

type Outcome = { snapshot: true } | { refused: string | undefined };

function connectAs(protocol: number | undefined): Promise<Outcome> {
  const { port } = server.address() as AddressInfo;
  const socket = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    auth: {
      kind: 'office-panel',
      panelId: 'panel-1',
      panelSecret: 'secret',
      ...(protocol === undefined ? {} : { protocol }),
    },
  });
  sockets.push(socket);
  return new Promise((resolve) => {
    socket.once('sync:snapshot', () => resolve({ snapshot: true }));
    socket.once('connect_error', (error: Error & { data?: { code?: string } }) =>
      resolve({ refused: error.data?.code }),
    );
  });
}

describe('the oldest Office the Master syncs with', () => {
  beforeAll(async () => {
    delete process.env.ORDERBOOK_MIN_PANEL_PROTOCOL;
    server = createServer();
    hub = createRealtimeHub(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    process.env.ORDERBOOK_MIN_PANEL_PROTOCOL = floorBefore;
    await hub.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is the 1.5.9 catalogue, one past what a 1.5.8 Office speaks', () => {
    expect(PANEL_MIN_PROTOCOL).toBe(13);
    expect(PANEL_PROTOCOL_VERSION).toBeGreaterThanOrEqual(PANEL_MIN_PROTOCOL);
  });

  it('refuses a 1.5.8 Office (protocol 12) until it updates', async () => {
    expect(await connectAs(12)).toEqual({ refused: 'panelUpdateRequired' });
  });

  it('refuses an Office that announces no protocol at all', async () => {
    expect(await connectAs(undefined)).toEqual({ refused: 'panelUpdateRequired' });
  });

  it('syncs an Office on the current protocol', async () => {
    expect(await connectAs(PANEL_PROTOCOL_VERSION)).toEqual({ snapshot: true });
  });

  it('lets an older Office in again when support lowers the floor', async () => {
    process.env.ORDERBOOK_MIN_PANEL_PROTOCOL = '12';
    try {
      expect(await connectAs(12)).toEqual({ snapshot: true });
    } finally {
      delete process.env.ORDERBOOK_MIN_PANEL_PROTOCOL;
    }
  });
});
