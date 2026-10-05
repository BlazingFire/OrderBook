/**
 * The duplicate-products menu against PostgreSQL: the groups it finds, the
 * soft delete it makes, the refusals, and that a delete reaches the change
 * stream every Office replays (`change-ring`, folded by `apply-change`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyChangeToSnapshot, type DataChangedEvent, type SyncSnapshot } from '@orderbook/shared';

import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as changeRing from '../src/realtime/change-ring.js';
import * as catalog from '../src/services/catalog.service.js';
import * as duplicates from '../src/services/duplicate-products.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as recycleBin from '../src/services/recycle-bin.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

const category = (name: string, code: string) => catalog.createCategory({ name, code }, actor);
const subProduct = (name: string, categoryId: string, code: string) =>
  catalog.createProduct({ name, categoryId, hasVariants: false, variants: [{ code }] }, actor);

describe.skipIf(!canRunIntegrationTests)('duplicate products (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('DUP-1: finds Products written twice and sub products written twice, nothing else', async () => {
    const basin = await category('Wash Basin', 'WB');
    const basinAgain = await category('Wash-basin', 'WB2');
    const other = await category('Pedestal', 'PED');
    await subProduct('102', basin.id, 'WB-0001');
    await subProduct('102.', basin.id, 'WB-0002');
    await subProduct('102', other.id, 'PED-0001'); // same name, another Product: fine
    await subProduct('201', other.id, 'PED-0002');

    const { groups } = await duplicates.findDuplicates(actor);

    const products = groups.filter((group) => group.level === 'product');
    expect(products).toHaveLength(1);
    expect(products[0]?.members.map((member) => member.id).sort()).toEqual(
      [basin.id, basinAgain.id].sort(),
    );
    expect(products[0]?.matchedOn).toEqual(['name']);
    const subs = groups.filter((group) => group.level === 'subProduct');
    expect(subs).toHaveLength(1);
    expect(subs[0]?.members.map((member) => member.name).sort()).toEqual(['102', '102.']);
  });

  it('DUP-2: deletes the other copy into the Recycle Bin and announces it to every Office', async () => {
    const basin = await category('Wash Basin', 'WB');
    const keep = await subProduct('102', basin.id, 'WB-0001');
    const extra = await subProduct('102.', basin.id, 'WB-0002');
    const seq = changeRing.currentSeq();

    const result = await duplicates.resolveDuplicates(
      { level: 'subProduct', keepId: keep.id, deleteIds: [extra.id] },
      actor,
    );

    expect(result).toEqual({ deleted: [extra.id], refused: [] });
    expect((await duplicates.findDuplicates(actor)).groups).toEqual([]);
    expect((await catalog.listProducts({}, actor)).items.map((item) => item.id)).toEqual([keep.id]);
    const bin = await recycleBin.listBin({}, actor);
    expect(bin.items.some((entry) => entry.entityType === 'product' && entry.id === extra.id)).toBe(true);

    // What an Office reconnecting at `seq` is replayed, folded into its snapshot.
    const replay = changeRing.since(seq) as DataChangedEvent[];
    const deleted = replay.filter((event) => event.entity === 'product' && event.action === 'deleted');
    expect(deleted.map((event) => event.id)).toEqual([extra.id]);
    const snapshot = {
      products: [keep, extra],
      categories: [],
      leads: [],
      orders: [],
      parties: [],
    } as unknown as SyncSnapshot;
    for (const event of deleted) expect(applyChangeToSnapshot(snapshot, event)).toBe('applied');
    expect(snapshot.products.map((item) => item.id)).toEqual([keep.id]);
  });

  it('DUP-3: refuses a copy a live pending order quotes, deletes the rest', async () => {
    const basin = await category('Wash Basin', 'WB');
    const keep = await subProduct('102', basin.id, 'WB-0001');
    const used = await subProduct('102.', basin.id, 'WB-0002');
    const free = await subProduct('102-', basin.id, 'WB-0003');
    const party = await catalog.createParty({ name: 'Sharma Tiles' }, actor);
    await leadService.createLead(
      {
        partyId: party.id,
        items: [{ productId: used.id, variantId: used.variants[0]!.id, quantity: 5, packaging: 'Box' }],
      },
      actor,
    );

    const { groups } = await duplicates.findDuplicates(actor);
    expect(groups[0]?.members.find((member) => member.id === used.id)).toMatchObject({
      blockedBy: 'liveReferences',
      lineCount: 1,
    });

    const result = await duplicates.resolveDuplicates(
      { level: 'subProduct', keepId: keep.id, deleteIds: [used.id, free.id] },
      actor,
    );

    expect(result.deleted).toEqual([free.id]);
    expect(result.refused).toEqual([{ id: used.id, blockedBy: 'liveReferences' }]);
    expect(await db()('products').whereNull('deleted_at').count('* as n').first()).toMatchObject({
      n: '2',
    });
  });

  it('DUP-4: a Product that still holds sub products is refused, an empty one goes', async () => {
    const full = await category('Wash Basin', 'WB');
    const empty = await category('wash basin.', 'WB2');
    await subProduct('102', full.id, 'WB-0001');

    const result = await duplicates.resolveDuplicates(
      { level: 'product', keepId: empty.id, deleteIds: [full.id] },
      actor,
    );
    expect(result).toEqual({ deleted: [], refused: [{ id: full.id, blockedBy: 'subProducts' }] });

    const back = await duplicates.resolveDuplicates(
      { level: 'product', keepId: full.id, deleteIds: [empty.id] },
      actor,
    );
    expect(back.deleted).toEqual([empty.id]);
    const events = changeRing.since(0) as DataChangedEvent[];
    expect(
      events.some((e) => e.entity === 'product_category' && e.action === 'deleted' && e.id === empty.id),
    ).toBe(true);
  });

  it('DUP-5: will not delete a row that is not a duplicate of the kept one, or keep and delete the same', async () => {
    const basin = await category('Wash Basin', 'WB');
    const basinAgain = await category('Wash Basin.', 'WB2');
    const unrelated = await category('Pedestal', 'PED');

    for (const input of [
      { level: 'product' as const, keepId: basin.id, deleteIds: [unrelated.id] },
      { level: 'product' as const, keepId: basin.id, deleteIds: [basin.id] },
      { level: 'product' as const, keepId: unrelated.id, deleteIds: [basinAgain.id] },
      { level: 'product' as const, keepId: basin.id, deleteIds: [] },
    ]) {
      await expect(duplicates.resolveDuplicates(input, actor)).rejects.toMatchObject({
        messageKey: 'validation.duplicates.selection',
      });
    }
    expect(await db()('product_categories').whereNull('deleted_at').count('* as n').first()).toMatchObject({
      n: '3',
    });
  });

  it('DUP-6: needs products.delete to look or to delete', async () => {
    const viewer = await actorWith(['products.view']);
    await expect(duplicates.findDuplicates(viewer)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      duplicates.resolveDuplicates({ level: 'product', keepId: 'a', deleteIds: ['b'] }, viewer),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
