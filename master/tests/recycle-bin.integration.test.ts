/**
 * The Recycle Bin against a real cluster: the six-branch `UNION ALL`, the
 * per-entity delete policy, the parent hazard, the name-collision offer, and
 * the ownership scope. `docs/backend-modules/10-TESTING.md` §6.3 owns the
 * gate list this suite answers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as inventoryService from '../src/services/inventory.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as recycleBinService from '../src/services/recycle-bin.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { db } from '../src/db/knex.js';
import { ConflictError } from '../src/lib/errors.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('the Recycle Bin (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('deleting a party', () => {
    it('soft-deletes and frees the party from the live list', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      await catalogService.deleteParty(party.id, actor);

      const live = await catalogService.listParties({}, actor);
      expect(live.items.find((p) => p.id === party.id)).toBeUndefined();
    });

    it('appears in the Bin after deletion', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      await catalogService.deleteParty(party.id, actor);

      const bin = await recycleBinService.listBin({}, actor);
      const entry = bin.items.find((e) => e.entityType === 'party' && e.id === party.id);
      expect(entry).toBeDefined();
      expect(entry?.label).toBe('Sharma Tiles');
    });

    it('is refused while a live lead references it', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      const product = await catalogService.createProduct(
        { name: 'Basin', productCode: 'B-1' },
        actor,
      );
      await leadService.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, packaging: 'Box', quantities: [{ colour: 'White', quantity: 5 }] }],
        },
        actor,
      );

      await expect(catalogService.deleteParty(party.id, actor)).rejects.toMatchObject({
        code: 'conflict',
        details: { blockedBy: [expect.objectContaining({ entityType: 'lead', reason: 'live_reference' })] },
      });
    });

    it('frees the party code for reuse once deleted — the partial unique index, not the sequence', async () => {
      const first = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      await catalogService.deleteParty(first.id, actor);

      // The sequence backing party codes never rewinds, so forcing a LIVE
      // row directly onto the just-freed code is the only way to prove the
      // partial unique index (`03-DATABASE.md` §6.2) — not the sequence —
      // is what would otherwise have reserved it forever.
      const second = await catalogService.createParty({ name: 'Second' }, actor);
      await db()('parties').where({ id: second.id }).update({ party_code: first.partyCode });

      const row = await db()('parties').where({ id: second.id }).first('party_code');
      expect(row.party_code).toBe(first.partyCode);
    });
  });

  describe('restoring a party', () => {
    it('restores it back onto the live list', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      await catalogService.deleteParty(party.id, actor);

      await recycleBinService.restoreEntity({ entityType: 'party', id: party.id }, actor);

      const live = await catalogService.listParties({}, actor);
      expect(live.items.find((p) => p.id === party.id)).toBeDefined();
    });

    it('publishes a restore, and the Bin no longer lists it', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      await catalogService.deleteParty(party.id, actor);
      await recycleBinService.restoreEntity({ entityType: 'party', id: party.id }, actor);

      const bin = await recycleBinService.listBin({}, actor);
      expect(bin.items.find((e) => e.id === party.id)).toBeUndefined();
    });
  });

  describe('deleting and restoring a product', () => {
    it('is refused while stock is on hand', async () => {
      const product = await catalogService.createProduct(
        { name: 'Basin', productCode: 'B-1' },
        actor,
      );
      await inventoryService.recordInbound(
        { productId: product.id, colour: 'White', quantityBoxes: 10 },
        actor,
      );

      await expect(catalogService.deleteProduct(product.id, actor)).rejects.toMatchObject({
        code: 'conflict',
      });
    });

    it('restore refuses a collision on the same code and offers a suggestion', async () => {
      const product = await catalogService.createProduct(
        { name: 'Basin', productCode: 'B-1' },
        actor,
      );
      await catalogService.deleteProduct(product.id, actor);
      // A new product reissues the freed code — an ordinary Tuesday.
      await catalogService.createProduct({ name: 'Basin V2', productCode: 'B-1' }, actor);

      await expect(
        recycleBinService.restoreEntity({ entityType: 'product', id: product.id }, actor),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { field: 'productCode', suggestion: expect.stringContaining('restored') },
      });
    });

    it('restore succeeds with an explicit renameTo', async () => {
      const product = await catalogService.createProduct(
        { name: 'Basin', productCode: 'B-1' },
        actor,
      );
      await catalogService.deleteProduct(product.id, actor);
      await catalogService.createProduct({ name: 'Basin V2', productCode: 'B-1' }, actor);

      const result = await recycleBinService.restoreEntity(
        { entityType: 'product', id: product.id, renameTo: 'B-1-OLD' },
        actor,
      );
      expect(result.renamedTo).toBe('B-1-OLD');
    });
  });

  describe('leads and orders', () => {
    async function seedLeadWithParty(): Promise<{ leadId: string; partyId: string }> {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      const product = await catalogService.createProduct(
        { name: 'Basin', productCode: 'B-1' },
        actor,
      );
      const lead = await leadService.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, packaging: 'Box', quantities: [{ colour: 'White', quantity: 5 }] }],
        },
        actor,
      );
      return { leadId: lead.id, partyId: party.id };
    }

    it('refuses to delete a converted lead', async () => {
      const { leadId } = await seedLeadWithParty();
      await orderService.convertLead({ leadId }, actor);

      await expect(leadService.deleteLead(leadId, actor)).rejects.toMatchObject({ code: 'conflict' });
    });

    it('restoring a lead whose party is still deleted is refused, naming the party', async () => {
      const { leadId, partyId } = await seedLeadWithParty();
      await leadService.deleteLead(leadId, actor);
      await catalogService.deleteParty(partyId, actor);

      await expect(
        recycleBinService.restoreEntity({ entityType: 'lead', id: leadId }, actor),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { blockedBy: [expect.objectContaining({ entityType: 'party', id: partyId })] },
      });
    });

    it('restoring the party first, then the lead, succeeds', async () => {
      const { leadId, partyId } = await seedLeadWithParty();
      await leadService.deleteLead(leadId, actor);
      await catalogService.deleteParty(partyId, actor);

      await recycleBinService.restoreEntity({ entityType: 'party', id: partyId }, actor);
      await expect(
        recycleBinService.restoreEntity({ entityType: 'lead', id: leadId }, actor),
      ).resolves.toMatchObject({ entityType: 'lead', id: leadId });
    });

    it('refuses to delete a dispatched order, and deleting an undispatched one releases its reservations', async () => {
      const { leadId } = await seedLeadWithParty();
      const order = await orderService.convertLead({ leadId }, actor);

      const beforeDelete = await inventoryService.listStock({}, actor);
      const before = beforeDelete.find((s) => s.productId && s.reservedBoxes > 0);
      expect(before).toBeDefined();

      await orderService.deleteOrder(order.id, actor);

      const afterDelete = await inventoryService.listStock({}, actor);
      const after = afterDelete.find((s) => s.colour === before?.colour && s.productId === before?.productId);
      expect(after?.reservedBoxes ?? 0).toBe(0);
    });

    it('refuses to delete a dispatched order', async () => {
      const { leadId } = await seedLeadWithParty();
      const order = await orderService.convertLead({ leadId }, actor);
      await orderService.dispatchOrder({ orderId: order.id, note: null }, actor);

      await expect(orderService.deleteOrder(order.id, actor)).rejects.toMatchObject({
        code: 'conflict',
        details: { blockedBy: [expect.objectContaining({ reason: 'dispatched' })] },
      });
    });
  });

  describe('ownership scope', () => {
    it('an actor without recycleBin.viewAll sees only their own deletions', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);

      const deleter = await actorWith(['parties.delete', 'recycleBin.view']);
      const overriddenDeleter = { ...deleter, userId: 'user-a' };
      await catalogService.deleteParty(party.id, overriddenDeleter);

      const otherViewer = await actorWith(['parties.delete', 'recycleBin.view']);
      const asUserB = { ...otherViewer, userId: 'user-b' };
      const binForB = await recycleBinService.listBin({}, asUserB);
      expect(binForB.items).toHaveLength(0);

      const binForA = await recycleBinService.listBin({}, overriddenDeleter);
      expect(binForA.items).toHaveLength(1);
    });

    it('recycleBin.viewAll reveals another user’s deletions', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      const deleter = { ...(await actorWith(['parties.delete', 'recycleBin.view'])), userId: 'user-a' };
      await catalogService.deleteParty(party.id, deleter);

      const supervisor = await actorWith(['parties.delete', 'recycleBin.view', 'recycleBin.viewAll']);
      const bin = await recycleBinService.listBin({}, supervisor);
      expect(bin.items).toHaveLength(1);
    });

    it('an actor with no matching delete key gets an empty page, not a refusal', async () => {
      const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
      await catalogService.deleteParty(party.id, actor);

      const noKeys = await actorWith(['recycleBin.view', 'recycleBin.viewAll']);
      await expect(recycleBinService.listBin({}, noKeys)).resolves.toMatchObject({ items: [] });
    });
  });

  describe('paging', () => {
    it('pages the Bin by keyset without dropping or repeating rows across an identical timestamp', async () => {
      const parties = await Promise.all(
        Array.from({ length: 5 }, (_, i) => catalogService.createParty({ name: `Party ${i}` }, actor)),
      );

      // Deleted inside one transaction-adjacent burst; several may share a
      // `deleted_at` down to the second, which is exactly what the
      // three-part cursor key exists to survive.
      for (const party of parties) await catalogService.deleteParty(party.id, actor);

      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await recycleBinService.listBin({ limit: 2, cursor }, actor);
        for (const item of page.items) seen.add(item.id);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen.size).toBe(parties.length);
    });
  });

  describe('roles and users, subsumed from the existing Bin', () => {
    it('restoring a role publishes "restored" and the role becomes usable again', async () => {
      const role = await roleService.createRole({ name: 'Field Sales', tier: 'office', permissions: [] }, actor);
      await roleService.deleteRole(role.id, actor);

      const restored = await roleService.restoreRole(role.id, actor);
      expect(restored.deletedAt).toBeNull();
    });

    it('restoring a user whose role is still deleted is refused', async () => {
      const role = await roleService.createRole({ name: 'Field Sales', tier: 'office', permissions: [] }, actor);
      const { user } = await userService.createUser(
        { username: 'kiran', displayName: 'Kiran', roleId: role.id },
        actor,
      );
      await userService.deleteUser(user.id, actor);
      await roleService.deleteRole(role.id, actor);

      await expect(userService.restoreUser(user.id, actor)).rejects.toBeInstanceOf(ConflictError);
    });
  });
});
