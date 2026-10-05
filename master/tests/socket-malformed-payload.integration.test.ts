/**
 * A command frame the handler cannot read — `null` where it destructures
 * `{ id, input }` — must come back as a refusal on its ack. socket.io passes a
 * thrown listener error to the process as an uncaught exception, so without the
 * guard one malformed frame from one panel takes every connection down.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let actor: ActorContext;
let server: HttpServer;
let hub: RealtimeHub;
let socket: Socket | undefined;

interface Ack {
  ok: boolean;
  messageKey?: string;
}

function ask(event: string, ...payload: unknown[]): Promise<Ack> {
  return new Promise((resolve) => (socket as Socket).emit(event, ...payload, resolve));
}

async function signInPanel(): Promise<void> {
  const role = await roleService.createRole(
    { name: 'Reader', tier: 'management', permissions: ['leads.view'] },
    actor,
  );
  await userService.createUser(
    { username: 'vera', displayName: 'vera', roleId: role.id, password: 'correct-horse' },
    actor,
  );
  const { token } = await authService.signIn('vera', 'correct-horse');
  const panelId = randomUUID();
  await panelRepo.insertPanel({
    id: panelId,
    tenant_id: actor.tenantId,
    name: 'Malformed panel',
    device_code: 'MALF001',
    secret_hash: await bcrypt.hash('panel-secret', 4),
    lan_ip: '192.168.1.22',
    status: 'active',
    paired_at: new Date(),
  });
  const { port } = server.address() as AddressInfo;
  socket = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { kind: 'office-panel', panelId, panelSecret: 'panel-secret', protocol: 3, actingUserToken: token },
  });
  await new Promise<void>((resolve, reject) => {
    socket?.on('sync:snapshot', () => resolve());
    socket?.on('connect_error', (error) => reject(error));
  });
}

describe.skipIf(!canRunIntegrationTests)('malformed socket payloads (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    server = createServer();
    hub = createRealtimeHub(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await hub.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownDatabase();
  });

  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  afterEach(() => {
    socket?.close();
    socket = undefined;
  });

  it('SOCK-1: refuses a payload the handler cannot destructure and keeps the connection', async () => {
    await signInPanel();

    for (const event of ['party:update', 'product:update', 'lead:update', 'pick', 'settings:save']) {
      const reply = await ask(event, null);
      expect(reply, event).toMatchObject({ ok: false, messageKey: 'validation.socket.badPayload' });
    }

    // Same connection, still answering.
    expect(await ask('pipeline:list')).toMatchObject({ ok: true });
    expect(socket?.connected).toBe(true);
  });

  it('SOCK-2: a frame with no ack function is dropped, not fatal', async () => {
    await signInPanel();

    (socket as Socket).emit('party:update', null);
    (socket as Socket).emit('lead:update');

    expect(await ask('pipeline:list')).toMatchObject({ ok: true });
  });
});
