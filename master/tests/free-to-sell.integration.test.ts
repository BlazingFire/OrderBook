/**
 * The company's free-to-sell switch, end to end.
 *
 * Off, every stock figure the Master hands out reads the floor count as free
 * and nothing as reserved, low stock is judged on the floor count, and the
 * snapshot says so. The reservations still exist underneath: switching back
 * on shows them again without anything having moved. The fixture seeds the
 * switch **on** for every other suite; this is the one that turns it off.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as inventory from '../src/services/inventory.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as settings from '../src/services/settings.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

async function levelFor(variantId: string) {
  const levels = await inventory.listStock({ limit: 100 }, actor);
  return levels.find((level) => level.variantId === variantId);
}

/** 40 on the floor, 15 reserved by a converted lead, reorder level 30. */
async function seedReserved() {
  const party = await catalog.createParty({ name: 'Shah Ceramics' }, actor);
  const product = await catalog.createProduct(
    {
      name: 'Pedestal Basin',
      categoryName: 'Basins',
      variants: [{ code: 'BSN-01', weightKg: 12 }],
    },
    actor,
  );
  const variant = product.variants[0]!;
  await inventory.recordInbound({ variantId: variant.id, quantityBoxes: 40 }, actor);
  await inventory.setReorderLevel({ variantId: variant.id, reorderLevel: 30 }, actor);
  const lead = await leads.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, variantId: variant.id, quantity: 15, packaging: 'carton' }],
    },
    actor,
  );
  await orders.convertLead({ leadId: lead.id }, actor);
  return { product, variant };
}

describe.skipIf(!canRunIntegrationTests)('the free-to-sell switch (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('reports the floor count as free, nothing reserved, and low stock on the floor count while off', async () => {
    const { product, variant } = await seedReserved();

    const on = await levelFor(variant.id);
    expect(on).toMatchObject({ quantityBoxes: 40, reservedBoxes: 15, availableBoxes: 25, isLow: true });

    await settings.writeSetting(actor, 'inventory.freeToSell', false);

    const off = await levelFor(variant.id);
    expect(off).toMatchObject({ quantityBoxes: 40, reservedBoxes: 0, availableBoxes: 40, isLow: false });
    expect(await inventory.countLowStock(actor.tenantId)).toBe(0);

    const snapshot = await buildSnapshot(actor);
    expect(snapshot.features).toEqual({ freeToSell: false });
    expect(snapshot.stock.find((level) => level.productId === product.id)?.reservedBoxes).toBe(0);
  });

  it('shows the reservation again the moment the switch is back on', async () => {
    const { variant } = await seedReserved();
    await settings.writeSetting(actor, 'inventory.freeToSell', false);
    await settings.writeSetting(actor, 'inventory.freeToSell', true);

    expect(await levelFor(variant.id)).toMatchObject({ reservedBoxes: 15, availableBoxes: 25 });
    expect((await buildSnapshot(actor)).features).toEqual({ freeToSell: true });
  });
});
