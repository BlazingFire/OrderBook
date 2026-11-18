/**
 * A sub product's own code, weight, colours and print side — what the
 * catalogue service accepts and stores now that the variant layer is gone
 * (2026-11-16; this file replaces `product-variants.integration.test.ts`).
 *
 * The rules under test (`shared/src/domain/product-validation.ts` and
 * `catalog.service.ts`):
 *
 *   · every sub product carries one software code, unique across the shop
 *     (case-insensitively), generated as the next `CODE-####` of its
 *     product when the form leaves it blank;
 *   · a weight is either unknown or greater than zero;
 *   · the colours are the list it is offered in — each real text, once;
 *   · the print side is `default`, `left` or `right`, and starts at
 *     `default` for every sub product;
 *   · an input in the old variant shape (a panel built before the removal)
 *     is read as the sub product it always described.
 *
 * Binning and restoring, where codes are freed and reclaimed, is also
 * covered by `recycle-bin.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';

let actor: ActorContext;

const CATEGORY = 'ONE PIECE BASIN';

describe.skipIf(!canRunIntegrationTests)('sub product code, colours and print side (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('stores the code, weight, colours and print side on the sub product itself', async () => {
    const product = await catalog.createProduct(
      {
        name: '102',
        categoryName: 'ONE PIECE TOILET',
        code: 'OPT-0102',
        weightKg: 32.5,
        colours: ['White'],
        printSide: 'right',
      },
      actor,
    );

    expect(product.code).toBe('OPT-0102');
    expect(product.weightKg).toBe(32.5);
    expect(product.colours).toEqual(['White']);
    expect(product.printSide).toBe('right');
  });

  it('defaults to no colours and the Default print side', async () => {
    const product = await catalog.createProduct(
      { name: '1111', categoryName: CATEGORY, code: 'D-1111' },
      actor,
    );

    expect(product.colours).toEqual([]);
    expect(product.printSide).toBe('default');
    expect(product.weightKg).toBeNull();
  });

  it("generates the next code in its product's sequence when none is given", async () => {
    const category = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT' }, actor);

    const first = await catalog.createProduct(
      { name: '102', categoryId: category.id },
      actor,
    );
    const second = await catalog.createProduct(
      { name: '103', categoryId: category.id },
      actor,
    );

    expect(first.code).toBe('OPT-0001');
    expect(second.code).toBe('OPT-0002');
  });

  it('refuses a duplicate code across sub products, whatever the case', async () => {
    await catalog.createProduct({ name: 'One', categoryName: CATEGORY, code: 'DAM-41' }, actor);
    await expect(
      catalog.createProduct({ name: 'Two', categoryName: CATEGORY, code: 'dam-41' }, actor),
    ).rejects.toThrow();
  });

  it('refuses an edit onto a code another sub product holds, and leaves it as it was', async () => {
    await catalog.createProduct({ name: 'One', categoryName: CATEGORY, code: 'DAM-41' }, actor);
    const two = await catalog.createProduct(
      { name: 'Two', categoryName: CATEGORY, code: 'DAM-42' },
      actor,
    );

    await expect(
      catalog.updateProduct(two.id, { name: 'Two', code: 'DAM-41' }, actor),
    ).rejects.toThrow();

    const after = await catalog.findProductByCode('DAM-42', actor);
    expect(after?.id).toBe(two.id);
  });

  it('refuses a weight of zero or less, and keeps an unknown weight as null rather than zero', async () => {
    await expect(
      catalog.createProduct(
        { name: 'Zero', categoryName: CATEGORY, code: 'W-0', weightKg: 0 },
        actor,
      ),
    ).rejects.toThrow();
    await expect(
      catalog.createProduct(
        { name: 'Negative', categoryName: CATEGORY, code: 'W-1', weightKg: -1 },
        actor,
      ),
    ).rejects.toThrow();

    const product = await catalog.createProduct(
      { name: 'Unweighed', categoryName: CATEGORY, code: 'W-2' },
      actor,
    );
    expect(product.weightKg).toBeNull();
  });

  it('refuses a colour named twice, whatever the case, and a blank colour', async () => {
    await expect(
      catalog.createProduct(
        { name: 'Twice', categoryName: CATEGORY, code: 'C-1', colours: ['White', 'white'] },
        actor,
      ),
    ).rejects.toThrow();
    await expect(
      catalog.createProduct(
        { name: 'Blank', categoryName: CATEGORY, code: 'C-2', colours: ['  '] },
        actor,
      ),
    ).rejects.toThrow();
  });

  it('refuses a print side that is not Default, Left or Right', async () => {
    await expect(
      catalog.createProduct(
        {
          name: 'Middle',
          categoryName: CATEGORY,
          code: 'PS-1',
          printSide: 'middle' as never,
        },
        actor,
      ),
    ).rejects.toThrow();
  });

  it('resolves a sub product from its code, case-insensitively', async () => {
    const product = await catalog.createProduct(
      { name: 'DAMRU', categoryName: CATEGORY, code: 'DAMRU-WHITE', colours: ['White'] },
      actor,
    );

    expect((await catalog.findProductByCode('damru-white', actor))?.id).toBe(product.id);
    expect(await catalog.findProductByCode('NOPE', actor)).toBeNull();
  });

  it('replaces the colour list whole on an edit, and moves the print side alone', async () => {
    const product = await catalog.createProduct(
      { name: 'Pan', categoryName: CATEGORY, code: 'P-1', colours: ['White'] },
      actor,
    );

    const recoloured = await catalog.updateProduct(
      product.id,
      { name: 'Pan', colours: ['White', 'Ivory'] },
      actor,
    );
    expect(recoloured.colours).toEqual(['White', 'Ivory']);
    expect(recoloured.code).toBe('P-1');

    const sided = await catalog.updateProduct(
      product.id,
      { name: 'Pan', printSide: 'left' },
      actor,
    );
    expect(sided.printSide).toBe('left');
    expect(sided.colours).toEqual(['White', 'Ivory']);
  });

  it('reads a pre-removal variants input as code, weight and colours', async () => {
    const product = await catalog.createProduct(
      {
        name: 'Legacy',
        categoryName: CATEGORY,
        variants: [
          { code: 'L-1', label: 'White', weightKg: 5 },
          { code: 'L-2', label: 'Ivory', weightKg: 6 },
        ],
      } as never,
      actor,
    );

    expect(product.code).toBe('L-1');
    expect(product.weightKg).toBe(5);
    expect(product.colours).toEqual(['White', 'Ivory']);
  });

  it('refuses to restore a sub product whose code another took while it was binned', async () => {
    const first = await catalog.createProduct(
      { name: 'First', categoryName: CATEGORY, code: 'BIN-1' },
      actor,
    );
    await catalog.deleteProduct(first.id, actor);
    await catalog.createProduct({ name: 'Second', categoryName: CATEGORY, code: 'BIN-1' }, actor);

    await expect(catalog.restoreProduct(first.id, actor)).rejects.toThrow(/BIN-1/);
  });
});
