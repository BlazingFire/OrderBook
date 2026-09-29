/**
 * The searchable picker's server half.
 *
 * Three things here are not obvious and all three were live defects in the
 * design before it was reviewed:
 *
 *  · **Prefix matching.** `websearch_to_tsquery` matches whole lexemes, so a
 *    picker built on `/search` shows nothing until the last letter of a word
 *    arrives. Nobody types like that.
 *  · **`NULLS LAST` on the prefix boost.** `false OR NULL` is `NULL`, and
 *    Postgres `DESC` puts nulls *first* — so without it the rows that do not
 *    match the prefix sort above the ones that do, which is precisely backwards.
 *  · **`include` outside the active guard.** The row already selected has to
 *    stay visible even when the term excludes it, or the field blanks itself
 *    while somebody is typing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Party, Product, ProductCategory } from '@orderbook/shared';

import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
import * as search from '../src/services/search.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';

let admin: ActorContext;

async function seed() {
  const glazed = await catalog.createProduct(
    {
      categoryName: 'Floor tiles',
      variants: [{ code: 'GLZ-100' }],
      name: 'Glazed Vitrified Tile',
    },
    admin,
  );
  const glossy = await catalog.createProduct(
    { categoryName: 'Wall tiles', variants: [{ code: 'GLS-200' }], name: 'Glossy Wall Tile' },
    admin,
  );
  const rustic = await catalog.createProduct(
    {
      categoryName: 'Floor tiles',
      name: 'Rustic Floor Tile',
      hasVariants: true,
      variants: [
        { code: 'RST-300', label: 'Terracotta' },
        { code: 'RST-301', label: 'Slate' },
      ],
    },
    admin,
  );
  return { glazed, glossy, rustic };
}

async function pickProducts(
  term: string,
  actor = admin,
  include: string[] = [],
  categoryId?: string,
) {
  const page = (await search.pick('product', { term, include, categoryId }, actor)) as {
    items: Product[];
    truncated: boolean;
  };
  return page;
}

const codesOf = (page: { items: Product[] }) =>
  page.items.map((item) => item.variants.map((variant) => variant.code).join(','));

describe.skipIf(!canRunIntegrationTests)('the picker (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('matches on a prefix, before the word is finished', async () => {
    await seed();

    const page = await pickProducts('gla');
    expect(codesOf(page)).toEqual(['GLZ-100']);
  });

  it('matches every typed word as a prefix', async () => {
    await seed();

    const page = await pickProducts('gl wa');
    expect(codesOf(page)).toEqual(['GLS-200']);
  });

  it('puts a code typed in full at the top', async () => {
    await seed();

    // The boost, and the reason it needs NULLS LAST: without it the rows whose
    // boost evaluates to NULL sort above the one that actually matched.
    const page = await pickProducts('RST-300');
    expect(page.items[0]?.name).toBe('Rustic Floor Tile');
  });

  it('finds a model by any of its variant codes, and hands the variants back with it', async () => {
    await seed();

    const page = await pickProducts('RST-301');
    expect(page.items.map((item) => item.name)).toEqual(['Rustic Floor Tile']);
    expect(page.items[0]?.variants.map((variant) => [variant.code, variant.label])).toEqual([
      ['RST-300', 'Terracotta'],
      ['RST-301', 'Slate'],
    ]);
  });

  it('scopes the second stage of the lead search to the chosen category', async () => {
    const { glazed } = await seed();

    const page = await pickProducts('', admin, [], glazed.categoryId);
    expect(page.items.map((item) => item.name).sort()).toEqual([
      'Glazed Vitrified Tile',
      'Rustic Floor Tile',
    ]);
    // A term that would match a product in another category finds nothing here.
    expect((await pickProducts('glossy', admin, [], glazed.categoryId)).items).toHaveLength(0);
  });

  it('returns everything when nothing has been typed yet', async () => {
    await seed();

    // The idle state. A term with nothing searchable in it means "no text
    // filter", not "no results" — which is what makes pinned and recent rows
    // work before anybody types.
    const page = await pickProducts('   ');
    expect(page.items).toHaveLength(3);
  });

  it('keeps an included row even when the term excludes it', async () => {
    const { rustic } = await seed();

    const page = await pickProducts('gla', admin, [rustic.id]);
    const codes = codesOf(page);

    expect(codes).toContain('GLZ-100');
    expect(codes).toContain('RST-300,RST-301');
  });

  it('keeps an included row that has since been deleted', async () => {
    const { rustic } = await seed();
    await catalog.deleteProduct(rustic.id, admin);

    // A selection made before somebody archived the product must still render.
    // The alternative is a field that silently blanks itself.
    const page = await pickProducts('', admin, [rustic.id]);
    expect(page.items.map((item) => item.id)).toContain(rustic.id);
  });

  it('says when it stopped counting', async () => {
    await seed();

    const page = (await search.pick('product', { term: '', limit: 2 }, admin)) as {
      items: Product[];
      truncated: boolean;
    };

    expect(page.items).toHaveLength(2);
    // A picker that silently shows the first two of three teaches people that
    // the thing they want is not there.
    expect(page.truncated).toBe(true);
  });

  it('refuses rather than answering an empty list', async () => {
    await seed();

    // An empty list would read as "there are none", which is a different and
    // wrong statement from "you may not look".
    const nobody = await actorWith(['leads.view']);
    await expect(search.pick('product', { term: 'gla' }, nobody)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('does not let a wildcard in the term widen the match', async () => {
    await seed();

    // Real product codes and tile sizes contain `%` and `_`, and both are LIKE
    // wildcards. Unescaped, the prefix boost would match the whole catalogue.
    const page = await pickProducts('GLZ%');
    expect(codesOf(page)).toEqual(['GLZ-100']);
  });

  it('treats a term with nothing searchable in it as no filter at all', async () => {
    await seed();

    // Not "no results" — that is the difference that makes the idle pinned and
    // recent state work before anybody has typed a letter.
    expect((await pickProducts('%')).items).toHaveLength(3);
  });

  describe('categories', () => {
    it('offers categories only — typing "tile" never surfaces a product', async () => {
      await seed();

      const page = (await search.pick('category', { term: 'tile' }, admin)) as {
        items: ProductCategory[];
        truncated: boolean;
      };

      expect(page.items.map((item) => item.name)).toEqual(['Floor tiles', 'Wall tiles']);
    });

    it('puts a category whose name starts with the term first', async () => {
      await seed();

      const page = (await search.pick('category', { term: 'wall' }, admin)) as {
        items: ProductCategory[];
        truncated: boolean;
      };

      expect(page.items.map((item) => item.name)).toEqual(['Wall tiles']);
    });

    it('lists every category when nothing has been typed', async () => {
      await seed();

      const page = (await search.pick('category', { term: '' }, admin)) as {
        items: ProductCategory[];
        truncated: boolean;
      };

      expect(page.items.map((item) => item.name)).toEqual(['Floor tiles', 'Wall tiles']);
    });

    it('sits behind the catalogue permission', async () => {
      await seed();

      const nobody = await actorWith(['leads.view']);
      await expect(search.pick('category', { term: '' }, nobody)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  /*
   * Catalogue v2 (`docs/catalogue/CATALOGUE_MODEL.md` §5): the product bar
   * matches a code from its start, a name or a brand, a code typed in full
   * first and the rest in catalogue order; the sub-product bar lists every
   * sub product of the chosen product in catalogue order.
   */
  describe('the product and sub-product bars', () => {
    async function catalogue() {
      await fields.createValue(
        { listKey: 'product.brand', value: 'Swisware+', label: 'Swisware+', hex: null },
        admin,
      );
      await fields.createValue(
        { listKey: 'product.brand', value: 'Other', label: 'Other', hex: null },
        admin,
      );
      const make = async (code: string, name: string, sortOrder: number, brand = 'Swisware+') => {
        const category = await catalog.createCategory({ code, name, brand, sortOrder }, admin);
        await catalog.createProduct(
          { name: `${code} one`, categoryId: category.id, variants: [{ code: '' }] },
          admin,
        );
        return category;
      };
      // Created out of catalogue order, so the order below is sort_order's.
      const wc = await make('WC', 'Water Closet', 3, 'Other');
      const opb = await make('OPB', 'One Piece Basin', 2);
      const opt = await make('OPT', 'One Piece Toilet', 1);
      // `OP` is a prefix of both codes above, and last in the catalogue.
      await make('OP', 'Orissa Pan', 4);
      return { wc, opb, opt };
    }

    const categoriesFor = async (term: string) =>
      ((await search.pick('category', { term }, admin)) as { items: ProductCategory[] }).items.map(
        (item) => item.code,
      );

    it('offers products in catalogue order, a code typed in full first', async () => {
      await catalogue();

      expect(await categoriesFor('')).toEqual(['OPT', 'OPB', 'WC', 'OP']);
      // A code typed in full outranks catalogue order; the rest keep it.
      expect(await categoriesFor('op')).toEqual(['OP', 'OPT', 'OPB']);
      expect(await categoriesFor('opb')).toEqual(['OPB']);
      expect(await categoriesFor('wc')).toEqual(['WC']);
      expect(await categoriesFor('piece')).toEqual(['OPT', 'OPB']);
      expect(await categoriesFor('other')).toEqual(['WC']);

      const [row] = (
        (await search.pick('category', { term: 'wc' }, admin)) as { items: ProductCategory[] }
      ).items;
      expect(row).toMatchObject({ code: 'WC', brand: 'Other', sortOrder: 3 });
    });

    it('never offers a product from the Recycle Bin', async () => {
      const { wc } = await catalogue();
      const [closet] = (await catalog.listProducts({ categoryId: wc.id }, admin)).items;
      await catalog.deleteProduct(closet!.id, admin);
      await catalog.deleteCategory(wc.id, admin);

      expect(await categoriesFor('')).toEqual(['OPT', 'OPB', 'OP']);
    });

    it('lists every sub product of the chosen product, in catalogue order, carrying code and brand', async () => {
      const { opt } = await catalogue();
      // Sixty, past the old 50 cap, added last-first.
      for (let at = 60; at >= 2; at -= 1) {
        await catalog.createProduct(
          { name: `${1100 + at}`, categoryId: opt.id, sortOrder: at, variants: [{ code: '' }] },
          admin,
        );
      }
      await db()('products').where({ name: 'OPT one' }).update({ sort_order: 1 });

      const page = (await search.pick('product', { term: '', categoryId: opt.id }, admin)) as {
        items: Product[];
        truncated: boolean;
      };
      expect(page.truncated).toBe(false);
      expect(page.items).toHaveLength(60);
      expect(page.items.map((item) => item.sortOrder)).toEqual(
        Array.from({ length: 60 }, (_, at) => at + 1),
      );
      expect(page.items[0]).toMatchObject({
        name: 'OPT one',
        categoryCode: 'OPT',
        brand: 'Swisware+',
      });
      expect(page.items[0]?.variants.map((variant) => variant.code)).toEqual(['OPT-0001']);

      // Narrowed by the name anywhere, or a code from its start — still in order.
      const narrowed = (await search.pick(
        'product',
        { term: '115', categoryId: opt.id },
        admin,
      )) as {
        items: Product[];
      };
      expect(narrowed.items.map((item) => item.name)).toEqual([
        '1115',
        ...Array.from({ length: 10 }, (_, at) => `${1150 + at}`),
      ]);
      const byCode = (await search.pick(
        'product',
        { term: 'OPT-0060', categoryId: opt.id },
        admin,
      )) as {
        items: Product[];
      };
      expect(byCode.items.map((item) => item.name)).toEqual(['1102']);

      // A caller that asks for fewer still gets fewer, and is told.
      const few = (await search.pick(
        'product',
        { term: '', categoryId: opt.id, limit: 5 },
        admin,
      )) as {
        items: Product[];
        truncated: boolean;
      };
      expect([few.items.length, few.truncated]).toEqual([5, true]);
    });
  });

  describe('parties', () => {
    it('finds a party by a prefix of its name', async () => {
      await catalog.createParty({ name: 'Patel Tiles' }, admin);
      await catalog.createParty({ name: 'Shree Ceramics' }, admin);

      const page = (await search.pick('party', { term: 'pat' }, admin)) as {
        items: Party[];
        truncated: boolean;
      };

      expect(page.items.map((item) => item.name)).toEqual(['Patel Tiles']);
    });
  });
});
