/**
 * The product master's fields, and the two ways they could have gone quietly
 * wrong.
 *
 * 1. **A partial write clearing what it was not asked about.** Setting the
 *    reorder level must not null the min and max the screen has never heard of.
 * 2. **A CHECK violation on the offline merge path.** That path has no
 *    validation layer; a constraint error there is recorded as a permanent
 *    rejection and replayed forever, so an offline edit would be destroyed
 *    rather than bounced with a reason. The shared validator runs first.
 *
 * The master is small on purpose (2026-09-21): name, category, alias, size,
 * and the sub product's own code, colours, weight and print side. Nothing
 * else is stored, so nothing else is tested here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { ValidationError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let admin: ActorContext;

async function seedProduct() {
  return catalog.createProduct(
    {
      categoryName: 'WATER CLOSET',
      code: 'EWC-S-TRAP', weightKg: 22,
      name: 'E.W.C - S TRAP',
      alias: 'EWC S',
      size: 'S trap',
      colours: ['White', 'Ivory'],
    },
    admin,
  );
}

describe.skipIf(!canRunIntegrationTests)('product attributes (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('stores every field and reads it back', async () => {
    const product = await seedProduct();

    expect(product).toMatchObject({
      name: 'E.W.C - S TRAP',
      categoryName: 'WATER CLOSET',
      alias: 'EWC S',
      size: 'S trap',
      code: 'EWC-S-TRAP',
      weightKg: 22,
      colours: ['White', 'Ivory'],
      printSide: 'default',
    });
  });

  it('defaults to no colours and the Default print side', async () => {
    const product = await catalog.createProduct(
      { categoryName: 'ONE PIECE TOILET', code: '102', name: '102' },
      admin,
    );
    expect(product.colours).toEqual([]);
    expect(product.printSide).toBe('default');
  });

  describe('validation refuses a bad value before the database does', () => {
    it.each([
      ['a weight of zero', { code: 'BAD-1', weightKg: 0 }],
      ['a negative weight', { code: 'BAD-2', weightKg: -3 }],
      ['a colour named twice', { code: 'BAD-3', colours: ['White', 'white'] }],
      ['a print side that is none of the three', { code: 'BAD-4', printSide: 'middle' as never }],
    ])('refuses %s with a readable message', async (_case, fields) => {
      await expect(
        catalog.createProduct({ categoryName: 'Tiles', name: 'Bad Tile', ...fields }, admin),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('search', () => {
    it('finds a product by its alias and its size', async () => {
      await seedProduct();

      expect((await catalog.listProducts({ search: 'EWC S' }, admin)).items).toHaveLength(1);
      expect((await catalog.listProducts({ search: 'S trap' }, admin)).items).toHaveLength(1);
    });
  });
});
