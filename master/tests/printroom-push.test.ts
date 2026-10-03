/**
 * Who a live Printroom push reaches, and that a claim belongs to the connection
 * that made it: the sender and every `print.station` holder, on the socket that
 * is acting as them right now, and nobody else; a panel older than the Printroom
 * protocol is not sent the event; a station's socket closing puts its job back.
 *
 * Real sockets, because the thing under test is addressing and connection
 * lifetime. The Printroom travels on its own bus channel and never through the
 * change ring, which the last test pins.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Permission, PrintJob, PrintJobSummary } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import * as changeRing from '../src/realtime/change-ring.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as print from '../src/services/print.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

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
const SENDER: Permission[] = ['print.send', 'leads.view', 'leads.export'];
const STATION: Permission[] = ['print.station'];

let server: HttpServer;
let hub: RealtimeHub;
let admin: ActorContext;
let clients: Client[] = [];
let leadId: string;

async function person(username: string, permissions: Permission[]): Promise<Person> {
  const role = await roleService.createRole({ name: `Role ${username}`, tier: 'office', permissions }, admin);
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

const pushes = (client: Client): Array<PrintJobSummary & { forUserId: string }> =>
  client.seen
    .filter((entry) => entry.event === 'print:changed')
    .map((entry) => entry.args[0] as PrintJobSummary & { forUserId: string });

async function masterBrowser(who: Person): Promise<Client> {
  const client = open({ kind: 'master-admin', sessionToken: who.token });
  await until(() => client.seen.some((entry) => entry.event === 'panels:changed'), 'the admin socket');
  return client;
}

async function panelSocket(deviceCode: string, who?: Person, protocol = 6): Promise<Client & { panelId: string }> {
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
  return Object.assign(client, { panelId: id });
}

type Ack<T> = { ok: true; data: T } | { ok: false; error: string; messageKey?: string };

function command<T>(client: Client, event: string, ...args: unknown[]): Promise<Ack<T>> {
  return new Promise((resolve) => client.socket.emit(event, ...args, resolve));
}

async function send(sender: Person): Promise<PrintJob> {
  return print.sendJob(
    { requestId: randomUUID().replace(/-/g, ''), kind: 'filling', source: 'lead', sourceId: leadId, copies: 1 },
    sender.actor,
    { from: 'master', stationKey: null, holder: null },
  );
}

describe.skipIf(!canRunIntegrationTests)('printroom push and connection-held claims (integration)', () => {
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
    const party = await catalog.createParty({ name: 'Push Traders' }, admin);
    const { product, variant } = await createTestProduct(admin, { name: 'Push Tile', code: 'PUSH-1' });
    leadId = (
      await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 2, packaging: 'carton' }] },
        admin,
      )
    ).id;
  });

  afterEach(() => {
    for (const client of clients) client.socket.close();
  });

  it('reaches the sender and every station holder on the sockets acting as them, and no one else', async () => {
    const asha = await person('asha', SENDER);
    const bina = await person('bina', SENDER);
    const desk = await person('desk', STATION);
    const nobody = await person('nobody', ['leads.view']);

    const ashaPanel = await panelSocket('PRT01', asha);
    const binaPanel = await panelSocket('PRT02', bina);
    const deskPanel = await panelSocket('PRT03', desk);
    const deskBrowser = await masterBrowser(desk);
    const nobodyPanel = await panelSocket('PRT04', nobody);
    const idlePanel = await panelSocket('PRT05');
    await settle();

    const job = await send(asha);
    await until(() => pushes(deskPanel).length > 0, 'the station push');
    await until(() => pushes(ashaPanel).length > 0, 'the sender push');
    await until(() => pushes(deskBrowser).length > 0, 'the station browser push');
    await settle();

    expect(pushes(deskPanel)[0]).toMatchObject({ id: job.id, status: 'queued', forUserId: desk.id });
    expect(pushes(ashaPanel)[0]).toMatchObject({ id: job.id, forUserId: asha.id });
    expect(pushes(deskBrowser)[0]).toMatchObject({ id: job.id, forUserId: desk.id });
    // The push carries no sheet.
    expect(pushes(deskPanel)[0]).not.toHaveProperty('document');
    // Another sender, someone with neither key, and a panel with nobody signed in: nothing.
    expect(pushes(binaPanel)).toEqual([]);
    expect(pushes(nobodyPanel)).toEqual([]);
    expect(pushes(idlePanel)).toEqual([]);
  });

  it('skips a panel older than the Printroom protocol, and a holder who has lost the key', async () => {
    const asha = await person('asha', SENDER);
    const desk = await person('desk', STATION);

    const old = await panelSocket('PRT06', desk, 5);
    const current = await panelSocket('PRT07', desk);
    await settle();
    await send(asha);
    await until(() => pushes(current).length > 0, 'the current panel push');
    await settle();
    expect(pushes(old)).toEqual([]);

    const role = await roleService.listRoles(admin).then((roles) => roles.find((r) => r.name === 'Role desk'));
    await roleService.updateRole(
      role!.id,
      { name: role!.name, tier: role!.tier, permissions: [], expectedVersion: role!.sync.version },
      admin,
    );
    await settle();
    const before = pushes(current).length;
    await send(asha);
    await settle();
    expect(pushes(current).length).toBe(before);
  });

  it('holds a panel\'s claim by its socket: the second station is refused, and closing the first puts the job back', async () => {
    const asha = await person('asha', SENDER);
    const one = await person('one', STATION);
    const two = await person('two', STATION);
    const job = await send(asha);

    const first = await panelSocket('PRT08', one);
    const second = await panelSocket('PRT09', two);
    // Each registers itself under its own panel; the key is the connection's, not the payload's.
    const registered = await command<{ id: string }>(first, 'print:station', { printerName: 'HP', autoPrint: true });
    expect(registered.ok).toBe(true);
    expect((await command(second, 'print:station', { printerName: 'HP', autoPrint: true })).ok).toBe(true);

    const won = await command<PrintJob | null>(first, 'print:claim', job.id);
    expect(won).toMatchObject({ ok: true, data: { id: job.id, status: 'printing' } });
    expect(await command<PrintJob | null>(second, 'print:claim', job.id)).toEqual({ ok: true, data: null });

    first.socket.close();
    const deadline = Date.now() + 5000;
    for (;;) {
      const row = await db()('print_jobs').where({ id: job.id }).first('status', 'claim_socket');
      if (row.status === 'queued') {
        expect(row.claim_socket).toBeNull();
        break;
      }
      if (Date.now() > deadline) throw new Error('the claim was not released when its connection closed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await command<PrintJob | null>(second, 'print:claim', job.id)).toMatchObject({ ok: true, data: { status: 'printing' } });
  });

  it('lets the Master PC\'s own window claim over its socket, and gives the job back when the window closes', async () => {
    const asha = await person('asha', SENDER);
    const desk = await person('desk', STATION);
    const job = await send(asha);

    // The window on the Master PC is a station called `master`.
    await print.saveStation({ printerName: 'HP', autoPrint: true }, desk.actor, { from: 'master', stationKey: 'master', holder: null });
    const browser = await masterBrowser(desk);
    const won = await command<PrintJob | null>(browser, 'print:claim', job.id);
    expect(won).toMatchObject({ ok: true, data: { id: job.id, status: 'printing', claimedStationName: 'Master PC' } });

    browser.socket.close();
    const deadline = Date.now() + 5000;
    for (;;) {
      const row = await db()('print_jobs').where({ id: job.id }).first('status');
      if (row.status === 'queued') break;
      if (Date.now() > deadline) throw new Error('the claim was not released when the window closed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  it('refuses a claim from a socket with no print.station, and takes the station from the connection', async () => {
    const asha = await person('asha', SENDER);
    const job = await send(asha);
    const ashaPanel = await panelSocket('PRT10', asha);

    const refused = await command(ashaPanel, 'print:claim', job.id);
    expect(refused).toMatchObject({ ok: false });
    // A forged station id in the payload changes nothing: print:station takes no key from it.
    const desk = await person('desk', STATION);
    const deskPanel = await panelSocket('PRT11', desk);
    const saved = await command<{ id: string }>(deskPanel, 'print:station', {
      printerName: 'HP',
      autoPrint: false,
      stationKey: 'master',
    });
    expect(saved.ok).toBe(true);
    const keys = (await db()('print_stations').select('station_key')).map((row: { station_key: string }) => row.station_key);
    expect(keys).toEqual([`panel:${deskPanel.panelId}`]);
  });

  it('never enters the change ring, so a panel\'s catch-up cursor does not move for a print job', async () => {
    const asha = await person('asha', SENDER);
    const desk = await person('desk', STATION);
    const before = changeRing.currentSeq();

    const job = await send(asha);
    await print.markJob({ id: job.id, printed: true }, desk.actor, { from: 'master', stationKey: null, holder: null });
    await print.cancelJob(job.id, desk.actor).catch(() => undefined);

    expect(changeRing.currentSeq()).toBe(before);
  });
});
