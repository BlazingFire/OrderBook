/**
 * The Master's read caches (`lib/seq-cache.ts`) must drop when the data a cached read
 * *displays* changes, not only when the cached record itself is written: the Pending and Final
 * lists, the dashboard, categories and chat history. Each test warms the cache, changes
 * something that is not the cached record, and reads again within the TTL — so it passes only
 * because the write invalidated, and fails if invalidation is removed.
 */

import type { Permission } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  createTestProduct,
  resetData,
  stageIdByName,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { resetSeqCache } from '../src/lib/seq-cache.js';
import { resetChangeRing } from '../src/realtime/change-ring.js';
import * as catalog from '../src/services/catalog.service.js';
import * as chat from '../src/services/chat.service.js';
import * as dashboard from '../src/services/dashboard.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import { resetProcessCaches } from '../src/services/process-caches.js';
import * as recycleBin from '../src/services/recycle-bin.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;

const BASIC: Permission[] = ['chat.use', 'chat.createGroups', 'leads.view', 'orders.view', 'parties.view', 'products.view'];

async function person(username: string, permissions: Permission[] = BASIC) {
  const role = await roleService.createRole({ name: `Role ${username}`, tier: 'management', permissions }, admin);
  const { user } = await userService.createUser(
    { username, displayName: username, roleId: role.id, password: 'correct-horse' },
    admin,
  );
  const actor = { ...(await actorWith(permissions)), actorId: user.id, userId: user.id, actorName: username };
  return { id: user.id, role, actor };
}

/** A party with one lead converted to an order and one still-open lead. */
async function seed(name = 'Old Traders') {
  const party = await catalog.createParty({ name }, admin);
  const { product, variant } = await createTestProduct(admin, { name: `Tile ${Math.random().toString(36).slice(2, 7)}` });
  const lead = await leads.createLead(
    { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 5, packaging: 'Box' }] },
    admin,
  );
  const order = await orders.convertLead({ leadId: lead.id }, admin);
  const openLead = await leads.createLead(
    { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 2, packaging: 'Box' }] },
    admin,
  );
  return { party, product, lead: openLead, order };
}

/** The posted line, wherever the room's own system lines sit around it. */
const posted = async (roomId: string, actor: ActorContext, body: string) =>
  (await chat.listMessages({ roomId }, actor)).find((message) => message.body === body)!;

const partyNames = async (list: typeof leads.listLeads | typeof orders.listOrders) =>
  (await (list as typeof leads.listLeads)({}, admin)).items.map((row) => row.partyName);

describe.skipIf(!canRunIntegrationTests)('read caches drop when displayed data changes (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    resetSeqCache();
    admin = await testActor();
  });

  it('a party rename reaches the cached Pending and Final lists', async () => {
    const { party } = await seed('Old Traders');
    expect(await partyNames(leads.listLeads)).toEqual(['Old Traders']);
    expect(await partyNames(orders.listOrders)).toEqual(['Old Traders']);

    const current = await catalog.getParty(party.id, admin);
    await catalog.updateParty(party.id, { ...current, name: 'New Traders' } as never, admin);

    expect(await partyNames(leads.listLeads)).toEqual(['New Traders']);
    expect(await partyNames(orders.listOrders)).toEqual(['New Traders']);
  });

  it('a user rename reaches cached chat history (the author)', async () => {
    const sender = await person('asha');
    await seed();

    const room = await chat.createRoom({ name: 'Desk', memberIds: [] }, sender.actor);
    await chat.postMessage(room.id, { body: 'hello' }, sender.actor);
    expect((await posted(room.id, sender.actor, 'hello')).author?.displayName).toBe('asha');

    await userService.updateUser(
      sender.id,
      { displayName: 'Asha Rao', expectedVersion: (await userService.getUser(sender.id, admin)).sync.version } as never,
      admin,
    );

    expect((await posted(room.id, sender.actor, 'hello')).author?.displayName).toBe('Asha Rao');
  });

  it('a party rename reaches cached chat history (the record chip names the party)', async () => {
    const sender = await person('ravi', [...BASIC, 'chat.shareRecords']);
    const { party, lead } = await seed('Chip Traders');
    const room = await chat.createRoom({ name: 'Desk', memberIds: [] }, sender.actor);
    await chat.postMessage(room.id, { body: 'see', refs: [{ kind: 'lead', id: lead.id }] }, sender.actor);
    expect((await posted(room.id, sender.actor, 'see')).refs[0]).toMatchObject({ partyName: 'Chip Traders' });

    const current = await catalog.getParty(party.id, admin);
    await catalog.updateParty(party.id, { ...current, name: 'Chip Merchants' } as never, admin);

    expect((await posted(room.id, sender.actor, 'see')).refs[0]).toMatchObject({ partyName: 'Chip Merchants' });
  });

  it('a Party Access change drops what a restricted reader sees in cached lists and chat chips', async () => {
    const reader = await person('kiran', [...BASIC, 'chat.shareRecords']);
    const other = await person('mohan');
    const { party, lead } = await seed('Closed Traders');

    // Open party (no grants): the reader sees the lead and the chip is not restricted.
    expect((await leads.listLeads({}, reader.actor)).items).toHaveLength(1);
    const room = await chat.createRoom({ name: 'Desk', memberIds: [] }, reader.actor);
    await chat.postMessage(room.id, { body: 'see', refs: [{ kind: 'lead', id: lead.id }] }, reader.actor);
    expect((await posted(room.id, reader.actor, 'see')).refs[0]).toMatchObject({ restricted: false });
    await dashboard.getDashboardSummary(reader.actor);

    const current = await catalog.getParty(party.id, admin);
    await partyAccess.replaceAssignments(
      party.id,
      { entries: [{ userId: other.id, level: 'manage' }], expectedVersion: current.sync.version },
      admin,
    );

    expect((await leads.listLeads({}, reader.actor)).items).toHaveLength(0);
    expect((await orders.listOrders({}, reader.actor)).items).toHaveLength(0);
    expect((await posted(room.id, reader.actor, 'see')).refs[0]).toMatchObject({ restricted: true });
    expect((await dashboard.getDashboardSummary(reader.actor)).leadCount).toBe(0);
  });

  it('a product or category delete reaches cached categories and the dashboard count', async () => {
    const { product } = await createTestProduct(admin, { name: 'Lonely Tile' });
    const before = await catalog.listCategories(admin);
    expect(before.length).toBeGreaterThan(0);
    expect((await dashboard.getDashboardSummary(admin)).productCount).toBe(1);

    await catalog.deleteProduct(product.id, admin);

    expect((await dashboard.getDashboardSummary(admin)).productCount).toBe(0);
    const after = await catalog.listCategories(admin);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  it('a category rename reaches cached categories', async () => {
    await seed();
    const [row] = await catalog.listCategories(admin);
    const renamed = 'Renamed Category';
    await catalog.updateCategory(row!.id, { name: renamed } as never, admin);

    expect((await catalog.listCategories(admin)).map((category) => category.name)).toContain(renamed);
  });

  it('a Recycle Bin restore brings a deleted party back into the cached dashboard count', async () => {
    const party = await catalog.createParty({ name: 'Lonely Party' }, admin);
    expect((await dashboard.getDashboardSummary(admin)).partyCount).toBe(1);

    await catalog.deleteParty(party.id, admin);
    expect((await dashboard.getDashboardSummary(admin)).partyCount).toBe(0);

    await recycleBin.restoreEntity({ entityType: 'party', id: party.id } as never, admin);
    expect((await dashboard.getDashboardSummary(admin)).partyCount).toBe(1);
  });

  it('a data wipe or restore (no change event) is covered by resetProcessCaches', async () => {
    await seed();
    // The ring restarts at 0 on a reset, so a cache warmed at 0 would keep matching it: the cache
    // has to be emptied by name, not just left to notice the number moved.
    resetChangeRing();
    expect((await dashboard.getDashboardSummary(admin)).partyCount).toBe(1);
    expect((await orders.listOrders({}, admin)).items).toHaveLength(1);

    // What a restore or a developer reset does: replace the data underneath, then reset.
    await db().raw('TRUNCATE parties CASCADE');
    resetProcessCaches();

    expect((await dashboard.getDashboardSummary(admin)).partyCount).toBe(0);
    expect((await orders.listOrders({}, admin)).items).toHaveLength(0);
  });

  it('a stage change moves the cached Pending and Final stage counts, and filters are cached apart', async () => {
    const { lead, order } = await seed('Counted Traders');
    await catalog.createParty({ name: 'Other Party' }, admin);

    const quoted = await stageIdByName('lead', 'Quoted');
    const postpone = await stageIdByName('order', 'Postpone');
    const leadsBefore = await leads.stageCounts({}, admin);
    const ordersBefore = await orders.stageCounts({}, admin);
    expect(leadsBefore.counts[quoted] ?? 0).toBe(0);
    expect(ordersBefore.counts[postpone] ?? 0).toBe(0);
    // A different filter is a different answer, not the cached one.
    expect((await leads.stageCounts({ search: 'no-such-party' }, admin)).total).toBe(0);
    expect(leadsBefore.total).toBe(1);

    await leads.setStage({ id: lead.id, stageId: quoted }, admin);
    await orders.setStage({ id: order.id, stageId: postpone }, admin);

    expect((await leads.stageCounts({}, admin)).counts[quoted]).toBe(1);
    expect((await orders.stageCounts({}, admin)).counts[postpone]).toBe(1);
  });

  it('a party rename that changes what a search matches, and a Party Access change, reach the cached stage counts', async () => {
    const reader = await person('latha');
    const other = await person('naveen');
    const { party } = await seed('Findable Traders');

    expect((await leads.stageCounts({ search: 'Renamed' }, reader.actor)).total).toBe(0);
    expect((await orders.stageCounts({}, reader.actor)).total).toBe(1);

    const current = await catalog.getParty(party.id, admin);
    await catalog.updateParty(party.id, { ...current, name: 'Renamed Traders' } as never, admin);
    expect((await leads.stageCounts({ search: 'Renamed' }, reader.actor)).total).toBe(1);

    const renamed = await catalog.getParty(party.id, admin);
    await partyAccess.replaceAssignments(
      party.id,
      { entries: [{ userId: other.id, level: 'manage' }], expectedVersion: renamed.sync.version },
      admin,
    );
    expect((await leads.stageCounts({ search: 'Renamed' }, reader.actor)).total).toBe(0);
    expect((await orders.stageCounts({}, reader.actor)).total).toBe(0);
  });
});
