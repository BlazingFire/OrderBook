/**
 * What the Master pushes to a connected Office Panel on its own initiative.
 *
 * A real hub and real `socket.io-client` sockets, because the thing under test
 * is which socket receives which event: `session:rejected` for the panel whose
 * signed-in person lost their session, `sync:snapshot` after a role or
 * party-access change — and never a sign-out from a re-snapshot.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import bcrypt from 'bcryptjs';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as catalog from '../src/services/catalog.service.js';
import * as partyAccessService from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

interface Client {
  socket: Socket;
  seen: Array<{ event: string; args: unknown[] }>;
}

let server: HttpServer;
let hub: RealtimeHub;
let admin: ActorContext;
let tenantId: string;
let clients: Client[] = [];

async function pairPanel(deviceCode: string): Promise<string> {
  const id = randomUUID();
  await panelRepo.insertPanel({
    id,
    tenant_id: tenantId,
    name: `Panel ${deviceCode}`,
    device_code: deviceCode,
    secret_hash: await bcrypt.hash('panel-secret', 4),
    lan_ip: '192.168.1.20',
    status: 'active',
    paired_at: new Date(),
  });
  return id;
}

const count = (client: Client, event: string): number =>
  client.seen.filter((entry) => entry.event === event).length;

/** Wait until `event` has been seen `n` times in total. */
async function waitFor(client: Client, event: string, n = 1): Promise<void> {
  const deadline = Date.now() + 5000;
  while (count(client, event) < n) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${event}; saw ${JSON.stringify(client.seen.map((e) => [e.event, e.args[0]]))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function connectPanel(deviceCode: string): Promise<Client> {
  const panelId = await pairPanel(deviceCode);
  const { port } = server.address() as AddressInfo;
  const socket = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { kind: 'office-panel', panelId, panelSecret: 'panel-secret' },
  });
  const client: Client = { socket, seen: [] };
  socket.onAny((event: string, ...args: unknown[]) => client.seen.push({ event, args }));
  socket.on('connect_error', (error) => client.seen.push({ event: 'connect_error', args: [error.message] }));
  clients.push(client);
  await waitFor(client, 'sync:snapshot');
  return client;
}

/** Long enough for a push that should happen to have happened. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

function ask<T>(client: Client, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

/** Signs in on the panel and waits for the snapshot that sign-in triggers. */
async function signIn(client: Client, username: string): Promise<string> {
  const before = count(client, 'sync:snapshot');
  const ack = await ask<{ ok: boolean; data: { token: string } }>(client, 'auth:signIn', {
    username,
    password: 'correct-horse',
  });
  expect(ack.ok).toBe(true);
  await waitFor(client, 'sync:snapshot', before + 1);
  return ack.data.token;
}

async function createStaff(
  username: string,
  roleId: string,
): Promise<{ id: string; version: number }> {
  const { user } = await userService.createUser(
    { username, displayName: username, roleId, password: 'correct-horse' },
    admin,
  );
  return { id: user.id, version: user.sync.version };
}

const lastSnapshot = <T>(client: Client): T =>
  client.seen.filter((entry) => entry.event === 'sync:snapshot').at(-1)?.args[0] as T;

describe.skipIf(!canRunIntegrationTests)('what the Master pushes to Office panels', () => {
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
    admin = await testActor();
    tenantId = await testTenantId();
    clients = [];
  });

  afterEach(() => {
    for (const client of clients) client.socket.close();
  });

  it('tells only the panel whose signed-in person was deactivated (C5)', async () => {
    const role = await roleService.createRole(
      { name: 'Sales', tier: 'management', permissions: ['leads.view'] },
      admin,
    );
    const staff = await createStaff('sunita', role.id);
    const busy = await connectPanel('PUSH01');
    const idle = await connectPanel('PUSH02');
    await signIn(busy, 'sunita');

    await userService.updateUser(staff.id, { isActive: false, expectedVersion: staff.version }, admin);

    await waitFor(busy, 'session:rejected');
    expect(busy.seen.find((entry) => entry.event === 'session:rejected')?.args).toEqual(['revoked']);
    await settle();
    expect(count(idle, 'session:rejected')).toBe(0);
  });

  it('re-sends snapshots after a role edit, with the new permissions (C6)', async () => {
    const role = await roleService.createRole(
      { name: 'Sales', tier: 'management', permissions: ['leads.view'] },
      admin,
    );
    await createStaff('sunita', role.id);
    const panel = await connectPanel('PUSH03');
    await signIn(panel, 'sunita');
    const before = count(panel, 'sync:snapshot');

    await roleService.updateRole(
      role.id,
      { name: 'Sales', tier: 'management', permissions: ['leads.view', 'orders.view'], expectedVersion: role.sync.version },
      admin,
    );

    await waitFor(panel, 'sync:snapshot', before + 1);
    expect(lastSnapshot<{ permissions: string[] }>(panel).permissions).toContain('orders.view');
  });

  it('re-sends snapshots after party access changes, with the new grants (C6)', async () => {
    const role = await roleService.createRole(
      { name: 'Sales', tier: 'management', permissions: ['leads.view', 'parties.view'] },
      admin,
    );
    const staff = await createStaff('sunita', role.id);
    const party = await catalog.createParty({ name: 'Shah Traders' }, admin);
    const panel = await connectPanel('PUSH04');
    await signIn(panel, 'sunita');
    const before = count(panel, 'sync:snapshot');

    await partyAccessService.replaceAssignments(
      party.id,
      { entries: [{ userId: staff.id, level: 'view' }], expectedVersion: party.sync.version },
      admin,
    );

    await waitFor(panel, 'sync:snapshot', before + 1);
    expect(
      lastSnapshot<{ partyGrants: Array<{ partyId: string; level: string }> }>(panel).partyGrants,
    ).toEqual([{ partyId: party.id, level: 'view' }]);
  });

  it('neither signs out nor re-snapshots a panel holding a dead token (C6)', async () => {
    const role = await roleService.createRole(
      { name: 'Sales', tier: 'management', permissions: ['leads.view'] },
      admin,
    );
    await createStaff('sunita', role.id);
    const panel = await connectPanel('PUSH05');
    const token = await signIn(panel, 'sunita');

    // Ends the session without the C5 push — the way a plain expiry does.
    authService.signOut(token);
    const before = count(panel, 'sync:snapshot');

    await roleService.updateRole(
      role.id,
      { name: 'Sales', tier: 'management', permissions: ['leads.view', 'orders.view'], expectedVersion: role.sync.version },
      admin,
    );
    await settle();

    expect(count(panel, 'sync:snapshot')).toBe(before);
    expect(count(panel, 'session:rejected')).toBe(0);
  });
});
