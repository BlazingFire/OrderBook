/**
 * What the v1.1.0 hierarchy work left behind once the variant restructure
 * took over the model itself: the main product frozen on a line, and the
 * category picker only offering categories that hold live products.
 *
 *   · `createLead` fills `categoryName` from the product's category when the
 *     client did not send one, and keeps a client-sent one (the offline
 *     quote's own snapshot wins, like every other snapshot field);
 *   · re-categorising the product afterwards does not rewrite the line;
 *   · a category with nothing live in it is not offered on the lead screen,
 *     unless it is the one already chosen.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as searchService from '../src/services/search.service.js';
import type { ActorContext } from '../src/domain/actor.js';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

const namesOf = (page: { items: unknown[] }) =>
  page.items.map((row) => (row && typeof row === 'object' && 'name' in row ? String(row.name) : ''));

describe.skipIf(!canRunIntegrationTests)('product hierarchy (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('snapshots the main product onto the line, keeps a client-sent one, and never rewrites it', async () => {
    const party = await catalog.createParty({ name: 'Hierarchy Party' }, actor);
    const product = await catalog.createProduct(
      { name: '102 (9")', categoryName: 'One Piece Toilet', variants: [{ code: 'H-03' }] },
      actor,
    );
    const variant = product.variants[0]!;

    const lead = await leads.createLead(
      {
        partyId: party.id,
        items: [{ productId: product.id, variantId: variant.id, quantity: 2 }],
      },
      actor,
    );
    expect(lead.items[0]?.categoryName).toBe('One Piece Toilet');

    const offline = await leads.createLead(
      {
        partyId: party.id,
        items: [
          {
            productId: product.id,
            variantId: variant.id,
            quantity: 1,
            categoryName: 'Old Range Name',
          },
        ],
      },
      actor,
    );
    expect(offline.items[0]?.categoryName).toBe('Old Range Name');

    // Moved to another range later: the lines still say what they were sold as.
    await catalog.updateProduct(product.id, { name: product.name, categoryName: 'Water Closet' }, actor);
    expect((await leads.getLead(lead.id, actor)).items[0]?.categoryName).toBe('One Piece Toilet');
  });

  it('picks categories, then only the models inside one', async () => {
    await catalog.createProduct(
      { name: '102 (9")', categoryName: 'One Piece Toilet', variants: [{ code: 'H-10' }] },
      actor,
    );
    await catalog.createProduct(
      { name: 'Damru', categoryName: 'One Piece Basin', variants: [{ code: 'H-11' }] },
      actor,
    );

    const categories = await searchService.pick('category', { term: 'one piece' }, actor);
    expect(namesOf(categories)).toContain('One Piece Toilet');
    expect(namesOf(categories)).toContain('One Piece Basin');

    const toilet = categories.items.find((row) => 'name' in row && row.name === 'One Piece Toilet');
    const models = await searchService.pick(
      'product',
      { term: '', categoryId: toilet && 'id' in toilet ? String(toilet.id) : '' },
      actor,
    );
    expect(namesOf(models)).toEqual(['102 (9")']);
  });

  it('offers only categories that hold a live product, plus the one already chosen', async () => {
    const product = await catalog.createProduct(
      { name: 'Hexa', categoryName: 'Urinal', variants: [{ code: 'H-20' }] },
      actor,
    );
    const empty = await catalog.createProduct(
      { name: 'Gone', categoryName: 'Discontinued', variants: [{ code: 'H-21' }] },
      actor,
    );
    await catalog.deleteProduct(empty.id, actor);

    const offered = await searchService.pick('category', { term: '' }, actor);
    expect(namesOf(offered)).toEqual(['Urinal']);

    // The chip already on the screen must not vanish because its last product went.
    const kept = await searchService.pick(
      'category',
      { term: '', include: [empty.categoryId] },
      actor,
    );
    expect(namesOf(kept).sort()).toEqual(['Discontinued', 'Urinal']);
    expect(product.categoryName).toBe('Urinal');
  });
});
