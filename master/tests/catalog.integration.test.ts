import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import { db } from '../src/db/knex.js';

const actor: ActorContext = { actorType: 'user', actorId: null };

describe.skipIf(!canRunIntegrationTests)('catalog service (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

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

      expect((await catalog.listParties({ search: 'patel' })).items).toHaveLength(1);
      expect((await catalog.listParties({ search: 'P-0002' })).items).toHaveLength(1);
      expect((await catalog.listParties({ search: '9123' })).items).toHaveLength(1);
      expect((await catalog.listParties({})).total).toBe(2);
    });

    it('searches case-insensitively', async () => {
      await catalog.createParty({ name: 'Patel Tiles' }, actor);
      expect((await catalog.listParties({ search: 'PATEL' })).items).toHaveLength(1);
    });

    it('reports the full total alongside a limited page', async () => {
      for (let i = 0; i < 5; i += 1) {
        await catalog.createParty({ name: `Party ${i}` }, actor);
      }

      const page = await catalog.listParties({ limit: 2 });
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
    it('generates a product code when none is supplied', async () => {
      const product = await catalog.createProduct({ productCode: '', name: 'Carrara White' }, actor);
      expect(product.productCode).toBe('PRD-0001');
    });

    it('keeps a supplied product code', async () => {
      const product = await catalog.createProduct({ productCode: 'GVT-6060', name: 'Statuario' }, actor);
      expect(product.productCode).toBe('GVT-6060');
    });

    it('refuses a duplicate product code', async () => {
      await catalog.createProduct({ productCode: 'GVT-6060', name: 'One' }, actor);
      await expect(
        catalog.createProduct({ productCode: 'GVT-6060', name: 'Two' }, actor),
      ).rejects.toThrow(/already in use/i);
    });

    it('treats product codes as case-insensitive when detecting duplicates', async () => {
      await catalog.createProduct({ productCode: 'GVT-6060', name: 'One' }, actor);
      await expect(
        catalog.createProduct({ productCode: 'gvt-6060', name: 'Two' }, actor),
      ).rejects.toThrow(/already in use/i);
    });

    it('creates a category on the fly and reuses it for the next product', async () => {
      const first = await catalog.createProduct(
        { productCode: 'A1', name: 'One', categoryName: 'Floor Tile' },
        actor,
      );
      const second = await catalog.createProduct(
        { productCode: 'A2', name: 'Two', categoryName: 'floor tile' },
        actor,
      );

      expect(first.categoryId).toBe(second.categoryId);
      expect(await catalog.listCategories()).toHaveLength(1);
    });

    it('stores flexible attributes in the JSONB column and reads them back', async () => {
      const product = await catalog.createProduct(
        { productCode: 'A1', name: 'One', parameters: { glaze: 'matte', batch: 7 } },
        actor,
      );

      expect(product.parameters).toEqual({ glaze: 'matte', batch: 7 });
    });

    it('supports querying into JSONB parameters, which is why the column is JSONB', async () => {
      await catalog.createProduct(
        { productCode: 'A1', name: 'Matte one', parameters: { glaze: 'matte' } },
        actor,
      );
      await catalog.createProduct(
        { productCode: 'A2', name: 'Glossy one', parameters: { glaze: 'glossy' } },
        actor,
      );

      const rows = await db()('products').whereRaw(`parameters->>'glaze' = ?`, ['matte']);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('Matte one');
    });

    it('allows a product to be renamed onto its own existing code', async () => {
      const product = await catalog.createProduct({ productCode: 'A1', name: 'One' }, actor);
      const updated = await catalog.updateProduct(
        product.id,
        { productCode: 'A1', name: 'One Renamed' },
        actor,
      );

      expect(updated.name).toBe('One Renamed');
    });

    it('refuses to move a product onto another product code', async () => {
      await catalog.createProduct({ productCode: 'A1', name: 'One' }, actor);
      const second = await catalog.createProduct({ productCode: 'A2', name: 'Two' }, actor);

      await expect(
        catalog.updateProduct(second.id, { productCode: 'A1', name: 'Two' }, actor),
      ).rejects.toThrow(/already in use/i);
    });

    it('searches by code, name and category', async () => {
      await catalog.createProduct(
        { productCode: 'GVT-01', name: 'Carrara White', categoryName: 'Floor Tile' },
        actor,
      );
      await catalog.createProduct(
        { productCode: 'WLT-02', name: 'Statuario Gold', categoryName: 'Wall Tile' },
        actor,
      );

      expect((await catalog.listProducts({ search: 'carrara' })).items).toHaveLength(1);
      expect((await catalog.listProducts({ search: 'WLT' })).items).toHaveLength(1);
      expect((await catalog.listProducts({ search: 'Wall' })).items).toHaveLength(1);
    });
  });

  it('records an activity row for every write', async () => {
    const party = await catalog.createParty({ name: 'Patel Tiles' }, actor);
    await catalog.updateParty(party.id, { name: 'Patel Tiles Ltd' }, actor);

    const entries = await db()('activity_log').where({ entity_type: 'party' }).orderBy('id');
    expect(entries.map((entry) => entry.action)).toEqual(['created', 'updated']);
  });
});
