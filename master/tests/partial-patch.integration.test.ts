/**
 * An update must touch only the fields it asserts.
 *
 * `columnsFrom()` in both the product and party repositories used to enumerate
 * every column with `?? null` and spread the result straight into `.update()`,
 * which made an update a full record replace. The product form saved a subset
 * of the columns, so saving it nulled the ones it does not know about; the
 * 5-field party drawer did the same to six party columns.
 *
 * These tests fail if that behaviour ever returns. They deliberately assert on
 * the columns a narrow patch does not name, because those are the ones a
 * partial patch exists to protect.
 *
 * See `shared/src/domain/columns.ts` for the contract: **`undefined` means not
 * asserted, `null` means clear it.**
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('partial patch semantics (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('products', () => {
    /** Every product column, filled. */
    const fullProduct = {
      categoryName: 'PLAIN SET',
      variants: [{ code: 'GOLDEN-SET-WHITE', weightKg: 28.5 }],
      name: 'GOLDEN SET',
      alias: 'Golden',
      size: '18x14',
      multiColour: true,
      customFields: { plant: 'Thangadh 2' },
    };

    it('leaves every unasserted column intact when only the name changes', async () => {
      const created = await catalog.createProduct(fullProduct, actor);

      // A one-field patch — note the absent keys.
      const after = await catalog.updateProduct(created.id, { name: 'GOLDEN SET (v2)' }, actor);

      expect(after.name).toBe('GOLDEN SET (v2)');
      expect(after.alias).toBe('Golden');
      expect(after.size).toBe('18x14');
      expect(after.multiColour).toBe(true);
      // The variant set was not named either, so it stays: the code and the weight.
      expect(after.variants.map((variant) => [variant.code, variant.weightKg])).toEqual([['GOLDEN-SET-WHITE', 28.5]]);
      expect(after.customFields).toEqual({ plant: 'Thangadh 2' });
    });

    it('still clears a column when the caller explicitly sends null', async () => {
      const created = await catalog.createProduct(fullProduct, actor);

      const after = await catalog.updateProduct(
        created.id,
        { name: fullProduct.name, alias: null, multiColour: false },
        actor,
      );

      expect(after.alias).toBeNull();
      expect(after.multiColour).toBe(false);
      // …and the neighbours it did not name are still untouched.
      expect(after.size).toBe('18x14');
    });
  });

  describe('parties', () => {
    const fullParty = {
      name: 'Patel Tiles',
      phone: '9876543210',
      altPhone: '9123456780',
      email: 'accounts@pateltiles.example',
      addressLine1: 'Plot 42, Ceramic Zone',
      addressLine2: 'Near GIDC Gate 3',
      city: 'Morbi',
      state: 'Gujarat',
      pincode: '363641',
      gstNumber: '24AAACP1234A1ZQ',
      notes: 'Pays on delivery.',
      customFields: { route: 'North' },
    };

    it('leaves every unasserted column intact when only the name changes', async () => {
      const created = await catalog.createParty(fullParty, actor);

      // Exactly what the 5-field drawer sends.
      const after = await catalog.updateParty(
        created.id,
        {
          name: 'Patel Tiles & Sons',
          phone: '9876543210',
          city: 'Morbi',
          gstNumber: '24AAACP1234A1ZQ',
          notes: 'Pays on delivery.',
        },
        actor,
      );

      expect(after.name).toBe('Patel Tiles & Sons');
      expect(after.altPhone).toBe('9123456780');
      expect(after.email).toBe('accounts@pateltiles.example');
      expect(after.addressLine1).toBe('Plot 42, Ceramic Zone');
      expect(after.addressLine2).toBe('Near GIDC Gate 3');
      expect(after.state).toBe('Gujarat');
      expect(after.pincode).toBe('363641');
      expect(after.customFields).toEqual({ route: 'North' });
    });
  });
});
