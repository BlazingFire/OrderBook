/**
 * Who a live chat push reaches: the room's members who hold `chat.use`, on the
 * socket that is acting as them right now, and nobody else.
 *
 * Real sockets, because the thing under test is addressing. Chat travels on
 * its own bus channel and never through the change ring, which the last test
 * pins: a panel's catch-up cursor must not move for a message.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ChatPush, Permission } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import * as changeRing from '../src/realtime/change-ring.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as catalog from '../src/services/catalog.service.js';
import * as chat from '../src/services/chat.service.js';
import * as leads from '../src/services/lead.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { testTenantId } from './helpers/fixtures.js';

interface Client {
  socket: Socket;
  seen: Array<{ event: string; args: unknown[] }>;
}

interface Person {
  id: string;
  token: string;
  actor: ActorContext;
}

const PASSWORD = 'correct-horse';
const BASIC: Permission[] = ['chat.use', 'leads.view', 'orders.view', 'chat.shareRecords'];

let server: HttpServer;
let hub: RealtimeHub;
let admin: ActorContext;
let clients: Client[] = [];

async function person(username: string, permissions: Permission[] = BASIC, tier: 'office' | 'management' = 'office'): Promise<Person> {
  const role = await roleService.createRole({ name: `Role ${username}`, tier, permissions }, admin);
  const { user } = await userService.createUser(
    { username, displayName: username, roleId: role.id, password: PASSWORD },
    admin,
  );
  const { token } = await authService.signIn(username, PASSWORD);
  const actor = { ...(await actorWith(permissions)), actorId: user.id, userId: user.id, actorName: username };
  return { id: user.id, token, actor };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

function open(auth: Record<string, unknown>): Client {
  const { port } = server.address() as AddressInfo;
  const socket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth });
  const client = { socket, seen: [] as Client['seen'] };
  socket.onAny((event: string, ...args: unknown[]) => client.seen.push({ event, args }));
  clients.push(client);
  return client;
}

const pushes = (client: Client): Array<ChatPush & { forUserId: string }> =>
  client.seen.filter((entry) => entry.event === 'chat:event').map((entry) => entry.args[0] as ChatPush & { forUserId: string });

async function masterBrowser(who: Person): Promise<Client> {
  const client = open({ kind: 'master-admin', sessionToken: who.token });
  await until(() => client.seen.some((entry) => entry.event === 'panels:changed'), 'the admin socket');
  return client;
}

async function panelSocket(deviceCode: string, who?: Person, protocol = 5): Promise<Client> {
  const id = randomUUID();
  await panelRepo.insertPanel({
    id,
    tenant_id: await testTenantId(),
    name: `Panel ${deviceCode}`,
    device_code: deviceCode,
    secret_hash: await bcrypt.hash('panel-secret', 4),
    lan_ip: '192.168.1.20',
    status: 'active',
    paired_at: new Date(),
  });
  const client = open({
    kind: 'office-panel',
    panelId: id,
    panelSecret: 'panel-secret',
    protocol,
    ...(who ? { actingUserToken: who.token } : {}),
  });
  await until(() => client.seen.some((entry) => entry.event === 'sync:snapshot'), 'the panel snapshot');
  return client;
}

describe.skipIf(!canRunIntegrationTests)('chat fan-out (integration)', () => {
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
    clients = [];
  });

  afterEach(() => {
    for (const client of clients) client.socket.close();
  });

  it('reaches the room\'s members on the sockets acting as them, and no one else', async () => {
    const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
    const bina = await person('bina');
    const chetan = await person('chetan');
    const roomId = (await chat.createRoom({ name: 'Floor', memberIds: [bina.id] }, asha.actor)).id;

    const ashaBrowser = await masterBrowser(asha);
    const binaPanel = await panelSocket('CHAT01', bina);
    const chetanBrowser = await masterBrowser(chetan);
    const chetanPanel = await panelSocket('CHAT02', chetan);
    const idlePanel = await panelSocket('CHAT03');
    await settle();

    await chat.postMessage(roomId, { body: 'Truck at the gate' }, asha.actor);
    await until(() => pushes(binaPanel).some((push) => push.kind === 'message'), 'the member push');
    await until(() => pushes(ashaBrowser).some((push) => push.kind === 'message'), 'the author push');
    await settle();

    const message = pushes(binaPanel).find((push) => push.kind === 'message');
    expect(message).toMatchObject({ roomId, forUserId: bina.id, message: { body: 'Truck at the gate' } });
    // Not a member: nothing, on either of Chetan's sockets or the bare panel.
    expect(pushes(chetanBrowser)).toEqual([]);
    expect(pushes(chetanPanel)).toEqual([]);
    expect(pushes(idlePanel)).toEqual([]);
  });

  it('skips a member who has lost chat.use, and a panel older than the chat protocol', async () => {
    const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
    const bina = await person('bina');
    const roomId = (await chat.createRoom({ name: 'Floor', memberIds: [bina.id] }, asha.actor)).id;

    const old = await panelSocket('CHAT04', bina, 3);
    await settle();
    await chat.postMessage(roomId, { body: 'for the old panel' }, asha.actor);
    await settle();
    expect(pushes(old)).toEqual([]);

    // Taking chat.use away from the role ends delivery at once, though Bina is still a member.
    const current = await panelSocket('CHAT05', bina);
    const role = await roleService.listRoles(admin).then((roles) => roles.find((r) => r.name === 'Role bina'));
    await roleService.updateRole(
      role!.id,
      {
        name: role!.name,
        tier: role!.tier,
        permissions: role!.permissions.filter((key) => key !== 'chat.use'),
        expectedVersion: role!.sync.version,
      },
      admin,
    );
    await settle();
    const before = pushes(current).length;
    await chat.postMessage(roomId, { body: 'after the change' }, asha.actor);
    await settle();
    expect(pushes(current).length).toBe(before);
  });

  it('resolves a record chip again for each recipient, so a restricted party is never named to one who may not see it', async () => {
    const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
    const bina = await person('bina');
    const party = await catalog.createParty({ name: 'Closed Traders' }, admin);
    const { product, variant } = await createTestProduct(admin, { name: 'Glazed Tile' });
    const lead = await leads.createLead(
      { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 1, packaging: 'carton' }] },
      admin,
    );
    await partyAccess.replaceAssignments(
      party.id,
      { entries: [{ userId: asha.id, level: 'manage' }], expectedVersion: party.sync.version },
      admin,
    );
    const roomId = (await chat.createRoom({ name: 'Floor', memberIds: [bina.id] }, asha.actor)).id;

    const ashaPanel = await panelSocket('CHAT06', asha);
    const binaPanel = await panelSocket('CHAT07', bina);
    await settle();

    await chat.postMessage(roomId, { body: 'see this', refs: [{ kind: 'lead', id: lead.id }] }, asha.actor);
    await until(() => pushes(binaPanel).some((push) => push.kind === 'message'), 'Bina\'s push');
    await until(() => pushes(ashaPanel).some((push) => push.kind === 'message'), 'Asha\'s push');

    const chipOf = (client: Client) => {
      const push = pushes(client).find((entry) => entry.kind === 'message');
      return push && push.kind === 'message' ? push.message.refs[0] : undefined;
    };
    expect(chipOf(ashaPanel)).toMatchObject({ restricted: false, partyName: 'Closed Traders' });
    expect(chipOf(binaPanel)).toEqual({ kind: 'lead', id: lead.id, label: null, partyName: null, restricted: true });
  });

  it('never enters the change ring, so a panel\'s catch-up cursor does not move for a message', async () => {
    const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
    const roomId = (await chat.createRoom({ name: 'Floor' }, asha.actor)).id;
    const before = changeRing.currentSeq();

    await chat.postMessage(roomId, { body: 'quiet' }, asha.actor);
    await chat.setMember({ roomId, userId: asha.id, role: 'admin' }, asha.actor).catch(() => undefined);

    expect(changeRing.currentSeq()).toBe(before);
  });
});
