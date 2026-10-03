import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { DataChangedEvent } from '@orderbook/shared';

import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import { onChange } from '../src/services/change-bus.js';
import * as fields from '../src/services/fields.service.js';
import * as recycleBin from '../src/services/recycle-bin.service.js';
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

    it('keeps codes unique past P-9999 instead of truncating them', async () => {
      await db().raw(`SELECT setval('party_code_seq', 9999)`);

      const first = await catalog.createParty({ name: 'Ten Thousand' }, actor);
      const second = await catalog.createParty({ name: 'Ten Thousand And One' }, actor);

      expect(first.partyCode).toBe('P-10000');
      expect(second.partyCode).toBe('P-10001');
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
      ).rejects.toMatchObject({ messageKey: 'validation.product.categoryRequired' });
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

  /*
   * Catalogue v2 (`docs/catalogue/CATALOGUE_MODEL.md` §5): categories are the
   * owner's Products — code, brand, catalogue order, a Recycle Bin — and a sub
   * product's name is unique inside its product, its blank code numbered from
   * the product's code.
   */
  describe('products (categories) and their sub products', () => {
    const brand = (value: string) =>
      fields.createValue({ listKey: 'product.brand', value, label: value, hex: null }, actor);
    const subProduct = (name: string, categoryId: string, code = '') =>
      catalog.createProduct({ name, categoryId, variants: [{ code }] }, actor);
    const captured = async <T>(work: () => Promise<T>): Promise<[T, DataChangedEvent[]]> => {
      const events: DataChangedEvent[] = [];
      const stop = onChange((event) => {
        events.push(event);
      });
      try {
        return [await work(), events];
      } finally {
        stop();
      }
    };

    it('creates one with its code, brand and order, logs it and announces it', async () => {
      await brand('Swisware+');
      const [opt, events] = await captured(() =>
        catalog.createCategory(
          { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+', sortOrder: 1 },
          actor,
        ),
      );

      expect(opt).toMatchObject({
        name: 'One Piece Toilet',
        code: 'OPT',
        brand: 'Swisware+',
        sortOrder: 1,
      });
      expect(events.map((event) => [event.entity, event.action])).toEqual([
        ['product_category', 'created'],
      ]);
      const entry = await db()('activity_log').where({ entity_type: 'product_category' }).first();
      expect(entry).toMatchObject({ action: 'created', entity_id: opt.id });
      expect(entry.details).toMatchObject({
        name: 'One Piece Toilet',
        code: 'OPT',
        brand: 'Swisware+',
      });
    });

    it('refuses a blank name or code, a code that is not letters and digits, an unknown brand, a bad order', async () => {
      const refused = (input: Record<string, unknown>) =>
        catalog
          .createCategory(input as never, actor)
          .catch((error: { messageKey: string }) => error.messageKey);

      expect(await refused({ name: ' ', code: 'OPT' })).toBe('validation.category.nameRequired');
      expect(await refused({ name: 'One Piece Toilet' })).toBe('validation.category.codeRequired');
      expect(await refused({ name: 'One Piece Toilet', code: 'OP-T' })).toBe(
        'validation.category.codeInvalid',
      );
      expect(await refused({ name: 'One Piece Toilet', code: 'OPT', brand: 'Nobody' })).toBe(
        'validation.category.brandUnknown',
      );
      expect(await refused({ name: 'One Piece Toilet', code: 'OPT', sortOrder: -1 })).toBe(
        'validation.category.sortOrder',
      );
    });

    it('keeps codes unique case-insensitively, and names unique per brand', async () => {
      await brand('Swisware+');
      await brand('Other');
      await catalog.createCategory(
        { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+' },
        actor,
      );

      await expect(
        catalog.createCategory({ name: 'Anything', code: 'opt' }, actor),
      ).rejects.toMatchObject({
        messageKey: 'error.conflict.categoryCodeTaken',
      });
      await expect(
        catalog.createCategory(
          { name: 'one piece toilet', code: 'OPT2', brand: 'Swisware+' },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'error.conflict.categoryNameTaken' });
      // Another brand may sell a One Piece Toilet of its own.
      await expect(
        catalog.createCategory({ name: 'One Piece Toilet', code: 'OPTX', brand: 'Other' }, actor),
      ).resolves.toMatchObject({ brand: 'Other' });
    });

    it('lists live ones in catalogue order with their sub-product counts, filtered by brand or search', async () => {
      await brand('Swisware+');
      const opb = await catalog.createCategory(
        { name: 'One Piece Basin', code: 'OPB', sortOrder: 2 },
        actor,
      );
      const opt = await catalog.createCategory(
        { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+', sortOrder: 1 },
        actor,
      );
      await subProduct('102', opt.id);
      await subProduct('111', opt.id);

      expect(
        (await catalog.listCategories(actor)).map((row) => [row.code, row.subProductCount]),
      ).toEqual([
        ['OPT', 2],
        ['OPB', 0],
      ]);
      expect(
        (await catalog.listCategories(actor, { brand: 'swisware+' })).map((row) => row.id),
      ).toEqual([opt.id]);
      expect(
        (await catalog.listCategories(actor, { search: 'basin' })).map((row) => row.id),
      ).toEqual([opb.id]);
    });

    it('edits only what was sent, logs what moved, and re-announces the catalogue on a rename', async () => {
      const opt = await catalog.createCategory(
        { name: 'One Piece Toilet', code: 'OPT', sortOrder: 1 },
        actor,
      );

      const [same, quiet] = await captured(() =>
        catalog.updateCategory(opt.id, { sortOrder: 1 }, actor),
      );
      expect(same).toMatchObject({ sortOrder: 1 });
      expect(quiet).toEqual([]);

      const [renamed, events] = await captured(() =>
        catalog.updateCategory(opt.id, { name: 'Toilets', sortOrder: 5 }, actor),
      );
      expect(renamed).toMatchObject({ name: 'Toilets', code: 'OPT', sortOrder: 5 });
      // The sub products in a panel's snapshot carry the old name joined in.
      expect(events.map((event) => event.entity)).toEqual(['product_category', 'catalog']);

      const entry = await db()('activity_log')
        .where({ entity_type: 'product_category', action: 'updated' })
        .first();
      expect(entry.details.changes).toEqual({
        name: { from: 'One Piece Toilet', to: 'Toilets' },
        sortOrder: { from: 1, to: 5 },
      });
    });

    it('refuses a delete while a live sub product sits under it, and names it', async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);
      const toilet = await subProduct('102', opt.id);

      await expect(catalog.deleteCategory(opt.id, actor)).rejects.toMatchObject({
        messageKey: 'error.conflict.blockedByLiveReferences',
        details: { blockedBy: [{ entityType: 'product', id: toilet.id, label: '102 (OPT-0001)' }] },
      });

      await catalog.deleteProduct(toilet.id, actor);
      await catalog.deleteCategory(opt.id, actor);
      expect(await catalog.listCategories(actor)).toEqual([]);
    });

    it('refuses a sub-product catalogue order that is not a whole number, zero or more', async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);

      for (const sortOrder of ['first', 1.5, -1]) {
        await expect(
          catalog.createProduct(
            { name: '102', categoryId: opt.id, sortOrder: sortOrder as number, variants: [{ code: '' }] },
            actor,
          ),
        ).rejects.toMatchObject({ messageKey: 'validation.category.sortOrder' });
      }
    });

    // The two halves of one race: a delete and a sub-product save on the same
    // product. Held open by hand so each side is mid-flight when the other runs.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 300));

    it('a delete waits out a sub product being saved under it, then refuses', async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);

      let deleting: Promise<unknown> = Promise.resolve();
      await db().transaction(async (trx) => {
        await trx('products').insert({
          id: 'PR-RACE-1',
          tenant_id: actor.tenantId,
          category_id: opt.id,
          name: '102',
          hlc: '0',
          field_hlc: '{}',
        });
        deleting = catalog.deleteCategory(opt.id, actor).then(
          () => 'deleted',
          (error: unknown) => error,
        );
        await pause();
      });

      await expect(deleting).resolves.toMatchObject({
        messageKey: 'error.conflict.blockedByLiveReferences',
      });
    });

    it('a sub product saved while its product is being deleted is refused, not filed in the Bin', async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);

      let adding: Promise<unknown> = Promise.resolve();
      await db().transaction(async (trx) => {
        await trx('product_categories').where({ id: opt.id }).forUpdate().first('id');
        await trx('product_categories').where({ id: opt.id }).update({ deleted_at: trx.fn.now() });
        adding = subProduct('102', opt.id, 'OPT-0001').then(
          () => 'added',
          (error: unknown) => error,
        );
        await pause();
      });

      await expect(adding).resolves.toMatchObject({
        messageKey: 'validation.product.categoryRequired',
      });
      expect(await db()('products').where({ category_id: opt.id })).toEqual([]);
    });

    it('a sub product restored while its product is being deleted stays in the Bin', async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);
      const toilet = await subProduct('102', opt.id);
      await catalog.deleteProduct(toilet.id, actor);

      let restoring: Promise<unknown> = Promise.resolve();
      await db().transaction(async (trx) => {
        await trx('product_categories').where({ id: opt.id }).forUpdate().first('id');
        await trx('product_categories').where({ id: opt.id }).update({ deleted_at: trx.fn.now() });
        restoring = catalog.restoreProduct(toilet.id, actor).then(
          () => 'restored',
          (error: unknown) => error,
        );
        await pause();
      });

      await expect(restoring).resolves.toMatchObject({ messageKey: 'error.conflict.parentDeleted' });
      expect(await db()('products').where({ id: toilet.id }).first('deleted_at')).toMatchObject({
        deleted_at: expect.any(Date),
      });
    });

    it('two people saving one code at once: the second is a conflict, not a server error', async () => {
      let creating: Promise<unknown> = Promise.resolve();
      await db().transaction(async (trx) => {
        // Not committed yet, so the second save's own check cannot see it and
        // meets the unique index instead.
        await trx('product_categories').insert({
          id: 'PC-RACE-1',
          tenant_id: actor.tenantId,
          name: 'One Piece Toilet',
          code: 'OPT',
        });
        creating = catalog.createCategory({ name: 'Toilets', code: 'opt' }, actor).then(
          () => 'created',
          (error: unknown) => error,
        );
        await pause();
      });

      await expect(creating).resolves.toMatchObject({
        messageKey: 'error.conflict.categoryCodeTaken',
      });
    });

    it('comes back from the Recycle Bin, and lets its sub products come back only then', async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);
      const toilet = await subProduct('102', opt.id);
      await catalog.deleteProduct(toilet.id, actor);
      await catalog.deleteCategory(opt.id, actor);

      const binned = await recycleBin.listBin({ types: ['product_category'] }, actor);
      expect(binned.items.map((entry) => [entry.id, entry.label, entry.sublabel])).toEqual([
        [opt.id, 'One Piece Toilet', 'OPT'],
      ]);

      // Upward only: the sub product cannot return into a product still in the Bin.
      await expect(
        recycleBin.restoreEntity({ entityType: 'product', id: toilet.id }, actor),
      ).rejects.toMatchObject({
        messageKey: 'error.conflict.parentDeleted',
      });

      await recycleBin.restoreEntity({ entityType: 'product_category', id: opt.id }, actor);
      await recycleBin.restoreEntity({ entityType: 'product', id: toilet.id }, actor);
      expect((await catalog.listCategories(actor)).map((row) => row.subProductCount)).toEqual([1]);

      const actions = await db()('activity_log')
        .where({ entity_type: 'product_category' })
        .orderBy('id');
      expect(actions.map((row) => row.action)).toEqual(['created', 'deleted', 'restored']);
    });

    it('refuses a restore whose code was taken since, and offers a rename for a name taken since', async () => {
      const first = await catalog.createCategory({ name: 'Urinal', code: 'UR' }, actor);
      await catalog.deleteCategory(first.id, actor);
      const taker = await catalog.createCategory({ name: 'Urinals', code: 'UR' }, actor);

      await expect(
        recycleBin.restoreEntity({ entityType: 'product_category', id: first.id }, actor),
      ).rejects.toMatchObject({ messageKey: 'error.conflict.categoryCodeTaken' });

      await catalog.updateCategory(taker.id, { code: 'URN', name: 'Urinal' }, actor);
      await expect(
        recycleBin.restoreEntity({ entityType: 'product_category', id: first.id }, actor),
      ).rejects.toMatchObject({
        messageKey: 'error.conflict.restoreCollision',
        details: { field: 'name', suggestion: 'Urinal (restored)' },
      });
      await expect(
        recycleBin.restoreEntity(
          { entityType: 'product_category', id: first.id, renameTo: 'Old Urinal' },
          actor,
        ),
      ).resolves.toMatchObject({ renamedTo: 'Old Urinal' });
    });

    it('numbers a blank sub-product code from its product, and never hands a binned code out again', async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);

      const first = await subProduct('102 (9")', opt.id);
      const second = await catalog.createProduct(
        { name: '111 (9")', categoryCode: 'opt', variants: [{ code: '  ' }] },
        actor,
      );
      expect([first.variants[0]?.code, second.variants[0]?.code]).toEqual(['OPT-0001', 'OPT-0002']);

      await catalog.deleteProduct(second.id, actor);
      const third = await subProduct('103 (9")', opt.id);
      expect(third.variants[0]?.code).toBe('OPT-0003');

      // A typed code is kept as typed.
      expect((await subProduct('1111', opt.id, '1111')).variants[0]?.code).toBe('1111');
    });

    it('keeps sub-product names unique inside a product, not across products', async () => {
      const v1812 = await catalog.createCategory({ name: '18x12 Vitrosa', code: 'V1812' }, actor);
      const sfd = await catalog.createCategory(
        { name: 'Sofiya Vitrosa Double Colour', code: 'SFD' },
        actor,
      );
      const magenta = await subProduct('MAGENTA', v1812.id);

      await expect(subProduct('magenta', v1812.id)).rejects.toMatchObject({
        messageKey: 'validation.product.nameTaken',
        params: { name: 'magenta', category: '18x12 Vitrosa' },
      });
      const other = await subProduct('MAGENTA', sfd.id);

      // Moving one onto the other's product is the same clash.
      await expect(
        catalog.updateProduct(other.id, { name: 'MAGENTA', categoryId: v1812.id }, actor),
      ).rejects.toMatchObject({ messageKey: 'validation.product.nameTaken' });
      // A binned twin frees the name.
      await catalog.deleteProduct(magenta.id, actor);
      await expect(subProduct('MAGENTA', v1812.id)).resolves.toMatchObject({
        categoryId: v1812.id,
      });
    });

    it("names the product in the sub product's log entries, and logs what an edit moved", async () => {
      const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);
      const toilet = await subProduct('102', opt.id);
      await catalog.updateProduct(toilet.id, { name: '102 (9")', size: 'L-27' }, actor);

      const entries = await db()('activity_log').where({ entity_type: 'product' }).orderBy('id');
      expect(entries.map((entry) => entry.details)).toEqual([
        { name: '102', product: 'One Piece Toilet' },
        {
          name: '102 (9")',
          product: 'One Piece Toilet',
          changes: { name: { from: '102', to: '102 (9")' }, size: { from: null, to: 'L-27' } },
        },
      ]);
    });
  });

  it('records an activity row for every write', async () => {
    const party = await catalog.createParty({ name: 'Patel Tiles' }, actor);
    await catalog.updateParty(party.id, { name: 'Patel Tiles Ltd' }, actor);

    const entries = await db()('activity_log').where({ entity_type: 'party' }).orderBy('id');
    expect(entries.map((entry) => entry.action)).toEqual(['created', 'updated']);
  });
});
