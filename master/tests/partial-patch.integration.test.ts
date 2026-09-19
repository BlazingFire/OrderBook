/**
 * An update must touch only the fields it asserts.
 *
 * `columnsFrom()` in both the product and party repositories used to enumerate
 * every column with `?? null` and spread the result straight into `.update()`,
 * which made an update a full record replace. The only product form in the app
 * edits 8 of ~20 columns, so saving it nulled the twelve it does not know
 * about; the 5-field party drawer did the same to six party columns.
 *
 * These tests fail if that behaviour ever returns. They deliberately assert on
 * the columns no form currently edits, because those are the ones a partial
 * patch exists to protect.
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
    /** Every column the shipped 8-field drawer does not send. */
    const fullProduct = {
      categoryName: 'Floor tiles',
      variants: [{ code: 'GVT-600', weightKg: 28.5 }],
      name: 'Glazed Vitrified 600x600',
      alias: 'GVT 600',
      size: '600x600',
      sin: 'SIN-11',
      grade: 'Premium',
      productType: 'Floor',
      finish: 'Glossy',
      series: 'Marble Look',
      thicknessMm: 9.2,
      piecesPerBox: 4,
      boxCoverageSqft: 15.5,
      rate: 42_000,
      pricePerSqft: 2_700,
      hsnCode: '69072100',
      parameters: { waterAbsorption: '0.5%' },
      customFields: { plant: 'Morbi 2' },
    };

    it('leaves every unasserted column intact when only the name changes', async () => {
      const created = await catalog.createProduct(fullProduct, actor);

      // Exactly what the 8-field drawer sends — note the twelve absent keys.
      const after = await catalog.updateProduct(
        created.id,
        {
          name: 'Glazed Vitrified 600x600 (v2)',
          alias: 'GVT 600',
          size: '600x600',
          sin: 'SIN-11',
          grade: 'Premium',
          productType: 'Floor',
          rate: 42_000,
        },
        actor,
      );

      expect(after.name).toBe('Glazed Vitrified 600x600 (v2)');
      expect(after.finish).toBe('Glossy');
      expect(after.series).toBe('Marble Look');
      expect(after.thicknessMm).toBe(9.2);
      // The variant set was not named either, so it stays: the code and the weight.
      expect(after.variants.map((variant) => [variant.code, variant.weightKg])).toEqual([['GVT-600', 28.5]]);
      expect(after.piecesPerBox).toBe(4);
      expect(after.boxCoverageSqft).toBe(15.5);
      expect(after.pricePerSqft).toBe(2_700);
      expect(after.hsnCode).toBe('69072100');
      expect(after.parameters).toEqual({ waterAbsorption: '0.5%' });
      expect(after.customFields).toEqual({ plant: 'Morbi 2' });
    });

    it('still clears a column when the caller explicitly sends null', async () => {
      const created = await catalog.createProduct(fullProduct, actor);

      const after = await catalog.updateProduct(
        created.id,
        { name: fullProduct.name, finish: null },
        actor,
      );

      expect(after.finish).toBeNull();
      // …and the neighbours it did not name are still untouched.
      expect(after.series).toBe('Marble Look');
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
