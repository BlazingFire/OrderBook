// @vitest-environment node
/**
 * The weights on the pending order PDF, from a real lead (D10's audit, 2026-10-07): the weight of a page counts the
 * coded products as the quantity does, and the pages add up to the total.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { createTestProduct, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { leadNotePdf } from '../src/domain/lead-pdf.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('the pending order PDF weights (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('adds the coded products to the weight of a page, and the pages to the total', async () => {
    const party = await catalog.createParty({ name: 'Weight Traders' }, actor);
    const items = [];
    const named = await createTestProduct(actor, { name: 'S TRAP', code: 'ST-1', weightKg: 7 });
    items.push({ productId: named.product.id, variantId: named.variant.id, quantity: 22, packaging: 'carton' });
    for (let i = 0; i < 57; i += 1) {
      const coded = await createTestProduct(actor, { name: String(100 + i), categoryName: `VR${1 + (i % 20)}`, code: `VR-${i}`, weightKg: 32.5 });
      items.push({ productId: coded.product.id, variantId: coded.variant.id, quantity: 4, packaging: 'carton' });
    }
    const created = await leads.createLead({ partyId: party.id, items }, actor);
    const lead = await leads.getLead(created.id, actor);

    const input = leadNotePdf(lead, null, 'Co', new Date());

    expect(input.pages.length).toBeGreaterThan(1);
    // Every page that holds coded products weighs them: nothing on a codes-only page is 0 kg.
    for (const page of input.pages) expect(page.weightKg, `page ${page.pageNo}`).toBeGreaterThan(0);
    expect(input.pages.reduce((sum, page) => sum + page.weightKg, 0)).toBeCloseTo(input.totalWeightKg, 1);
    expect(input.totalWeightKg).toBeCloseTo(7 * 22 + 57 * 4 * 32.5, 1);
  });
});
