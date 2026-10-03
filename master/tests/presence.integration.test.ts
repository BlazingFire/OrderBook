/**
 * Live presence (rule 3) against a real database, hub and HTTP stack.
 *
 * What is proved here: who is beating comes from the socket or the session,
 * never from the beat; a person who may not see a record cannot join it, and
 * a person who lost access to its party is not told who else is on it; and a
 * Master browser tab leaves its record when its socket closes.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardPresence, CommandResult, Permission, RecordPresence } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { createApp } from '../src/http/app.js';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as partyAccessRepo from '../src/repositories/party-access.repository.js';
import * as presenceService from '../src/services/presence.service.js';
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
const DESK: Permission[] = ['leads.view', 'leads.create', 'leads.edit', 'orders.view', 'parties.view'];

async function person(username: string): Promise<Person> {
  const role = await roleService.createRole({ name: `Role ${username}`, tier: 'management', permissions: DESK }, admin);
  const { user } = await userService.createUser(
    { username, displayName: `Name ${username}`, roleId: role.id, password: PASSWORD },
    admin,
  );
  const { token } = await authService.signIn(username, PASSWORD);
  return { id: user.id, username, token };
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

const pushes = (client: Client) =>
  client.seen
    .filter((entry) => entry.event === 'presence:changed')
    .map((entry) => entry.args[0] as RecordPresence & { forUserId: string });

/** A panel socket acting as `who` from its handshake, or as itself. */
async function panelSocket(deviceCode: string, who?: Person, protocol = 4): Promise<Client> {
  const panelId = randomUUID();
  await panelRepo.insertPanel({
    id: panelId,
    tenant_id: tenantId,
    name: `Panel ${deviceCode}`,
    device_code: deviceCode,
    secret_hash: await bcrypt.hash('panel-secret', 4),
    lan_ip: '192.168.1.20',
    status: 'active',
    paired_at: new Date(),
  });
  const client = open({
    kind: 'office-panel',
    panelId,
    panelSecret: 'panel-secret',
    protocol,
    ...(who ? { actingUserToken: who.token } : {}),
  });
  await until(() => client.seen.some((entry) => entry.event === 'sync:snapshot'), 'the panel snapshot');
  return client;
}

function beat(client: Client, payload: unknown): Promise<CommandResult<RecordPresence | null>> {
  return new Promise((resolve) => client.socket.emit('presence:beat', payload, resolve));
}

async function seedLead() {
  const party = await catalog.createParty({ name: 'Closed Traders' }, admin);
  const product = await catalog.createProduct(
    { categoryName: 'Tiles', variants: [{ code: 'PR-01' }], name: 'Glazed Tile' },
    admin,
  );
  const lead = await leads.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 3, packaging: 'carton' }],
    },
    admin,
  );
  return { party, lead, product };
}

/** Another lead on the same party and product. */
async function anotherLead(party: { id: string }, product: Awaited<ReturnType<typeof catalog.createProduct>>) {
  return leads.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 2, packaging: 'carton' }],
    },
    admin,
  );
}

async function restrictTo(party: { id: string }, ...userIds: string[]): Promise<void> {
  const current = await catalog.getParty(party.id, admin);
  await partyAccess.replaceAssignments(
    party.id,
    { entries: userIds.map((userId) => ({ userId, level: 'manage' as const })), expectedVersion: current.sync.version },
    admin,
  );
}

describe.skipIf(!canRunIntegrationTests)('live presence (integration)', () => {
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

  afterEach(async () => {
    for (const client of clients) client.socket.close();
    // Let the closing sockets take their tabs off before the next test resets.
    await settle();
  });

  it('takes who is beating from the socket, never from the beat', async () => {
    const { lead } = await seedLead();
    const asha = await person('asha');
    const bina = await person('bina');
    const panel = await panelSocket('PRS01', asha);

    const answer = await beat(panel, {
      tabId: 'tab-1',
      recordKind: 'lead',
      recordId: lead.id,
      editing: true,
      // None of these is read.
      userId: bina.id,
      displayName: 'Somebody else',
      tier: 'server_master',
    });

    expect(answer.ok).toBe(true);
    const entries = answer.ok ? answer.data!.entries : [];
    expect(entries).toEqual([
      expect.objectContaining({ userId: asha.id, displayName: 'Name asha', tier: 'management', editing: true }),
    ]);
  });

  it('refuses a panel with nobody signed in, and a beat of the wrong shape', async () => {
    const { lead } = await seedLead();
    const idle = await panelSocket('PRS02');
    const asha = await panelSocket('PRS03', await person('asha'));

    const refused = await beat(idle, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    expect(refused).toMatchObject({ ok: false, code: 'unauthorized' });

    const malformed = await beat(asha, { tabId: 'a:b', recordKind: 'lead', recordId: lead.id });
    expect(malformed).toMatchObject({ ok: false, messageKey: 'validation.presence.invalid' });
  });

  it('never lets somebody outside a restricted party join or see who is on its lead', async () => {
    const { party, lead } = await seedLead();
    const asha = await person('asha');
    const bina = await person('bina');
    await restrictTo(party, asha.id);
    const ashaPanel = await panelSocket('PRS04', asha);
    const binaPanel = await panelSocket('PRS05', bina);

    const inside = await beat(ashaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    expect(inside.ok).toBe(true);

    const outside = await beat(binaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    // The same answer as a lead that does not exist.
    expect(outside).toMatchObject({ ok: false, code: 'not_found' });
    await settle();
    expect(pushes(binaPanel)).toEqual([]);
  });

  it('stops telling somebody who lost access to the party who else is on the lead', async () => {
    const { party, lead } = await seedLead();
    const asha = await person('asha');
    const bina = await person('bina');
    const chen = await person('chen');
    const ashaPanel = await panelSocket('PRS06', asha);
    const binaPanel = await panelSocket('PRS07', bina);
    const chenPanel = await panelSocket('PRS08', chen);

    // Open party: both are on the lead, and each hears of the other.
    await beat(ashaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    await beat(binaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    await until(() => pushes(ashaPanel).some((p) => p.entries.length === 2), 'the push to Asha');
    await until(() => pushes(binaPanel).some((p) => p.entries.length === 2), 'the push to Bina');
    expect(pushes(binaPanel).at(-1)).toMatchObject({ forUserId: bina.id, recordId: lead.id });

    // The party is closed to all but Asha and Chen; Bina is still on the lead until her next beat.
    await restrictTo(party, asha.id, chen.id);
    await settle();
    const binaBefore = pushes(binaPanel).length;

    await beat(chenPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    await until(
      () => pushes(ashaPanel).some((p) => p.entries.some((entry) => entry.userId === chen.id)),
      'the push naming Chen',
    );
    await settle();

    expect(pushes(binaPanel)).toHaveLength(binaBefore);
    expect(pushes(chenPanel).at(-1)?.forUserId).toBe(chen.id);

    // And her own next beat takes her off it.
    const refused = await beat(binaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    expect(refused).toMatchObject({ ok: false, code: 'not_found' });
    await until(
      () => pushes(ashaPanel).at(-1)?.entries.some((entry) => entry.userId === bina.id) === false,
      'the push without Bina',
    );
  });

  it('lets a Master browser beat over HTTP as its session, and leave when its tab’s socket closes', async () => {
    const { lead } = await seedLead();
    const asha = await person('asha');
    const ashaPanel = await panelSocket('PRS09', asha);
    await person('dev');

    const agent = request.agent(app);
    await agent.post('/api/auth/sign-in').send({ username: 'dev', password: PASSWORD }).expect(200);
    const devId = ((await agent.get('/api/auth/me').expect(200)).body as { user: { id: string } }).user.id;

    await beat(ashaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
    const answer = await agent
      .post('/api/presence')
      .send({ tabId: 'browser-1', recordKind: 'lead', recordId: lead.id, userId: asha.id })
      .expect(200);
    expect((answer.body as RecordPresence).entries.map((entry) => entry.userId).sort()).toEqual(
      [asha.id, devId].sort(),
    );
    await agent.post('/api/presence').send({ tabId: 'bad tab', recordKind: 'lead', recordId: lead.id }).expect(400);

    // The tab's own socket, carrying the same tab id: closing it takes the tab off the lead.
    const { token } = await authService.signIn('dev', PASSWORD);
    const browser = open({ kind: 'master-admin', sessionToken: token, tabId: 'browser-1' });
    await until(() => browser.seen.some((entry) => entry.event === 'panels:changed'), 'the admin socket');
    await until(() => pushes(ashaPanel).some((p) => p.entries.length === 2), 'the push naming the browser');

    browser.socket.close();
    await until(
      () => pushes(ashaPanel).at(-1)?.entries.map((entry) => entry.userId).join() === asha.id,
      'the push after the tab closed',
    );
  });

  describe('the board feed (R22)', () => {
    const boards = (client: Client) =>
      client.seen
        .filter((entry) => entry.event === 'presence:board')
        .map((entry) => entry.args[0] as BoardPresence & { forUserId: string });

    const askBoard = (client: Client, kind: unknown): Promise<CommandResult<BoardPresence>> =>
      new Promise((resolve) => client.socket.emit('presence:board', kind, resolve));

    it('pushes the whole board to everyone who may read it, and a card loses the face that leaves', async () => {
      const { lead } = await seedLead();
      const asha = await person('asha');
      const bela = await person('bela');
      const carl = await person('carl');
      const ashaPanel = await panelSocket('BRD01', asha, 7);
      const belaPanel = await panelSocket('BRD02', bela, 7);
      // An Office from before protocol 7 does not know the event and is not sent it.
      const carlPanel = await panelSocket('BRD03', carl, 6);

      await beat(ashaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id, editing: true });

      await until(() => boards(belaPanel).length > 0, 'the board push');
      const pushed = boards(belaPanel).at(-1)!;
      expect(pushed).toMatchObject({ recordKind: 'lead', forUserId: bela.id });
      expect(Object.keys(pushed.records)).toEqual([lead.id]);
      expect(pushed.records[lead.id]!.map((entry) => [entry.userId, entry.editing])).toEqual([[asha.id, true]]);

      await beat(ashaPanel, { tabId: 'tab-1' });
      await until(() => Object.keys(boards(belaPanel).at(-1)?.records ?? {}).length === 0, 'the empty board');

      expect(boards(carlPanel)).toEqual([]);
      expect(boards(belaPanel).every((board) => board.recordKind === 'lead')).toBe(true);
    });

    it('gathers a burst of joins on different cards into one push per reader (500 ms throttle)', async () => {
      const { party, lead, product } = await seedLead();
      const second = await anotherLead(party, product);
      const third = await anotherLead(party, product);
      const asha = await person('asha');
      const bela = await person('bela');
      const ashaPanel = await panelSocket('BRD10', asha, 7);
      const belaPanel = await panelSocket('BRD11', bela, 7);

      // Three cards opened 150 ms apart: past each record's own 100 ms debounce, inside the board's window.
      for (const [index, target] of [lead, second, third].entries()) {
        await beat(ashaPanel, { tabId: `tab-${index}`, recordKind: 'lead', recordId: target.id });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await until(() => boards(belaPanel).length > 0, 'the board push');
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(boards(belaPanel)).toHaveLength(1);
      expect(Object.keys(boards(belaPanel)[0]!.records).sort()).toEqual([lead.id, second.id, third.id].sort());
    });

    it('fetches each party’s grants once for a push, however many readers it goes to', async () => {
      const { party, lead } = await seedLead();
      const asha = await person('asha');
      const bela = await person('bela');
      const ashaActor = await testActor({ actorType: 'user', userId: asha.id, actorId: asha.id });
      const belaActor = await testActor({ actorType: 'user', userId: bela.id, actorId: bela.id });
      await presenceService.beat(ashaActor, `admin:${asha.id}:`, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
      void party;
      expect(await catalog.getParty(party.id, admin)).toBeDefined();

      const grantsOf = vi.spyOn(partyAccessRepo, 'grantsForParty');
      try {
        const shared = presenceService.boardSnapshot(tenantId, 'lead');
        await presenceService.boardFor(ashaActor, 'lead', shared);
        await presenceService.boardFor(belaActor, 'lead', shared);
        expect(grantsOf).toHaveBeenCalledTimes(1);

        grantsOf.mockClear();
        await presenceService.boardFor(ashaActor, 'lead');
        await presenceService.boardFor(belaActor, 'lead');
        expect(grantsOf).toHaveBeenCalledTimes(2);
      } finally {
        grantsOf.mockRestore();
      }
    });

    it('hands every reader of one push the same snapshot, so the grants are fetched once', async () => {
      const { lead } = await seedLead();
      const asha = await person('asha');
      const bela = await person('bela');
      const carl = await person('carl');
      const ashaPanel = await panelSocket('BRD12', asha, 7);
      const belaPanel = await panelSocket('BRD13', bela, 7);
      const carlPanel = await panelSocket('BRD14', carl, 7);

      const boardFor = vi.spyOn(presenceService, 'boardFor');
      try {
        await beat(ashaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });
        await until(
          () => [ashaPanel, belaPanel, carlPanel].every((panel) => boards(panel).length > 0),
          'the board push to all three',
        );
        await settle();

        const snapshots = boardFor.mock.calls.map((call) => call[2]);
        expect(snapshots.length).toBeGreaterThanOrEqual(3);
        // Every reader was given a snapshot (not left to take its own), and readers of one push share it.
        expect(snapshots.every((snapshot) => snapshot !== undefined)).toBe(true);
        expect(new Set(snapshots).size).toBeLessThan(snapshots.length);
      } finally {
        boardFor.mockRestore();
      }
    });

    it('answers the board on request, and never names a card of a party the reader cannot open', async () => {
      const { party, lead } = await seedLead();
      const asha = await person('asha');
      const bela = await person('bela');
      const ashaPanel = await panelSocket('BRD04', asha, 7);
      const belaPanel = await panelSocket('BRD05', bela, 7);
      await restrictTo(party, asha.id);

      await beat(ashaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });

      const mine = await askBoard(ashaPanel, 'lead');
      expect(mine.ok && Object.keys(mine.data.records)).toEqual([lead.id]);
      const theirs = await askBoard(belaPanel, 'lead');
      expect(theirs.ok).toBe(true);
      expect(theirs.ok && theirs.data).toEqual({ recordKind: 'lead', records: {} });

      await settle();
      expect(boards(belaPanel).every((board) => Object.keys(board.records).length === 0)).toBe(true);
    });

    it('refuses a kind that is not a board and a person without the module', async () => {
      const asha = await person('asha');
      const ashaPanel = await panelSocket('BRD06', asha, 7);
      const noLeads = await roleService.createRole(
        { name: 'Orders only', tier: 'management', permissions: ['orders.view'] },
        admin,
      );
      const { user } = await userService.createUser(
        { username: 'olga', displayName: 'Name olga', roleId: noLeads.id, password: PASSWORD },
        admin,
      );
      const { token } = await authService.signIn('olga', PASSWORD);
      const olgaPanel = await panelSocket('BRD07', { id: user.id, username: 'olga', token }, 7);

      expect(await askBoard(ashaPanel, 'party')).toMatchObject({ ok: false });
      expect(await askBoard(olgaPanel, 'lead')).toMatchObject({ ok: false });
      expect(await askBoard(olgaPanel, 'order')).toMatchObject({ ok: true });
    });

    it('answers a Master browser over HTTP with the same board', async () => {
      const { lead } = await seedLead();
      const asha = await person('asha');
      const ashaPanel = await panelSocket('BRD08', asha, 7);
      await person('dev');
      await beat(ashaPanel, { tabId: 'tab-1', recordKind: 'lead', recordId: lead.id });

      const agent = request.agent(app);
      await agent.post('/api/auth/sign-in').send({ username: 'dev', password: PASSWORD }).expect(200);
      const board = (await agent.get('/api/presence/board?kind=lead').expect(200)).body as BoardPresence;
      expect(Object.keys(board.records)).toEqual([lead.id]);
      await agent.get('/api/presence/board?kind=party').expect(400);
      await agent.get('/api/presence/board').expect(400);
    });
  });
});
