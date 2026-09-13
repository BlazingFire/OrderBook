/**
 * The Brand → main product → sub-product hierarchy.
 *
 * Two small columns carry it: `products.colour_policy` (fixed to the base
 * colour, or selectable at sale time) and `line_items.category_name` (the main
 * product a line was entered under, snapshotted like every other line field).
 * What this suite proves:
 *
 *   · the policy round-trips through create/update and defaults to 'fixed';
 *   · an invalid policy is refused before the database gets to;
 *   · `createLead` fills `categoryName` from the product's category when the
 *     client did not send one, and keeps a client-sent one (the offline
 *     quote's own snapshot wins, like every other snapshot field);
 *   · the category pick and the category-filtered product pick answer;
 *   · bulk import accepts a `colourPolicy` column.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseImportRow, matchHeaders } from '../src/domain/product-import.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as searchService from '../src/services/search.service.js';
import type { ActorContext } from '../src/domain/actor.js';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('product hierarchy (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('defaults the colour policy to fixed and round-trips selectable', async () => {
    const plain = await catalog.createProduct({ productCode: 'H-01', name: 'Plain Model' }, actor);
    expect(plain.colourPolicy).toBe('fixed');
    expect(plain.categoryName).toBeNull();

    const updated = await catalog.updateProduct(
      plain.id,
      { productCode: 'H-01', name: 'Plain Model', colourPolicy: 'selectable' },
      actor,
    );
    expect(updated.colourPolicy).toBe('selectable');

    const back = await catalog.updateProduct(
      plain.id,
      { productCode: 'H-01', name: 'Plain Model', colourPolicy: 'fixed' },
      actor,
    );
    expect(back.colourPolicy).toBe('fixed');
  });

  it('refuses an unknown colour policy before the database gets to', async () => {
    await expect(
      catalog.createProduct(
        { productCode: 'H-02', name: 'Bad Policy', colourPolicy: 'rainbow' as never },
        actor,
      ),
    ).rejects.toThrow();
  });

  it('snapshots the main product onto the line, and keeps a client-sent one', async () => {
    const party = await catalog.createParty({ name: 'Hierarchy Party' }, actor);
    const product = await catalog.createProduct(
      { productCode: 'H-03', name: '102 (9")', categoryName: 'One Piece Toilet' },
      actor,
    );

    const lead = await leads.createLead(
      {
        partyId: party.id,
        items: [{ productId: product.id, quantities: [{ colour: 'White', quantity: 2 }] }],
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
            categoryName: 'Old Range Name',
            quantities: [{ colour: 'White', quantity: 1 }],
          },
        ],
      },
      actor,
    );
    expect(offline.items[0]?.categoryName).toBe('Old Range Name');
  });

  it('picks categories, then only the models inside one', async () => {
    await catalog.createProduct(
      { productCode: 'H-10', name: '102 (9")', categoryName: 'One Piece Toilet' },
      actor,
    );
    await catalog.createProduct(
      { productCode: 'H-11', name: 'Damru', categoryName: 'One Piece Basin' },
      actor,
    );

    const categories = await searchService.pick('category', { term: 'one piece' }, actor);
    const names = categories.items.map((row) => ('name' in row ? row.name : ''));
    expect(names).toContain('One Piece Toilet');
    expect(names).toContain('One Piece Basin');

    const toilet = categories.items.find((row) => 'name' in row && row.name === 'One Piece Toilet');
    const models = await searchService.pick(
      'product',
      { term: '', categoryId: 'id' in toilet! ? String(toilet.id) : '' },
      actor,
    );
    expect(models.items.map((row) => ('name' in row ? row.name : ''))).toEqual(['102 (9")']);
  });

  it('parses a colourPolicy column off an import row', async () => {
    const headers = ['code', 'name', 'colourPolicy'];
    const match = matchHeaders(headers);
    const outcome = parseImportRow(['H-20', 'E.W.C. - S Trap', 'selectable'], match, headers, 2, {
      rates: true,
      cost: true,
    });
    expect(outcome.issues).toEqual([]);
    expect(outcome.input?.colourPolicy).toBe('selectable');
  });
});
