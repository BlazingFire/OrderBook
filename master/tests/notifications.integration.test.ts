/**
 * The notification centre (the bell): storing, deduping, listing, marking
 * read and pruning a person's notices, and who a live `notification:new`
 * reaches. Real sockets and a real HTTP app, because the thing under test is
 * that a person only ever sees their own.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LONG_OFFLINE_MS, type Permission } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { createApp } from '../src/http/app.js';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import * as notificationRepo from '../src/repositories/notification.repository.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as notificationService from '../src/services/notification.service.js';
import * as panelService from '../src/services/panel.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

interface Client {
  socket: Socket;
  seen: Array<{ event: string; args: unknown[] }>;
}

interface Person {
  id: string;
  username: string;
  token: string;
}

let server: HttpServer;
let hub: RealtimeHub;
let app: Express;
let admin: ActorContext;
let tenantId: string;
let clients: Client[] = [];

const PASSWORD = 'correct-horse';

const notice = (panel = 'Front desk') => ({
  kind: 'panel.offlineLong' as const,
  params: { panel },
  link: { kind: 'panel' as const, id: randomUUID() },
});

async function person(
  username: string,
  tier: 'admin' | 'management',
  permissions: Permission[],
): Promise<Person> {
  const role = await roleService.createRole(
    { name: `Role ${username}`, tier, permissions },
    admin,
  );
  const { user } = await userService.createUser(
    { username, displayName: username, roleId: role.id, password: PASSWORD },
    admin,
  );
  const { token } = await authService.signIn(username, PASSWORD);
  return { id: user.id, username, token };
}

const actorOf = (who: Person): Promise<ActorContext> =>
  testActor({ actorId: who.id, userId: who.id });

async function rowsFor(userId: string): Promise<Array<{ id: string; read_at: Date | null }>> {
  return db()('user_notifications').where({ user_id: userId }).select('id', 'read_at');
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
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

const received = (client: Client, event: string) =>
  client.seen.filter((entry) => entry.event === event).map((entry) => entry.args[0]);

/** A Master browser signed in as `who`, once the hub has taken it in. */
async function masterBrowser(who: Person): Promise<Client> {
  const client = open({ kind: 'master-admin', sessionToken: who.token });
  await until(() => received(client, 'panels:changed').length > 0, 'the admin socket');
  return client;
}

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

/** A panel socket, acting as `who` from its handshake (or as itself). */
async function panelSocket(deviceCode: string, who?: Person): Promise<Client> {
  const client = open({
    kind: 'office-panel',
    panelId: await pairPanel(deviceCode),
    panelSecret: 'panel-secret',
    protocol: 3,
    ...(who ? { actingUserToken: who.token } : {}),
  });
  await until(() => received(client, 'sync:snapshot').length > 0, 'the panel snapshot');
  return client;
}

function ask<T>(client: Client, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

describe.skipIf(!canRunIntegrationTests)('notification centre (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
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
    vi.useRealTimers();
    for (const client of clients) client.socket.close();
  });

  it('stores a notice per person and pushes it only to sockets acting as that person', async () => {
    const asha = await person('asha', 'management', ['leads.view']);
    const bina = await person('bina', 'management', ['leads.view']);
    const ashaBrowser = await masterBrowser(asha);
    const binaBrowser = await masterBrowser(bina);
    const ashaPanel = await panelSocket('NOTE01', asha);
    const binaPanel = await panelSocket('NOTE02', bina);
    const idlePanel = await panelSocket('NOTE03');

    await notificationService.notify(tenantId, [asha.id, asha.id], notice('Godown'));

    await until(() => received(ashaPanel, 'notification:new').length === 1, 'the panel push');
    await until(() => received(ashaBrowser, 'notification:new').length === 1, 'the browser push');
    await settle();

    expect(await rowsFor(asha.id)).toHaveLength(1);
    expect(received(ashaPanel, 'notification:new')[0]).toMatchObject({
      kind: 'panel.offlineLong',
      params: { panel: 'Godown' },
      forUserId: asha.id,
      readAt: null,
    });
    expect(received(binaBrowser, 'notification:new')).toEqual([]);
    expect(received(binaPanel, 'notification:new')).toEqual([]);
    expect(received(idlePanel, 'notification:new')).toEqual([]);
  });

  it('writes on its own connection, so a caller must call it after its own commit', async () => {
    const asha = await person('asha', 'management', ['leads.view']);

    await db()
      .transaction(async () => {
        await notificationService.notify(tenantId, [asha.id], notice());
        throw new Error('the business change rolls back');
      })
      .catch(() => undefined);

    // The notice outlived the rollback: nothing ties it to the caller's
    // transaction, which is why every producer notifies only after commit.
    expect(await rowsFor(asha.id)).toHaveLength(1);
  });

  it('adds no second unread notice with the same dedupe key, and pushes nothing for it', async () => {
    const asha = await person('asha', 'management', ['leads.view']);
    const browser = await masterBrowser(asha);
    const input = { ...notice(), dedupeKey: 'panel.offlineLong:P1' };

    await notificationService.notify(tenantId, [asha.id], input);
    await notificationService.notify(tenantId, [asha.id], input);
    await settle();
    expect(await rowsFor(asha.id)).toHaveLength(1);
    expect(received(browser, 'notification:new')).toHaveLength(1);

    // Once it is read, the same key may notify again.
    await notificationService.markRead({ all: true }, await actorOf(asha));
    await notificationService.notify(tenantId, [asha.id], input);
    expect(await rowsFor(asha.id)).toHaveLength(2);
  });

  it('lists and marks read over REST, only ever the signed-in person\'s own rows', async () => {
    const asha = await person('asha', 'management', ['leads.view']);
    const bina = await person('bina', 'management', ['leads.view']);
    await notificationService.notify(tenantId, [asha.id, bina.id], notice('One'));
    // A clear millisecond apart, so newest-first and paging have one answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await notificationService.notify(tenantId, [asha.id], notice('Two'));
    const [binaRow] = await rowsFor(bina.id);

    await request(app).get('/api/notifications').expect(401);

    const agent = request.agent(app);
    await agent.post('/api/auth/sign-in').send({ username: 'asha', password: PASSWORD }).expect(200);

    const listed = await agent.get('/api/notifications').expect(200);
    expect(listed.body.unreadCount).toBe(2);
    expect(listed.body.items.map((item: { params: { panel: string } }) => item.params.panel)).toEqual(['Two', 'One']);

    // Paging back from the newest returns only the older one.
    const older = await agent
      .get('/api/notifications')
      .query({ limit: 1, before: listed.body.items[0].createdAt })
      .expect(200);
    expect(older.body.items.map((item: { params: { panel: string } }) => item.params.panel)).toEqual(['One']);
    await agent.get('/api/notifications').query({ before: 'yesterday-ish' }).expect(400);

    // Bina's id is not Asha's to mark; a junk id matches nothing.
    const marked = await agent
      .post('/api/notifications/read')
      .send({ ids: [binaRow!.id, 'not-an-id', listed.body.items[0].id] })
      .expect(200);
    expect(marked.body.unreadCount).toBe(1);
    expect((await rowsFor(bina.id))[0]!.read_at).toBeNull();

    const all = await agent.post('/api/notifications/read').send({ all: true }).expect(200);
    expect(all.body.unreadCount).toBe(0);
    expect((await rowsFor(bina.id))[0]!.read_at).toBeNull();
  });

  it('answers the socket commands for the acting person, and nothing to a panel nobody is signed in on', async () => {
    const asha = await person('asha', 'management', ['leads.view']);
    const bina = await person('bina', 'management', ['leads.view']);
    await notificationService.notify(tenantId, [asha.id], notice('Mine'));
    await notificationService.notify(tenantId, [bina.id], notice('Hers'));

    const idle = await panelSocket('NOTE04');
    expect(await ask(idle, 'notification:list', {})).toEqual({
      ok: true,
      data: { items: [], unreadCount: 0 },
    });

    const panel = await panelSocket('NOTE05', asha);
    const listed = await ask<{ ok: boolean; data: { items: Array<{ params: { panel: string } }>; unreadCount: number } }>(
      panel,
      'notification:list',
      {},
    );
    expect(listed.data.unreadCount).toBe(1);
    expect(listed.data.items.map((item) => item.params.panel)).toEqual(['Mine']);

    expect(await ask(panel, 'notification:markRead', { all: true })).toEqual({
      ok: true,
      data: { unreadCount: 0 },
    });
    expect((await rowsFor(bina.id))[0]!.read_at).toBeNull();
  });

  it("tells a new order's owner when somebody else changes or deletes it, and nobody for their own", async () => {
    const owner = await person('owner', 'management', ['leads.view', 'leads.create', 'leads.edit', 'leads.delete']);
    const party = await catalogService.createParty({ name: 'Notice Traders' }, admin);
    const product = await catalogService.createProduct(
      { name: 'Notice Pan', categoryName: 'Pans', variants: [{ code: 'NTC-01' }] },
      admin,
    );
    const items = [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 5 }];
    const lead = await leadService.createLead({ partyId: party.id, ownerId: owner.id, items }, admin);

    // The owner's own edit tells nobody.
    await leadService.updateLead(lead.id, { notes: 'mine' }, await actorOf(owner));
    expect(await rowsFor(owner.id)).toHaveLength(0);

    // Two edits by someone else collapse into one unread notice, linked to the order.
    await leadService.updateLead(lead.id, { notes: 'one' }, admin);
    await leadService.updateLead(lead.id, { notes: 'two' }, admin);
    const edited = await db()('user_notifications').where({ user_id: owner.id, kind: 'lead.edited' });
    expect(edited).toHaveLength(1);
    expect(edited[0].link).toMatchObject({ kind: 'lead', id: lead.id });

    await leadService.deleteLead(lead.id, admin);
    const deleted = await db()('user_notifications').where({ user_id: owner.id, kind: 'lead.deleted' });
    expect(deleted).toHaveLength(1);
    expect(deleted[0].params).toMatchObject({ party: 'Notice Traders' });
  });

  it('prunes read notices older than 60 days and anything past 500 a person', async () => {
    const asha = await person('asha', 'management', ['leads.view']);
    const bina = await person('bina', 'management', ['leads.view']);

    await db().raw(
      `INSERT INTO user_notifications (tenant_id, user_id, kind, params, created_at, read_at)
       VALUES (?, ?, 'panel.offlineLong', '{}', now() - interval '90 days', now() - interval '61 days'),
              (?, ?, 'panel.offlineLong', '{}', now() - interval '90 days', NULL),
              (?, ?, 'panel.offlineLong', '{}', now() - interval '30 days', now() - interval '20 days')`,
      [tenantId, asha.id, tenantId, asha.id, tenantId, asha.id],
    );
    await db().raw(
      `INSERT INTO user_notifications (tenant_id, user_id, kind, params, created_at)
       SELECT ?, ?, 'panel.offlineLong', jsonb_build_object('panel', 'N' || n), now() - n * interval '1 minute'
         FROM generate_series(1, 502) AS n`,
      [tenantId, bina.id],
    );

    expect(await notificationRepo.prune()).toBe(3);

    // The old unread one stays: only read notices age out.
    expect(await rowsFor(asha.id)).toHaveLength(2);
    expect(await rowsFor(bina.id)).toHaveLength(500);
    const oldest = await db()('user_notifications')
      .where({ user_id: bina.id })
      .orderBy('created_at', 'asc')
      .first<{ params: { panel: string } }>('params');
    expect(oldest?.params.panel).toBe('N500');
  });

  it('tells only panels.manage holders when a panel stays away an hour, and not after it returns', async () => {
    const manager = await person('meera', 'admin', ['panels.manage']);
    const clerk = await person('kiran', 'management', ['leads.view']);
    const away = await pairPanel('NOTE06');
    const back = await pairPanel('NOTE07');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await panelService.markPanelDisconnected(away);
    await panelService.markPanelDisconnected(back);
    await panelService.markPanelConnected(back, null);
    vi.advanceTimersByTime(LONG_OFFLINE_MS);
    vi.useRealTimers();

    await until(async () => (await rowsFor(manager.id)).length === 1, 'the long-offline notice');
    await settle();

    const rows = await db()('user_notifications').select('user_id', 'kind', 'params', 'link', 'dedupe_key');
    expect(rows).toEqual([
      {
        user_id: manager.id,
        kind: 'panel.offlineLong',
        params: { panel: 'Panel NOTE06' },
        link: { kind: 'panel', id: away },
        dedupe_key: `panel.offlineLong:${away}`,
      },
    ]);
    expect(await rowsFor(clerk.id)).toEqual([]);
    panelService.cancelLongOfflineNotices();
  });
});
