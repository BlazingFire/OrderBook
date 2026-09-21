/**
 * Universal search (docs/LEAD_GENERATION_FLOW.md §9).
 *
 * The guide specifies SQLite FTS5; this runs on PostgreSQL, so the mechanism is
 * `tsvector` + GIN. What matters is that the *rules* survived the port, and the
 * one that carries real weight is §9.3: line items are indexed over their
 * **snapshot** text, separately from the live catalogue. A product renamed today
 * must still be findable under the name it was quoted at — which is exactly
 * what a join to `products` could never do, and what these tests prove.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as search from '../src/services/search.service.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('search (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  async function seed() {
    const party = await catalog.createParty(
      { name: 'Rajkot Sanitary', phone: '9876543210', city: 'Rajkot' },
      actor,
    );
    const product = await catalog.createProduct(
      {
        categoryName: 'Basins',
        variants: [{ code: 'SAN-77' }],
        name: 'Cascade Basin',
        alias: 'Waterfall',
        size: '550x400',
      },
      actor,
    );
    return { party, product };
  }

  describe('finding reference data', () => {
    it('matches a product by name, code, alias and size', async () => {
      await seed();

      for (const term of ['Cascade', 'SAN-77', 'Waterfall', '550x400']) {
        const hits = await search.search({ term }, actor);
        expect(hits.some((hit) => hit.kind === 'product' && hit.title === 'Cascade Basin')).toBe(
          true,
        );
      }
    });

    it('matches a party by name and phone', async () => {
      await seed();

      for (const term of ['Rajkot', '9876543210']) {
        const hits = await search.search({ term }, actor);
        expect(hits.some((hit) => hit.kind === 'party')).toBe(true);
      }
    });

    it('says nothing rather than everything for an unmatched term', async () => {
      await seed();
      expect(await search.search({ term: 'zzzznotathing' }, actor)).toEqual([]);
    });

    it('finds a model by any variant code or colour, and follows a code that is edited later', async () => {
      const model = await catalog.createProduct(
        {
          categoryName: 'Basins',
          name: 'Damru',
          hasVariants: true,
          variants: [
            { code: 'DMR-41', label: 'Vitrosa 41' },
            { code: 'DMR-42', label: 'Magenta' },
          ],
        },
        actor,
      );

      for (const term of ['DMR-42', 'Magenta']) {
        const hits = await search.search({ term, kinds: ['product'] }, actor);
        expect(hits.map((hit) => hit.id)).toEqual([model.id]);
      }
      // The subtitle is what tells two models apart in the list: the
      // category and the codes.
      const [hit] = await search.search({ term: 'Damru', kinds: ['product'] }, actor);
      expect(hit?.subtitle).toContain('Basins');
      expect(hit?.subtitle).toContain('DMR-41');

      // A variant edit re-indexes the product: the product's own row did not
      // change, so this only works because the variant table has a trigger.
      await catalog.updateProduct(
        model.id,
        {
          name: 'Damru',
          variants: [
            { id: model.variants[0]!.id, code: 'DMR-41', label: 'Vitrosa 41' },
            { id: model.variants[1]!.id, code: 'DMR-99', label: 'Magenta' },
          ],
        },
        actor,
      );
      expect((await search.search({ term: 'DMR-99', kinds: ['product'] }, actor)).map((hit) => hit.id)).toEqual([
        model.id,
      ]);
      expect(await search.search({ term: 'DMR-42', kinds: ['product'] }, actor)).toEqual([]);
    });
  });

  describe('finding leads and orders through their line items', () => {
    async function seedLeadAndOrder() {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            {
              productId: product.id,
              variantId: product.variants[0]!.id,
              quantity: 3,
              packaging: 'wooden crate',
            },
          ],
        },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);
      return { product, lead, order };
    }

    it('routes a line hit back to the lead or order that owns it', async () => {
      const { lead, order } = await seedLeadAndOrder();

      const hits = await search.search({ term: 'Cascade' }, actor);

      const leadHit = hits.find((hit) => hit.kind === 'lead_line');
      const orderHit = hits.find((hit) => hit.kind === 'order_line');

      // The parent id, not the line's — the result has to open a screen.
      expect(leadHit?.id).toBe(lead.id);
      expect(orderHit?.id).toBe(order.id);
    });

    it('finds a historical order under the product name it was quoted at', async () => {
      const { product, order } = await seedLeadAndOrder();

      // The catalogue is renamed months later.
      await catalog.updateProduct(
        product.id,
        { name: 'Cascade Basin Mk II', alias: 'Waterfall II' },
        actor,
      );

      // The live product no longer contains the old name anywhere…
      const productHits = await search.search({ term: 'Cascade' }, actor);
      expect(productHits.find((hit) => hit.kind === 'product')?.title).toBe(
        'Cascade Basin Mk II',
      );

      // …but the order still shows it, and is still findable by it. This is the
      // whole reason line items carry their own index.
      const orderHits = await search.search({ term: 'Cascade' }, actor);
      expect(orderHits.some((hit) => hit.kind === 'order_line' && hit.id === order.id)).toBe(
        true,
      );
      expect((await orders.getOrder(order.id, actor)).items[0]?.productName).toBe(
        'Cascade Basin',
      );
    });

    it('matches on packaging, which lives only on the line', async () => {
      const { lead } = await seedLeadAndOrder();

      const hits = await search.search({ term: 'crate' }, actor);

      expect(hits.some((hit) => hit.kind === 'lead_line' && hit.id === lead.id)).toBe(true);
    });

    it('matches a line by the colour it was raised in, and names it in the subtitle', async () => {
      const party = await catalog.createParty({ name: 'Morbi Traders' }, actor);
      const model = await catalog.createProduct(
        {
          categoryName: 'Basins',
          name: 'Damru',
          hasVariants: true,
          variants: [
            { code: 'DMR-41', label: 'Vitrosa 41' },
            { code: 'DMR-42', label: 'Burgundy' },
          ],
        },
        actor,
      );
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: model.id, variantId: model.variants[1]!.id, quantity: 2, packaging: 'carton' }],
        },
        actor,
      );

      const hits = await search.search({ term: 'Burgundy', kinds: ['lead_line'] }, actor);

      expect(hits.map((hit) => hit.id)).toEqual([lead.id]);
      expect(hits[0]?.subtitle).toContain('DMR-42');
      expect(hits[0]?.subtitle).toContain('Burgundy');
    });
  });

  describe('scoping', () => {
    it('honours the requested kinds', async () => {
      await seed();

      const hits = await search.search({ term: 'Cascade', kinds: ['product'] }, actor);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.kind === 'product')).toBe(true);
    });

    it('survives punctuation a person would actually type', async () => {
      await seed();

      // websearch_to_tsquery rather than plainto_tsquery: this must not throw.
      for (const term of ['SAN-77', '"Cascade Basin"', 'cascade or waterfall', 'basin!']) {
        await expect(search.search({ term }, actor)).resolves.toBeInstanceOf(Array);
      }
    });
  });
});
