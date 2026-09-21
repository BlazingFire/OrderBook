import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import { db } from '../src/db/knex.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('catalog service (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('parties', () => {
    it('assigns sequential display codes', async () => {
      const first = await catalog.createParty({ name: 'Patel Tiles' }, actor);
      const second = await catalog.createParty({ name: 'Rajesh Traders' }, actor);

      expect(first.partyCode).toBe('P-0001');
      expect(second.partyCode).toBe('P-0002');
    });

    it('allows two parties to share a name, since real customers do', async () => {
      await catalog.createParty({ name: 'Sharma Traders', city: 'Morbi' }, actor);
      const duplicate = await catalog.createParty({ name: 'Sharma Traders', city: 'Rajkot' }, actor);

      expect(duplicate.partyCode).toBe('P-0002');
    });

    it('rejects a blank name', async () => {
      await expect(catalog.createParty({ name: '   ' }, actor)).rejects.toThrow(/name is required/i);
    });

    it('trims whitespace off the stored name', async () => {
      const party = await catalog.createParty({ name: '  Patel Tiles  ' }, actor);
      expect(party.name).toBe('Patel Tiles');
    });

    it('finds a party by name, code or phone', async () => {
      await catalog.createParty({ name: 'Patel Tiles', phone: '9876543210' }, actor);
      await catalog.createParty({ name: 'Rajesh Traders', phone: '9123456780' }, actor);

      expect((await catalog.listParties({ search: 'patel' }, actor)).items).toHaveLength(1);
      expect((await catalog.listParties({ search: 'P-0002' }, actor)).items).toHaveLength(1);
      expect((await catalog.listParties({ search: '9123' }, actor)).items).toHaveLength(1);
      expect((await catalog.listParties({}, actor)).total).toBe(2);
    });

    it('searches case-insensitively', async () => {
      await catalog.createParty({ name: 'Patel Tiles' }, actor);
      expect((await catalog.listParties({ search: 'PATEL' }, actor)).items).toHaveLength(1);
    });

    it('reports the full total alongside a limited page', async () => {
      for (let i = 0; i < 5; i += 1) {
        await catalog.createParty({ name: `Party ${i}` }, actor);
      }

      const page = await catalog.listParties({ limit: 2 }, actor);
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(5);
    });

    it('updates an existing party', async () => {
      const party = await catalog.createParty({ name: 'Patel Tiles', city: 'Morbi' }, actor);
      const updated = await catalog.updateParty(party.id, { name: 'Patel Tiles', city: 'Rajkot' }, actor);

      expect(updated.city).toBe('Rajkot');
      expect(updated.partyCode).toBe(party.partyCode);
    });

    it('reports a missing party rather than silently doing nothing', async () => {
      await expect(
        catalog.updateParty('00000000-0000-4000-8000-000000000000', { name: 'X' }, actor),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('products', () => {
    const single = (name: string, code: string, extra: Record<string, unknown> = {}) =>
      catalog.createProduct(
        { name, categoryName: 'Test category', variants: [{ code }], ...extra },
        actor,
      );

    it('refuses a product with no code at all', async () => {
      await expect(
        catalog.createProduct({ name: 'Carrara White', categoryName: 'Basins', variants: [] }, actor),
      ).rejects.toThrow(/at least one code/i);
    });

    it('keeps the supplied code on the product\'s single variant', async () => {
      const product = await single('Statuario', 'GVT-6060');
      expect(product.hasVariants).toBe(false);
      expect(product.variants.map((variant) => [variant.code, variant.label])).toEqual([['GVT-6060', null]]);
    });

    it('refuses a duplicate code across products', async () => {
      await single('One', 'GVT-6060');
      await expect(single('Two', 'GVT-6060')).rejects.toThrow(/already in use/i);
    });

    it('treats codes as case-insensitive when detecting duplicates', async () => {
      await single('One', 'GVT-6060');
      await expect(single('Two', 'gvt-6060')).rejects.toThrow(/already in use/i);
    });

    it('requires a category', async () => {
      await expect(
        catalog.createProduct({ name: 'One', variants: [{ code: 'A1' }] }, actor),
      ).rejects.toThrow(/category/i);
    });

    it('creates a category on the fly and reuses it for the next product', async () => {
      const first = await single('One', 'A1', { categoryName: 'Floor Tile' });
      const second = await single('Two', 'A2', { categoryName: 'floor tile' });

      expect(first.categoryId).toBe(second.categoryId);
      expect(first.categoryName).toBe('Floor Tile');
      expect(await catalog.listCategories(actor)).toHaveLength(1);
    });

    it('stores custom field values in the JSONB column and reads them back', async () => {
      const product = await single('One', 'A1', { customFields: { glaze: 'matte', batch: 7 } });
      expect(product.customFields).toEqual({ glaze: 'matte', batch: 7 });
    });

    it('supports querying into the JSONB custom fields, which is why the column is JSONB', async () => {
      await single('Matte one', 'A1', { customFields: { glaze: 'matte' } });
      await single('Glossy one', 'A2', { customFields: { glaze: 'glossy' } });

      const rows = await db()('products').whereRaw(`custom_fields->>'glaze' = ?`, ['matte']);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('Matte one');
    });

    it('allows a product to be renamed while keeping its own code', async () => {
      const product = await single('One', 'A1');
      const updated = await catalog.updateProduct(
        product.id,
        { name: 'One Renamed', variants: [{ id: product.variants[0]?.id, code: 'A1' }] },
        actor,
      );

      expect(updated.name).toBe('One Renamed');
      expect(updated.variants.map((variant) => variant.code)).toEqual(['A1']);
    });

    it('refuses to move a product onto another product\'s code', async () => {
      await single('One', 'A1');
      const second = await single('Two', 'A2');

      await expect(
        catalog.updateProduct(
          second.id,
          { name: 'Two', variants: [{ id: second.variants[0]?.id, code: 'A1' }] },
          actor,
        ),
      ).rejects.toThrow(/already in use/i);
    });

    it('searches by code, name and category', async () => {
      await single('Carrara White', 'GVT-01', { categoryName: 'Floor Tile' });
      await single('Statuario Gold', 'WLT-02', { categoryName: 'Wall Tile' });

      expect((await catalog.listProducts({ search: 'carrara' }, actor)).items).toHaveLength(1);
      expect((await catalog.listProducts({ search: 'WLT' }, actor)).items).toHaveLength(1);
      expect((await catalog.listProducts({ search: 'Wall' }, actor)).items).toHaveLength(1);
    });

    it('filters by category and counts the facet over the search, not the filter', async () => {
      await single('Carrara', 'V-1', { categoryName: 'Vitrified' });
      await single('Statuario', 'V-2', { categoryName: 'Vitrified' });
      const wall = await single('Carrara Wall', 'C-1', { categoryName: 'Ceramic' });

      const vitrified = await catalog.listProducts({ categoryId: wall.categoryId }, actor);
      expect(vitrified.items.map((product) => product.name)).toEqual(['Carrara Wall']);
      expect(vitrified.total).toBe(1);
      // Every chip stays clickable while one is selected.
      expect(vitrified.categories?.map((entry) => [entry.name, entry.count])).toEqual([
        ['Ceramic', 1],
        ['Vitrified', 2],
      ]);

      const searched = await catalog.listProducts({ search: 'carrara' }, actor);
      expect(searched.total).toBe(2);
      expect(searched.categories?.map((entry) => [entry.name, entry.count])).toEqual([
        ['Ceramic', 1],
        ['Vitrified', 1],
      ]);

      // The category itself is searchable.
      expect((await catalog.listProducts({ search: 'ceram' }, actor)).total).toBe(1);
    });

    it('lists only products with a variant missing its weight when asked', async () => {
      await single('Weighed', 'W-1', { variants: [{ code: 'W-1', weightKg: 12.5 }] });
      await single('Unweighed', 'W-2');

      const missing = await catalog.listProducts({ missingWeight: true }, actor);
      expect(missing.items.map((product) => product.name)).toEqual(['Unweighed']);
    });
  });

  it('records an activity row for every write', async () => {
    const party = await catalog.createParty({ name: 'Patel Tiles' }, actor);
    await catalog.updateParty(party.id, { name: 'Patel Tiles Ltd' }, actor);

    const entries = await db()('activity_log').where({ entity_type: 'party' }).orderBy('id');
    expect(entries.map((entry) => entry.action)).toEqual(['created', 'updated']);
  });
});
