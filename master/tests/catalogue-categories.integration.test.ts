/**
 * Categories as catalogue v2 reads them (`docs/catalogue/CATALOGUE_MODEL.md`
 * §1, §5): found by id, then code, then name — live rows only — created with
 * their code, brand and order, and listed in catalogue order.
 *
 * The owner's words are Product (a category) and Sub product (a model); the
 * code keeps its own names, so this file does too.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

function seed(seeds: productRepo.CategorySeed[]): Promise<Map<string, string>> {
  return db().transaction((trx) => productRepo.ensureCategories(actor.tenantId, seeds, trx));
}

function subProduct(name: string, category: { categoryId?: string; categoryCode?: string; categoryName?: string }, code: string) {
  return catalog.createProduct(
    { name, ...category, hasVariants: false, variants: [{ code }] },
    actor,
  );
}

describe.skipIf(!canRunIntegrationTests)('catalogue categories (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('CAT-1: creates missing categories with code, brand and order, keyed by code', async () => {
    const ids = await seed([
      { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+', sortOrder: 1 },
      { name: 'Wash Basin', code: 'WB', brand: 'Swisware+', sortOrder: 2 },
    ]);

    expect([...ids.keys()]).toEqual(['opt', 'wb']);
    const row = await db()('product_categories').where({ id: ids.get('opt') }).first();
    expect(row).toMatchObject({
      name: 'One Piece Toilet',
      code: 'OPT',
      brand: 'Swisware+',
      sort_order: 1,
    });
  });

  it('CAT-2: finds an existing category by code, then by (brand, name), and never changes it', async () => {
    const first = await seed([{ name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+', sortOrder: 1 }]);
    const again = await seed([
      { name: 'Renamed in the file', code: 'opt', brand: 'Swisware+', sortOrder: 9 },
      { name: 'one piece toilet', code: 'OPT9', brand: 'SWISWARE+' },
    ]);

    expect(again.get('opt')).toBe(first.get('opt'));
    expect(again.get('opt9')).toBe(first.get('opt'));
    expect(await db()('product_categories').count('* as n').first()).toMatchObject({ n: '1' });
    expect(await db()('product_categories').where({ id: first.get('opt') }).first()).toMatchObject({
      name: 'One Piece Toilet',
      code: 'OPT',
      sort_order: 1,
    });
  });

  it('CAT-3: a second brand gets its own category of the same name', async () => {
    const ids = await seed([
      { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+' },
      { name: 'One Piece Toilet', code: 'OPTB', brand: 'Other' },
    ]);

    expect(ids.get('opt')).not.toBe(ids.get('optb'));
  });

  it('CAT-4: a sub product resolves its category by code, and an unknown code creates nothing', async () => {
    const ids = await seed([{ name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+' }]);

    const made = await subProduct('102 (9")', { categoryCode: 'opt' }, 'OPT-0001');
    expect(made).toMatchObject({
      categoryId: ids.get('opt'),
      categoryName: 'One Piece Toilet',
      categoryCode: 'OPT',
      brand: 'Swisware+',
    });

    await expect(subProduct('1111', { categoryCode: 'NOPE' }, 'OPT-0002')).rejects.toThrow(
      /No product has the code NOPE/,
    );
    expect(await db()('product_categories').count('* as n').first()).toMatchObject({ n: '1' });
  });

  it('CAT-5: a category in the Recycle Bin is neither assignable by id nor matched by code or name', async () => {
    const ids = await seed([{ name: 'Urinal', code: 'UR' }]);
    const binned = ids.get('ur') as string;
    await db()('product_categories').where({ id: binned }).update({ deleted_at: db().fn.now() });

    await expect(subProduct('U-1', { categoryId: binned }, 'UR-0001')).rejects.toThrow(
      /Choose the product this sub product sits under/,
    );
    await expect(subProduct('U-1', { categoryCode: 'UR' }, 'UR-0001')).rejects.toThrow(
      /No product has the code UR/,
    );

    const byName = await subProduct('U-1', { categoryName: 'Urinal' }, 'UR-0001');
    expect(byName.categoryId).not.toBe(binned);
    expect(byName.categoryCode).toBeNull();
  });

  it('CAT-6: a name matches the brandless category before a branded one of the same name', async () => {
    const ids = await seed([
      { name: 'Wash Basin', code: 'WB', brand: 'Swisware+' },
      { name: 'Wash Basin' },
    ]);

    const made = await subProduct('14x14', { categoryName: 'wash basin' }, 'WB-0001');
    expect(made.categoryId).toBe(ids.get('wash basin'));
    expect(made.brand).toBeNull();
  });

  it('CAT-9: a name with a brand is the (brand, name) pair, and creates under that brand', async () => {
    const ids = await seed([
      { name: 'Wash Basin' },
      { name: 'Wash Basin', code: 'WB', brand: 'Swisware+' },
    ]);

    const matched = await catalog.createProduct(
      { name: '14x14', categoryName: 'wash basin', categoryBrand: 'SWISWARE+', hasVariants: false, variants: [{ code: 'WB-0001' }] },
      actor,
    );
    expect(matched.categoryId).toBe(ids.get('wb'));

    const created = await catalog.createProduct(
      { name: '16x12', categoryName: 'Wash Basin', categoryBrand: 'Other', hasVariants: false, variants: [{ code: 'WB-0002' }] },
      actor,
    );
    expect(created.categoryId).not.toBe(ids.get('wb'));
    expect(created.categoryId).not.toBe(ids.get('wash basin'));
    expect(created.brand).toBe('Other');
  });

  it('CAT-7: lists live categories in catalogue order, with their live sub-product counts', async () => {
    const ids = await seed([
      { name: 'Zeta', code: 'Z', brand: 'Swisware+', sortOrder: 1 },
      { name: 'Alpha', code: 'QX', brand: 'Other', sortOrder: 2 },
      { name: 'Unordered' },
      { name: 'Binned', code: 'B', sortOrder: 0 },
    ]);
    await db()('product_categories').where({ id: ids.get('b') }).update({ deleted_at: db().fn.now() });
    await subProduct('Z-1', { categoryCode: 'Z' }, 'Z-0001');
    const gone = await subProduct('Z-2', { categoryCode: 'Z' }, 'Z-0002');
    await db()('products').where({ id: gone.id }).update({ deleted_at: db().fn.now() });

    const listed = await productRepo.listCategories(actor.tenantId);
    expect(listed.map((row) => [row.name, row.subProductCount])).toEqual([
      ['Zeta', 1],
      ['Alpha', 0],
      ['Unordered', 0],
    ]);

    const byBrand = await productRepo.listCategories(actor.tenantId, db(), { brand: 'swisware+' });
    expect(byBrand.map((row) => row.code)).toEqual(['Z']);
    const byCode = await productRepo.listCategories(actor.tenantId, db(), { search: 'qx' });
    expect(byCode.map((row) => row.name)).toEqual(['Alpha']);
  });

  it('CAT-8: the product list carries and filters on the category code and brand', async () => {
    await seed([
      { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+' },
      { name: 'Wash Basin', code: 'WB', brand: 'Other' },
    ]);
    await catalog.createProduct(
      { name: '102 (9")', categoryCode: 'OPT', sortOrder: 1, hasVariants: true, variants: [{ code: 'OPT-0001', label: 'White' }] },
      actor,
    );
    await subProduct('14x14', { categoryCode: 'WB' }, 'WB-0001');

    const byBrand = await productRepo.listProducts(actor.tenantId, { brand: 'SWISWARE+', limit: 50, offset: 0 });
    expect(byBrand.items.map((item) => [item.name, item.categoryCode, item.brand, item.sortOrder])).toEqual([
      ['102 (9")', 'OPT', 'Swisware+', 1],
    ]);

    // Only the category carries the brand, so this finds it through the join.
    const byBrandSearch = await productRepo.listProducts(actor.tenantId, { search: 'other', limit: 50, offset: 0 });
    expect(byBrandSearch.items.map((item) => item.name)).toEqual(['14x14']);
  });
});
