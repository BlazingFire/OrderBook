/**
 * Product alteration: pending only patch of line snapshots (integration).
 *
 * A rename plus a new size flows into pending leads and undispatched orders
 * while product and variant ids stay unchanged. Converted leads and
 * dispatched orders keep the snapshot taken on the day and are listed as
 * read only. Uses the same services the screens call, against PostgreSQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import {
  applyProductAlteration,
  previewProductAlteration,
} from '../src/services/product-alteration.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
let actor: ActorContext;
async function seed() {
  const party = await catalog.createParty({ name: 'Alteration Trader' }, actor);
  const product = await catalog.createProduct(
    {
      name: 'Alteration Basin',
      categoryName: 'WASH BASIN',
      size: '550mm',
      variants: [{ code: 'ALT-1', weightKg: 12 }],
    },
    actor,
  );
  const variant = product.variants[0];
  if (!variant) throw new Error('seed: no variant');
  return { party, product, variant };
}
function line(productId: string, variantId: string, quantity: number) {
  return { productId, variantId, quantity };
}
describe.skipIf(!canRunIntegrationTests)('product alteration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });
  it('previews pending and frozen lines separately', async () => {
    const { party, product, variant } = await seed();
    const pending = await leads.createLead(
      { partyId: party.id, items: [line(product.id, variant.id, 2)] },
      actor,
    );
    const converting = await leads.createLead(
      { partyId: party.id, items: [line(product.id, variant.id, 1)] },
      actor,
    );
    await orders.dispatchOrder(
      { orderId: (await orders.convertLead({ leadId: converting.id }, actor)).id },
      actor,
    );
    const preview = await previewProductAlteration(product.id, actor);
    expect(preview.productId).toBe(product.id);
    expect(preview.pendingLeads).toBe(1);
    expect(preview.pendingOrders).toBe(0);
    expect(preview.pending.map((entry) => entry.parentId)).toContain(pending.id);
    expect(preview.frozen.length).toBeGreaterThanOrEqual(2);
  });
  it('patches pending snapshots, keeps ids, and leaves dispatched history alone', async () => {
    const { party, product, variant } = await seed();
    const pending = await leads.createLead(
      { partyId: party.id, items: [line(product.id, variant.id, 2)] },
      actor,
    );
    const converting = await leads.createLead(
      { partyId: party.id, items: [line(product.id, variant.id, 1)] },
      actor,
    );
    const order = await orders.convertLead({ leadId: converting.id }, actor);
    await orders.dispatchOrder({ orderId: order.id }, actor);
    const beforePending = await db()('line_items')
      .where({ parent_id: pending.id })
      .select('product_name', 'size', 'product_id', 'variant_id');
    expect(beforePending[0]?.product_name).toBe('Alteration Basin');
    const result = await applyProductAlteration(
      product.id,
      {
        product: {
          name: 'Alteration Basin Plus',
          categoryId: product.categoryId,
          size: '600mm',
          multiColour: false,
          hasVariants: false,
          variants: [{ id: variant.id, code: 'ALT-1', label: null, weightKg: 12 }],
        },
      },
      actor,
    );
    expect(result.updated).toBe(true);
    expect(result.pendingLeadsPatched).toBe(1);
    expect(result.frozenSkipped).toBeGreaterThanOrEqual(1);
    const afterPending = await db()('line_items')
      .where({ parent_id: pending.id })
      .select('product_name', 'size', 'product_id', 'variant_id');
    expect(afterPending[0]?.product_name).toBe('Alteration Basin Plus');
    expect(afterPending[0]?.size).toBe('600mm');
    expect(afterPending[0]?.product_id).toBe(product.id);
    expect(afterPending[0]?.variant_id).toBe(variant.id);
    const frozenLines = await db()('line_items')
      .where({ parent_id: order.id })
      .select('product_name');
    expect(frozenLines[0]?.product_name).toBe('Alteration Basin');
    expect(result.affected.length).toBeGreaterThan(0);
  });
});
