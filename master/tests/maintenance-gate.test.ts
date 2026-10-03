/**
 * While a restore holds the Master in maintenance, nothing may reach the
 * database being replaced (`services/backup-job.ts`):
 *
 *  - every API route but the job's progress and health answers 503;
 *  - a socket already connected is closed when maintenance begins, a new one is
 *    refused at the handshake, and a command from a socket that raced the
 *    close is refused without running;
 *  - a push still waiting in the push gate is refused, not left unanswered.
 *
 * No database: the hub runs for real, with the panel's authentication,
 * snapshot and push mocked, so a panel socket can connect and push.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Mutation } from '@orderbook/shared';

const applyPush = vi.hoisted(() => vi.fn(async () => ({ results: [] })));

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
vi.mock('../src/services/sync.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyPush,
}));

const { createRealtimeHub } = await import('../src/realtime/hub.js');
const { errorHandler } = await import('../src/http/middleware/error-handler.js');
const { maintenanceGate } = await import('../src/http/middleware/maintenance-gate.js');
const backupJob = await import('../src/services/backup-job.js');
const pushGate = await import('../src/services/push-gate.js');

let server: HttpServer;
let hub: Awaited<ReturnType<typeof createRealtimeHub>>;
const sockets: Socket[] = [];

function openPanel(): Promise<{ socket: Socket; events: string[] }> {
  const { port } = server.address() as AddressInfo;
  const socket = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    auth: { kind: 'office-panel', panelId: 'panel-1', panelSecret: 'secret' },
  });
  sockets.push(socket);
  const events: string[] = [];
  socket.onAny((event: string) => events.push(event));
  socket.on('disconnect', () => events.push('disconnect'));
  return new Promise((resolve, reject) => {
    socket.once('sync:snapshot', () => resolve({ socket, events }));
    socket.once('connect_error', reject);
  });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const mutation = (id: string): Mutation =>
  ({ mutationId: id, kind: 'lead.create', hlc: `${Date.now()}:0:A`, payload: {} }) as unknown as Mutation;

describe('maintenance', () => {
  beforeAll(async () => {
    server = createServer();
    hub = createRealtimeHub(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
    backupJob.__resetBackupJobForTests();
    pushGate.__resetGateForTests();
    pushGate.configurePushGate({ windowMs: 100, backlogMs: 6_000, bootMs: 5_000 });
    applyPush.mockClear();
  });

  afterAll(async () => {
    await hub.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('the HTTP gate', () => {
    const app = express();
    app.use(maintenanceGate);
    app.get('/api/health', (_req, res) => void res.json({ ok: true }));
    app.get('/api/setup/archive/job', (_req, res) => void res.json({ phase: 'database' }));
    app.get('/api/parties', (_req, res) => void res.json([]));
    app.get('/uploads/images/x', (_req, res) => void res.send('image'));
    app.get('/index.html', (_req, res) => void res.send('page'));
    app.use(errorHandler);

    it('lets everything through outside maintenance', async () => {
      expect((await request(app).get('/api/parties')).status).toBe(200);
    });

    it('answers 503 maintenance for the API and uploads, and keeps health, job progress and the page', async () => {
      backupJob.__resetBackupJobForTests({ maintenance: true });

      const refused = await request(app).get('/api/parties');
      expect(refused.status).toBe(503);
      expect(refused.body.messageKey).toBe('error.unavailable.maintenance');
      expect(refused.headers['retry-after']).toBe('5');
      expect((await request(app).get('/uploads/images/x')).status).toBe(503);
      // Express routes ignore case, so the gate must too.
      expect((await request(app).get('/API/parties')).status).toBe(503);
      expect((await request(app).get('/Uploads/images/x')).status).toBe(503);
      expect((await request(app).get('/API/Setup/Archive/Job')).status).toBe(200);

      expect((await request(app).get('/api/health')).status).toBe(200);
      expect((await request(app).get('/api/setup/archive/job')).body).toEqual({ phase: 'database' });
      expect((await request(app).get('/index.html')).status).toBe(200);
    });
  });

  describe('the hub', () => {
    it('closes a connected panel when maintenance begins, and refuses it at the handshake until it ends', async () => {
      const { events } = await openPanel();

      await backupJob.enterMaintenance();
      await until(() => events.includes('disconnect'));

      const { port } = server.address() as AddressInfo;
      const again = connect(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        reconnection: false,
        auth: { kind: 'office-panel', panelId: 'panel-1', panelSecret: 'secret' },
      });
      sockets.push(again);
      const refusal = await new Promise<Error & { data?: { code?: string; messageKey?: string } }>((resolve) =>
        again.once('connect_error', resolve),
      );
      // `maintenance`, not a pairing refusal: the Office retries rather than unpairs.
      expect(refusal.data).toEqual({ code: 'maintenance', messageKey: 'error.unavailable.maintenance' });

      backupJob.leaveMaintenance();
      await openPanel();
    });

    it('refuses a push from a socket that raced the disconnect, without applying it', async () => {
      const { socket } = await openPanel();
      // The flag alone, as a command arriving between it and the disconnect sees it.
      backupJob.__resetBackupJobForTests({ maintenance: true });

      const ack = await socket.timeout(5000).emitWithAck('sync:push', { mutations: [mutation('m1')] });
      expect(ack).toMatchObject({ ok: false, code: 'unavailable', messageKey: 'error.unavailable.maintenance' });
      expect(applyPush).not.toHaveBeenCalled();
    });
  });

  describe('the push gate', () => {
    it('refuses every push still waiting when maintenance begins, and applies none of them', async () => {
      pushGate.configurePushGate({ windowMs: 60_000, backlogMs: 60_000, bootMs: 0 });
      const actor = {
        tenantId: 'tenant',
        actorType: 'office_panel' as const,
        actorId: 'panel-1',
        userId: null,
        permissions: null,
        deviceCode: 'A',
        actorName: 'Panel',
      };
      const apply = vi.fn(async () => ({ status: 'applied' }) as never);
      const first = pushGate.runPush(actor, [mutation('m1')], apply);
      const second = pushGate.runPush({ ...actor, actorId: 'panel-2', deviceCode: 'B' }, [mutation('m2')], apply);

      await backupJob.enterMaintenance();

      await expect(first).rejects.toMatchObject({ statusCode: 503, messageKey: 'error.unavailable.maintenance' });
      await expect(second).rejects.toMatchObject({ statusCode: 503 });
      expect(apply).not.toHaveBeenCalled();
    });
  });

  describe('the job slot', () => {
    it('runs one job at a time and keeps its last status', async () => {
      let release!: () => void;
      const job = backupJob.startJob('backup', async (update) => {
        update({ phase: 'data', done: 1, total: 2 });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      expect(job.status.kind).toBe('backup');
      expect(() => backupJob.startJob('restore', async () => undefined)).toThrow(
        expect.objectContaining({ messageKey: 'error.conflict.backupBusy' }),
      );
      expect(backupJob.currentJob()).toMatchObject({ phase: 'data', done: 1, total: 2 });

      release();
      expect(await job.finished).toMatchObject({ phase: 'done' });
      expect(backupJob.isJobRunning()).toBe(false);

      const failed = await backupJob.startJob('restore', async () => {
        throw new Error('disk');
      }).finished;
      expect(failed).toMatchObject({ phase: 'failed', message: { messageKey: 'error.generic.internal' } });
      expect(backupJob.currentJob()?.finishedAt).toBeTruthy();
    });
  });
});
