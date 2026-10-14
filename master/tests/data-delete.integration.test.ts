/**
 * The Master's Delete data screen against a real cluster
 * (`shared/src/domain/data-reset.ts`): Start fresh erases every order and
 * party and keeps products and users; Delete related data takes a party's
 * orders to the Recycle Bin with it, only when switched on and asked for.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  createServerMasterUser,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as dataResetService from '../src/services/data-reset.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as recycleBinService from '../src/services/recycle-bin.service.js';
import * as settingsService from '../src/services/settings.service.js';

let actor: ActorContext;

async function seedPartyWithOrders(name: string, productCode: string) {
  const party = await catalogService.createParty({ name }, actor);
  const product = await catalogService.createProduct(
    { name: `Basin ${productCode}`, categoryName: 'Basins', variants: [{ code: productCode }] },
    actor,
  );
  const line = { productId: product.id, variantId: product.variants[0]!.id, quantity: 5, packaging: 'Box' };
  const pending = await leadService.createLead({ partyId: party.id, items: [line] }, actor);
  const converted = await leadService.createLead({ partyId: party.id, items: [line] }, actor);
  const order = await orderService.convertLead({ leadId: converted.id }, actor);
  return { party, product, pendingId: pending.id, convertedLeadId: converted.id, orderId: order.id };
}

describe.skipIf(!canRunIntegrationTests)('Delete data (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('Start fresh', () => {
    it('deletes every order and party and keeps products and users', async () => {
      const userId = await createServerMasterUser('wiper', 'wiper-pass-1');
      const admin = await testActor({ userId, actorId: userId });
      await seedPartyWithOrders('Sharma Tiles', 'B-1');
      await seedPartyWithOrders('Gupta Sanitary', 'B-2');
      const binned = await catalogService.createParty({ name: 'Binned Party' }, actor);
      await catalogService.deleteParty(binned.id, actor);

      const before = await dataResetService.freshStartSummary(admin);
      expect(before).toMatchObject({ pendingOrders: 2, finalOrders: 2, parties: 3, products: 2 });

      const result = await dataResetService.freshStart(
        { confirmPassword: 'wiper-pass-1', confirmText: 'DELETE' },
        admin,
      );
      expect(result.removed).toEqual({ pendingOrders: 2, finalOrders: 2, parties: 3 });

      for (const table of ['leads', 'orders', 'parties', 'line_items', 'timeline_entries']) {
        const [row] = await db()(table).count<Array<{ count: string }>>('* as count');
        expect(Number(row?.count), table).toBe(0);
      }
      const after = await dataResetService.freshStartSummary(admin);
      expect(after).toMatchObject({ pendingOrders: 0, finalOrders: 0, parties: 0, products: 2 });
      expect(after.users).toBe(before.users);

      const trail = await db()('activity_log').where({ entity_type: 'party_list', action: 'erased' });
      expect(trail).toHaveLength(1);

      // The company carries on: a new party and order work as before.
      const fresh = await seedPartyWithOrders('New Start', 'B-3');
      expect(fresh.orderId).toBeTruthy();
    });

    it('refuses a wrong password or a wrong word, and deletes nothing', async () => {
      const userId = await createServerMasterUser('wiper', 'wiper-pass-1');
      const admin = await testActor({ userId, actorId: userId });
      await catalogService.createParty({ name: 'Sharma Tiles' }, actor);

      await expect(
        dataResetService.freshStart({ confirmPassword: 'nope', confirmText: 'DELETE' }, admin),
      ).rejects.toMatchObject({ messageKey: 'validation.dataReset.passwordIncorrect' });
      await expect(
        dataResetService.freshStart({ confirmPassword: 'wiper-pass-1', confirmText: 'delete' }, admin),
      ).rejects.toMatchObject({ messageKey: 'validation.dataReset.confirmText' });

      const [row] = await db()('parties').count<Array<{ count: string }>>('* as count');
      expect(Number(row?.count)).toBe(1);
    });

    it('is refused below the admin tier', async () => {
      const office = await actorWith(['settings.manage']);
      await expect(dataResetService.freshStartSummary(office)).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('chat and print room', () => {
    async function seedChatAndPrint(userId: string, tenantId: string) {
      const [room] = await db()('chat_rooms')
        .insert({ tenant_id: tenantId, kind: 'group', name: 'Floor', last_seq: 2, created_by: userId })
        .returning<Array<{ id: string }>>('id');
      await db()('chat_members').insert({ room_id: room!.id, tenant_id: tenantId, user_id: userId, last_read_seq: 0 });
      await db()('chat_messages').insert([
        { id: 'CM0000000001', tenant_id: tenantId, room_id: room!.id, seq: 1, author_id: userId, kind: 'text', body: 'one' },
        { id: 'CM0000000002', tenant_id: tenantId, room_id: room!.id, seq: 2, author_id: userId, kind: 'text', body: 'two' },
      ]);
      const job = (n: number, status: string) => ({
        tenant_id: tenantId,
        request_id: n.toString(16).padStart(32, '0'),
        kind: 'filling',
        source_type: 'lead',
        source_id: `LD${n}`,
        party_name: 'Sharma Tiles',
        copies: 1,
        status,
        sender_id: userId,
      });
      await db()('print_jobs').insert([job(1, 'printed'), job(2, 'cancelled'), job(3, 'queued')]);
      return room!.id;
    }

    it('deletes every chat message, keeps the room and its member, and marks it read', async () => {
      const userId = await createServerMasterUser('wiper', 'wiper-pass-1');
      const admin = await testActor({ userId, actorId: userId });
      const roomId = await seedChatAndPrint(userId, admin.tenantId);

      expect((await dataResetService.freshStartSummary(admin)).chatMessages).toBe(2);
      const result = await dataResetService.clearChat({ confirmPassword: 'wiper-pass-1', confirmText: 'DELETE' }, admin);
      expect(result.removed.messages).toBe(2);

      expect(await db()('chat_messages').count({ count: '*' })).toEqual([{ count: '0' }]);
      expect(await db()('chat_rooms').where({ id: roomId }).first('last_seq')).toMatchObject({ last_seq: '2' });
      expect(await db()('chat_members').where({ room_id: roomId }).first('last_read_seq')).toMatchObject({
        last_read_seq: '2',
      });
      // The print room is untouched.
      expect(await db()('print_jobs').count({ count: '*' })).toEqual([{ count: '3' }]);
    });

    it('clears printed and cancelled jobs and keeps the waiting one', async () => {
      const userId = await createServerMasterUser('wiper', 'wiper-pass-1');
      const admin = await testActor({ userId, actorId: userId });
      await seedChatAndPrint(userId, admin.tenantId);

      const before = await dataResetService.freshStartSummary(admin);
      expect(before).toMatchObject({ printHistory: 2, printWaiting: 1 });

      await expect(
        dataResetService.clearPrintHistory({ confirmPassword: 'wrong', confirmText: 'DELETE' }, admin),
      ).rejects.toMatchObject({ messageKey: 'validation.dataReset.passwordIncorrect' });

      const result = await dataResetService.clearPrintHistory(
        { confirmPassword: 'wiper-pass-1', confirmText: 'DELETE' },
        admin,
      );
      expect(result.removed.jobs).toBe(2);
      expect(await db()('print_jobs').pluck('status')).toEqual(['queued']);
      // The chat is untouched.
      expect(await db()('chat_messages').count({ count: '*' })).toEqual([{ count: '2' }]);
    });
  });

  describe('Delete related data', () => {
    it('previews the orders a party delete would take', async () => {
      const seeded = await seedPartyWithOrders('Sharma Tiles', 'B-1');
      const preview = await catalogService.partyDeletePreview(seeded.party.id, actor);

      expect(preview.relatedDeleteEnabled).toBe(false);
      expect(preview.pendingOrders.map((row) => row.id)).toEqual([seeded.pendingId]);
      expect(preview.finalOrders.map((row) => row.id)).toEqual([seeded.orderId]);
    });

    it('still refuses while the switch is off, even when asked', async () => {
      const seeded = await seedPartyWithOrders('Sharma Tiles', 'B-1');
      await expect(
        catalogService.deleteParty(seeded.party.id, actor, { withRelated: true, expectedRelated: 2 }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('bins the party with its orders when on, and they restore party → lead → order', async () => {
      const seeded = await seedPartyWithOrders('Sharma Tiles', 'B-1');
      await settingsService.writeSetting(actor, 'parties.deleteRelatedData', true);

      // Not asked for: the plain delete is still refused.
      await expect(catalogService.deleteParty(seeded.party.id, actor)).rejects.toMatchObject({
        code: 'conflict',
      });
      // A count that no longer matches the dialog is refused.
      await expect(
        catalogService.deleteParty(seeded.party.id, actor, { withRelated: true, expectedRelated: 1 }),
      ).rejects.toMatchObject({ messageKey: 'error.conflict.partyDeleteStale' });

      const result = await catalogService.deleteParty(seeded.party.id, actor, {
        withRelated: true,
        expectedRelated: 2,
      });
      expect(result).toMatchObject({ removedLeads: 2, removedOrders: 1 });

      const liveLeads = await db()('leads').whereNull('deleted_at').count<Array<{ count: string }>>('* as count');
      const liveOrders = await db()('orders').whereNull('deleted_at').count<Array<{ count: string }>>('* as count');
      expect(Number(liveLeads[0]?.count)).toBe(0);
      expect(Number(liveOrders[0]?.count)).toBe(0);

      await recycleBinService.restoreEntity({ entityType: 'party', id: seeded.party.id }, actor);
      await recycleBinService.restoreEntity({ entityType: 'lead', id: seeded.pendingId }, actor);
      await recycleBinService.restoreEntity({ entityType: 'lead', id: seeded.convertedLeadId }, actor);
      await recycleBinService.restoreEntity({ entityType: 'order', id: seeded.orderId }, actor);

      const order = await orderService.getOrder(seeded.orderId, actor);
      expect(order.id).toBe(seeded.orderId);
    });

    it('deletes a party with no orders the same way whichever way the switch points', async () => {
      await settingsService.writeSetting(actor, 'parties.deleteRelatedData', true);
      const party = await catalogService.createParty({ name: 'Empty Party' }, actor);
      const result = await catalogService.deleteParty(party.id, actor, { withRelated: true, expectedRelated: 0 });
      expect(result.id).toBe(party.id);
    });
  });
});
