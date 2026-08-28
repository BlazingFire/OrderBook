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

import type { Party, Product } from '@orderbook/shared';

import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
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
    { productCode: 'GLZ-100', name: 'Glazed Vitrified Tile', rate: 40_000, purchaseRate: 30_000 },
    admin,
  );
  const glossy = await catalog.createProduct(
    { productCode: 'GLS-200', name: 'Glossy Wall Tile', rate: 22_000 },
    admin,
  );
  const rustic = await catalog.createProduct(
    { productCode: 'RST-300', name: 'Rustic Floor Tile', rate: 18_000 },
    admin,
  );
  return { glazed, glossy, rustic };
}

async function pickProducts(term: string, actor = admin, include: string[] = []) {
  const page = (await search.pick('product', { term, include }, actor)) as {
    items: Product[];
    truncated: boolean;
  };
  return page;
}

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
    expect(page.items.map((item) => item.productCode)).toEqual(['GLZ-100']);
  });

  it('matches every typed word as a prefix', async () => {
    await seed();

    const page = await pickProducts('gl wa');
    expect(page.items.map((item) => item.productCode)).toEqual(['GLS-200']);
  });

  it('puts a code typed in full at the top', async () => {
    await seed();

    // The boost, and the reason it needs NULLS LAST: without it the rows whose
    // boost evaluates to NULL sort above the one that actually matched.
    const page = await pickProducts('RST-300');
    expect(page.items[0]?.productCode).toBe('RST-300');
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
    const codes = page.items.map((item) => item.productCode);

    expect(codes).toContain('GLZ-100');
    expect(codes).toContain('RST-300');
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

  it('masks the purchase rate it has no business showing', async () => {
    await seed();

    const desk = await actorWith(['products.view', 'field.saleRate.view']);
    const page = await pickProducts('gla', desk);

    expect('purchaseRate' in page.items[0]!).toBe(false);
    expect(page.items[0]?.rate).toBe(40_000);
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
    expect(page.items.map((item) => item.productCode)).toEqual(['GLZ-100']);
  });

  it('treats a term with nothing searchable in it as no filter at all', async () => {
    await seed();

    // Not "no results" — that is the difference that makes the idle pinned and
    // recent state work before anybody has typed a letter.
    expect((await pickProducts('%')).items).toHaveLength(3);
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
