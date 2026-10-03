/**
 * 1.4 D3 (R17): Parties and Products sort on the server (so the order holds
 * across pages) and filter by the columns the owner named.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalogService from '../src/services/catalog.service.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('list sorting and filters (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('parties', () => {
    async function seed(): Promise<void> {
      await catalogService.createParty({ name: 'Alpha', city: 'Morbi', state: 'Gujarat', gstNumber: '24AAAAA0000A1Z5' }, actor);
      await catalogService.createParty({ name: 'Bravo', city: 'Ahmedabad', state: 'Gujarat' }, actor);
      await catalogService.createParty({ name: 'Charlie', city: 'Jaipur', state: 'Rajasthan', gstNumber: '08BBBBB0000B1Z5' }, actor);
      await catalogService.createParty({ name: 'Delta', state: 'Rajasthan' }, actor);
    }
    const names = async (query: Parameters<typeof catalogService.listParties>[0]) =>
      (await catalogService.listParties(query, actor)).items.map((party) => party.name);

    it('sorts by city both ways with the empty city last, across the whole set', async () => {
      await seed();
      expect(await names({ sort: 'city', dir: 'asc' })).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
      expect(await names({ sort: 'city', dir: 'desc' })).toEqual(['Alpha', 'Charlie', 'Bravo', 'Delta']);
      // The order holds across pages, which a client-side sort of one page cannot.
      expect(await names({ sort: 'city', dir: 'asc', limit: 2, offset: 2 })).toEqual(['Alpha', 'Delta']);
    });

    it('ignores a sort key it does not know', async () => {
      await seed();
      expect(await names({ sort: 'name; drop table parties', dir: 'desc' })).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    });

    it('filters by city, state and GST, together', async () => {
      await seed();
      expect(await names({ city: 'ahmed' })).toEqual(['Bravo']);
      expect(await names({ state: 'rajasthan' })).toEqual(['Charlie', 'Delta']);
      expect(await names({ hasGst: true })).toEqual(['Alpha', 'Charlie']);
      expect(await names({ hasGst: false })).toEqual(['Bravo', 'Delta']);
      expect(await names({ state: 'rajasthan', hasGst: true })).toEqual(['Charlie']);
      expect((await catalogService.listParties({ hasGst: true, limit: 1 }, actor)).total).toBe(2);
    });
  });

  describe('products', () => {
    async function seed(): Promise<void> {
      const make = (name: string, categoryName: string, code: string, size: string | null, brand: string | null) =>
        catalogService.createProduct(
          {
            name,
            categoryName,
            ...(brand ? { categoryBrand: brand } : {}),
            ...(size ? { size } : {}),
            variants: [{ code }],
          } as never,
          actor,
        );
      await make('Zebra', 'Tiles', 'T-3', '600x600', 'Swisware');
      await make('Apple', 'Tiles', 'T-1', '300x300', 'Swisware');
      await make('Mango', 'Sinks', 'S-2', null, null);
    }
    const names = async (query: Parameters<typeof catalogService.listProducts>[0]) =>
      (await catalogService.listProducts(query, actor)).items.map((product) => product.name);

    it('sorts by each column in both directions, with a missing value last', async () => {
      await seed();
      expect(await names({ sort: 'name', dir: 'asc' })).toEqual(['Apple', 'Mango', 'Zebra']);
      expect(await names({ sort: 'name', dir: 'desc' })).toEqual(['Zebra', 'Mango', 'Apple']);
      expect(await names({ sort: 'code', dir: 'asc' })).toEqual(['Mango', 'Apple', 'Zebra']);
      expect(await names({ sort: 'size', dir: 'asc' })).toEqual(['Apple', 'Zebra', 'Mango']);
      expect(await names({ sort: 'size', dir: 'desc' })).toEqual(['Zebra', 'Apple', 'Mango']);
      expect(await names({ sort: 'category', dir: 'asc' })).toEqual(['Mango', 'Apple', 'Zebra']);
      expect(await names({ sort: 'brand', dir: 'asc' })).toEqual(['Apple', 'Zebra', 'Mango']);
    });

    it('keeps catalogue order for an unknown key, and pages in sort order', async () => {
      await seed();
      const unsorted = await names({});
      expect(await names({ sort: 'nope; select 1' })).toEqual(unsorted);
      expect(await names({ sort: 'name', dir: 'desc', limit: 2, offset: 1 })).toEqual(['Mango', 'Apple']);
    });

    it('filters by size and by whether there is a photo', async () => {
      await seed();
      expect(await names({ size: '600X600' })).toEqual(['Zebra']);
      expect(await names({ hasPhoto: true })).toEqual([]);
      expect((await names({ hasPhoto: false })).sort()).toEqual(['Apple', 'Mango', 'Zebra']);
    });
  });
});
