/**
 * Stock and inventory were removed in 1.4 (requirement R15). The tables stay
 * (a migration only adds), but nothing writes them, and an Office or a stored
 * row from before the removal must not break the Master. Each case here is one
 * way an older build or an older database still reaches the removed feature.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Mutation } from '@orderbook/shared';
import { formatTemporaryId, initialHlcState, tickHlc } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
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
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as roleRepo from '../src/repositories/role.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as catalog from '../src/services/catalog.service.js';
import { companyFeatures } from '../src/services/company-features.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as reportService from '../src/services/report.service.js';
import * as roleService from '../src/services/role.service.js';
import * as settingsService from '../src/services/settings.service.js';
import * as snapshotService from '../src/services/snapshot.service.js';
import * as sync from '../src/services/sync.service.js';
import * as userService from '../src/services/user.service.js';

const PANEL = 'S7K2QX';

let actor: ActorContext;
let server: HttpServer;
let hub: RealtimeHub;
let socket: Socket | undefined;

interface Ack {
  ok: boolean;
  messageKey?: string;
  error?: string;
}

function ask(event: string, payload: unknown): Promise<Ack> {
  return new Promise((resolve) => (socket as Socket).emit(event, payload, resolve));
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
    name: 'Stock panel',
    device_code: 'STOCK001',
    secret_hash: await bcrypt.hash('panel-secret', 4),
    lan_ip: '192.168.1.21',
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

/** A lead of two lines, converted and dispatched, in a database that never held stock. */
async function dispatchedOrderOfTwoLines() {
  const party = await catalog.createParty({ name: 'No Stock Traders', city: 'Morbi' }, actor);
  const one = await createTestProduct(actor, { name: 'Retired Basin', code: 'RET-1' });
  const two = await createTestProduct(actor, { name: 'Retired Pan', code: 'RET-2' });
  const lead = await leads.createLead(
    {
      partyId: party.id,
      items: [
        { productId: one.product.id, variantId: one.variant.id, quantity: 5, packaging: 'Box' },
        { productId: two.product.id, variantId: two.variant.id, quantity: 7, packaging: 'Box' },
      ],
    },
    actor,
  );
  const order = await orders.convertLead({ leadId: lead.id }, actor);
  const dispatched = await orders.dispatchOrder({ orderId: order.id }, actor);
  return { order, dispatched, one, two };
}

function mutation(overrides: Partial<Mutation> & Pick<Mutation, 'kind' | 'entity'>): Mutation {
  return {
    mutationId: `m-${Math.random().toString(36).slice(2)}`,
    entityId: formatTemporaryId(PANEL, 1),
    hlc: tickHlc(initialHlcState(PANEL), Date.now() + 1_000).hlc,
    deviceCode: PANEL,
    payload: {},
    fields: [],
    baseFieldHlc: {},
    actorUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.skipIf(!canRunIntegrationTests)('stock is retired (integration)', () => {
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

  it('converts and dispatches with no stock rows anywhere, and writes none', async () => {
    const { order, dispatched } = await dispatchedOrderOfTwoLines();

    expect(dispatched.dispatchedAt).toBeTruthy();
    for (const table of ['inventory_stock', 'stock_movements', 'stock_reservations']) {
      const rows = await db()(table).where({ tenant_id: actor.tenantId });
      expect(rows, table).toHaveLength(0);
    }

    const fresh = await orders.getOrder(order.id, actor);
    const system = fresh.timeline.filter((entry) => entry.kind === 'system');
    expect(system[system.length - 1]?.message).toBe('Dispatched');
  });

  it('reports the dispatched order\'s line quantities as the Dispatches boxes', async () => {
    await dispatchedOrderOfTwoLines();

    const report = await reportService.dispatchReport({ period: 'thisMonth' }, actor);

    expect(report.months.reduce((sum, month) => sum + month.pieces, 0)).toBe(12);
    const buckets = new Map(report.colours.map((bucket) => [bucket.colour, bucket.pieces]));
    expect([...buckets.values()].reduce((sum, count) => sum + count, 0)).toBe(12);
  });

  it('answers an older Office\'s stock commands with a refusal, not silence', async () => {
    await signInPanel();

    const listed = await ask('stock:list', {});
    const adjusted = await ask('stock:adjust', { variantId: 'x', quantityBoxes: 1 });

    expect(listed).toMatchObject({ ok: false, messageKey: 'validation.stock.retired' });
    expect(adjusted).toMatchObject({ ok: false, messageKey: 'validation.stock.retired' });
  });

  it('loads a role that still stores the removed permissions, and grants neither', async () => {
    const role = await roleService.createRole(
      { name: 'Old Desk', tier: 'office', permissions: ['leads.view'] },
      actor,
    );
    await db()('roles')
      .where({ tenant_id: actor.tenantId, id: role.id })
      .update({ permissions: JSON.stringify(['leads.view', 'inventory.view', 'stock.adjust']) });
    roleRepo.invalidateRoleCache();

    const set = await roleRepo.permissionSetForRole(actor.tenantId, role.id);

    expect(set?.permissions).toContain('leads.view');
    expect(set?.permissions).not.toContain('inventory.view');
    expect(set?.permissions).not.toContain('stock.adjust');
  });

  it('ignores a stored inventory.freeToSell row and never lists the key', async () => {
    const tenantId = await testTenantId();
    await db()('settings').insert({
      tenant_id: tenantId,
      key: 'inventory.freeToSell',
      value: JSON.stringify(true),
      is_secret: false,
      key_version: 1,
      updated_at: new Date(),
    });
    settingsService.invalidateSettingsCache();

    const views = await settingsService.readSettings(actor);
    const features = await companyFeatures(tenantId);

    expect(views.map((view) => view.key)).not.toContain('inventory.freeToSell');
    expect(features).not.toHaveProperty('freeToSell');
    expect(features.followUpDefaultDays).toBeDefined();
  });

  it('still sends stock as an empty array so an older Office does not crash', async () => {
    const snapshot = await snapshotService.buildSnapshot(actor);

    expect(snapshot.stock).toEqual([]);
    expect((snapshot.dashboard as unknown as Record<string, unknown>).lowStockCount).toBeUndefined();
  });

  it('refuses a queued stock.inbound one by one and still applies the lead beside it', async () => {
    const party = await catalog.createParty({ name: 'Queued Traders' }, actor);
    const { product, variant } = await createTestProduct(actor, { name: 'Queued Basin', code: 'Q-1' });
    const panelActor = await testActor({ deviceCode: PANEL, actorType: 'office_panel' });
    // A person's work: the panel must not stall the batch over a kind it no longer knows.
    const person = 'US0000000001';

    const stockPush = mutation({
      kind: 'stock.inbound' as Mutation['kind'],
      entity: 'stock' as Mutation['entity'],
      entityId: variant.id,
      actorUserId: person,
      payload: { variantId: variant.id, quantityBoxes: 10 },
    });
    const leadPush = mutation({
      kind: 'lead.create',
      entity: 'lead',
      entityId: formatTemporaryId(PANEL, 2),
      actorUserId: person,
      payload: {
        partyId: party.id,
        items: [{ productId: product.id, variantId: variant.id, quantity: 3, packaging: 'carton' }],
      },
    });
    const response = await sync.applyPush({ mutations: [stockPush, leadPush] }, panelActor);
    const stock = response.results.find((r) => r.mutationId === stockPush.mutationId);
    const lead = response.results.find((r) => r.mutationId === leadPush.mutationId);
    expect(stock?.status).toBe('rejected');
    expect(stock?.error).toMatch(/Unknown mutation/);
    expect(lead?.status).toBe('applied');
    expect(await db()('leads').where({ tenant_id: actor.tenantId }).count({ n: '*' }).first()).toMatchObject({
      n: '1',
    });
  });
});
