/**
 * The per-stage counts on the Pending and Final Orders stage chips (1.4.3 R17 rework). They must be
 * true totals under the list's own filters (search, "my parties", the converted page) and must not
 * move with the stage chip or the page, so every page of a list shows the same figures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, createTestProduct, resetData, setupDatabase, stageIdByName, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';

describe.skipIf(!canRunIntegrationTests)('stage counts (integration)', () => {
  let actor: ActorContext;

  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  let serial = 0;
  async function lead(partyName: string) {
    const party = await catalog.createParty({ name: partyName }, actor);
    const { product, variant } = await createTestProduct(actor, { name: `Basin ${partyName}`, code: `B-${(serial += 1)}` });
    return leads.createLead(
      { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 2, packaging: 'carton' }] },
      actor,
    );
  }

  it('counts leads per stage under the search, whatever stage is asked for, and moves when a lead changes stage', async () => {
    const a = await lead('Alpha Tiles');
    await lead('Alpha Sanitary');
    await lead('Beta Ceramics');
    const quoted = await stageIdByName('lead', 'Quoted');

    const everyone = await leads.stageCounts({}, actor);
    expect(everyone.total).toBe(3);
    expect(Object.values(everyone.counts).reduce((sum, n) => sum + n, 0)).toBe(3);

    // The search narrows the counts; a stage in the query does not.
    const alpha = await leads.stageCounts({ search: 'Alpha', stageIds: [quoted] }, actor);
    expect(alpha.total).toBe(2);

    await leads.setStage({ id: a.id, stageId: quoted }, actor);
    const after = await leads.stageCounts({ search: 'Alpha' }, actor);
    expect(after.counts[quoted]).toBe(1);
    expect(after.total).toBe(2);

    // The same counts however the list is paged or narrowed to one stage.
    const page = await leads.listLeads({ search: 'Alpha', stageIds: [quoted], limit: 1, offset: 0 }, actor);
    expect(page.total).toBe(1);
    expect(after.total).toBe(2);
  });

  it('keeps converted leads out of the pending counts and counts them on the converted page', async () => {
    const a = await lead('Gamma Traders');
    await lead('Delta Traders');
    await orders.convertLead({ leadId: a.id }, actor);

    expect((await leads.stageCounts({}, actor)).total).toBe(1);
    expect((await leads.stageCounts({ convertedOnly: true }, actor)).total).toBe(1);
  });

  it('counts orders per stage, and the counts add up to the list total', async () => {
    const a = await lead('Eta Traders');
    const b = await lead('Eta Sanitary');
    await lead('Zeta Ceramics');
    const first = await orders.convertLead({ leadId: a.id }, actor);
    await orders.convertLead({ leadId: b.id }, actor);
    const postpone = await stageIdByName('order', 'Postpone');
    await orders.setStage({ id: first.id, stageId: postpone }, actor);

    const counts = await orders.stageCounts({}, actor);
    expect(counts.total).toBe(2);
    expect(counts.counts[postpone]).toBe(1);
    const list = await orders.listOrders({ limit: 1, offset: 0 }, actor);
    expect(list.total).toBe(counts.total);

    const eta = await orders.stageCounts({ search: 'Eta', stageIds: [postpone] }, actor);
    expect(eta.total).toBe(2);
    expect((await orders.stageCounts({ search: 'nobody-by-this-name' }, actor)).total).toBe(0);
  });

  it('is for people who may view the records', async () => {
    const viewer = await actorWith([]);
    await expect(orders.stageCounts({}, viewer)).rejects.toThrow();
    await expect(leads.stageCounts({}, viewer)).rejects.toThrow();
  });
});
