/**
 * The variant set as one field of a product: what the catalogue service
 * accepts, and how `replaceVariants` reconciles the rows the form sends with
 * the rows the database holds.
 *
 * The rules under test (`shared/src/domain/product-validation.ts` and
 * `product-variant.repository.ts`):
 *
 *   · a product has at least one variant, and one without colour or pattern
 *     choices has exactly one, unlabelled;
 *   · every variant has a code, unique across the shop; every labelled variant
 *     has a label unique within its model;
 *   · a weight is either unknown or greater than zero;
 *   · a saved row keeps its id — matched by id, or by label when the form
 *     did not send one — because lines point at it;
 *   · a row taken off the form is deleted, unless history quotes it, in which
 *     case it is deactivated and stays readable.
 *
 * Binning and restoring a product, which is where codes are freed and
 * reclaimed, is covered by `recycle-bin.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';

let actor: ActorContext;

const CATEGORY = 'ONE PIECE BASIN';

async function damru() {
  return catalog.createProduct(
    {
      name: 'DAMRU',
      categoryName: CATEGORY,
      hasVariants: true,
      variants: [
        { code: '41', label: 'Vitrosa 41', weightKg: 18.5 },
        { code: '42', label: 'Vitrosa 42', weightKg: 18.5 },
        { code: 'DAMRU-WHITE', label: 'White' },
      ],
    },
    actor,
  );
}

const codesOf = (variants: Array<{ code: string }>) => variants.map((variant) => variant.code);

describe.skipIf(!canRunIntegrationTests)('product variants (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('what a variant set may look like', () => {
    it('gives a no-variant product exactly one unlabelled row that carries its code and weight', async () => {
      const product = await catalog.createProduct(
        { name: '102', categoryName: 'ONE PIECE TOILET', variants: [{ code: '102', weightKg: 32.5 }] },
        actor,
      );

      expect(product.hasVariants).toBe(false);
      expect(product.variants).toHaveLength(1);
      expect(product.variants[0]).toMatchObject({
        productId: product.id,
        code: '102',
        label: null,
        weightKg: 32.5,
        sequence: 1,
        isActive: true,
      });
      expect(product.variants[0]!.id).toMatch(/^VR\d{10}$/);
    });

    it('infers "has variants" from a labelled row when the form did not say', async () => {
      const product = await catalog.createProduct(
        {
          name: 'NOVA',
          categoryName: CATEGORY,
          variants: [
            { code: '150', label: 'Vitrosa 150' },
            { code: 'NOVA-WHITE', label: 'White' },
          ],
        },
        actor,
      );

      expect(product.hasVariants).toBe(true);
      expect(product.variants.map((variant) => [variant.code, variant.label, variant.sequence])).toEqual([
        ['150', 'Vitrosa 150', 1],
        ['NOVA-WHITE', 'White', 2],
      ]);
    });

    it('refuses a labelled row on a product declared to have no variants, and a blank label on one that does', async () => {
      await expect(
        catalog.createProduct(
          {
            name: 'Plain',
            categoryName: CATEGORY,
            hasVariants: false,
            variants: [{ code: 'P-1', label: 'White' }],
          },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.product.variantLabelUnexpected' });

      // A variant's colour may be blank, and several variants may be: only the code is required.
      const blank = await catalog.createProduct(
        {
          name: 'Model',
          categoryName: CATEGORY,
          hasVariants: true,
          variants: [
            { code: 'M-1', label: 'White' },
            { code: 'M-2', label: '   ' },
            { code: 'M-3', label: '' },
          ],
        },
        actor,
      );
      expect(blank.variants.map((v) => v.code)).toEqual(['M-1', 'M-2', 'M-3']);

      await expect(
        catalog.createProduct(
          {
            name: 'Model 2',
            categoryName: CATEGORY,
            hasVariants: true,
            variants: [{ code: '', label: 'White' }],
          },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.product.variantCodeRequired' });
    });

    it('refuses two rows with the same label on one model, whatever the case', async () => {
      await expect(
        catalog.createProduct(
          {
            name: 'Model',
            categoryName: CATEGORY,
            hasVariants: true,
            variants: [{ code: 'M-1', label: 'White' }, { code: 'M-2', label: 'WHITE ' }],
          },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.product.variantLabelDuplicate' });
    });

    it('refuses the same code twice in one set, and a blank code', async () => {
      await expect(
        catalog.createProduct(
          {
            name: 'Model',
            categoryName: CATEGORY,
            hasVariants: true,
            variants: [{ code: 'M-1', label: 'White' }, { code: 'm-1', label: 'Blue' }],
          },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.product.variantCodeDuplicate' });

      await expect(
        catalog.createProduct(
          { name: 'Plain', categoryName: CATEGORY, variants: [{ code: '  ' }] },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.product.variantCodeRequired' });
    });

    it('refuses a weight of zero or less, and keeps an unknown weight as null rather than zero', async () => {
      await expect(
        catalog.createProduct(
          { name: 'Plain', categoryName: CATEGORY, variants: [{ code: 'P-1', weightKg: 0 }] },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.product.weightPositive' });

      const product = await catalog.createProduct(
        { name: 'Plain', categoryName: CATEGORY, variants: [{ code: 'P-1' }] },
        actor,
      );
      expect(product.variants[0]!.weightKg).toBeNull();
    });

    it('refuses a product with no variant set at all', async () => {
      await expect(
        catalog.createProduct({ name: 'Nothing', categoryName: CATEGORY, variants: [] }, actor),
      ).rejects.toMatchObject({ messageKey: 'validation.product.variantRequired' });
    });

    it('resolves a product from any of its variant codes, case-insensitively', async () => {
      const product = await damru();

      expect((await catalog.findProductByCode('42', actor))?.id).toBe(product.id);
      expect((await catalog.findProductByCode('damru-white', actor))?.id).toBe(product.id);
      expect(await catalog.findProductByCode('43', actor)).toBeNull();
    });
  });

  describe('editing the set', () => {
    it('keeps the ids of rows sent back with their id, and gives new rows fresh ones', async () => {
      const product = await damru();
      const [v41, v42, white] = product.variants;

      const updated = await catalog.updateProduct(
        product.id,
        {
          name: product.name,
          variants: [
            { id: v41!.id, code: '41', label: 'Vitrosa 41', weightKg: 19 },
            { id: v42!.id, code: '42', label: 'Vitrosa 42', weightKg: 18.5 },
            { id: white!.id, code: 'DAMRU-WHITE', label: 'White', weightKg: 17 },
            { code: '43', label: 'Vitrosa 43' },
          ],
        },
        actor,
      );

      expect(updated.variants.map((variant) => variant.id).slice(0, 3)).toEqual([
        v41!.id,
        v42!.id,
        white!.id,
      ]);
      expect(updated.variants[0]!.weightKg).toBe(19);
      expect(updated.variants[2]!.weightKg).toBe(17);
      expect(updated.variants[3]).toMatchObject({ code: '43', label: 'Vitrosa 43', sequence: 4 });
      expect(updated.variants[3]!.id).not.toBe(v41!.id);
      expect(updated.sync.fieldHlc.variants).toBeDefined();
    });

    it('matches a row sent without an id by its label, so a re-sent form does not duplicate rows', async () => {
      const product = await damru();
      const white = product.variants.find((variant) => variant.label === 'White')!;

      const updated = await catalog.updateProduct(
        product.id,
        {
          name: product.name,
          variants: [
            { code: '41', label: 'Vitrosa 41' },
            { code: '42', label: 'Vitrosa 42' },
            { code: 'DAMRU-W', label: 'white' },
          ],
        },
        actor,
      );

      expect(updated.variants).toHaveLength(3);
      const stillWhite = updated.variants.find((variant) => variant.id === white.id);
      expect(stillWhite).toMatchObject({ code: 'DAMRU-W', label: 'white' });
    });

    it('lets two rows swap labels, and two rows swap codes, in one save', async () => {
      const product = await damru();
      const [v41, v42] = product.variants;

      const updated = await catalog.updateProduct(
        product.id,
        {
          name: product.name,
          variants: [
            { id: v41!.id, code: '42', label: 'Vitrosa 42' },
            { id: v42!.id, code: '41', label: 'Vitrosa 41' },
            { code: 'DAMRU-WHITE', label: 'White' },
          ],
        },
        actor,
      );

      expect(updated.variants.find((variant) => variant.id === v41!.id)).toMatchObject({
        code: '42',
        label: 'Vitrosa 42',
      });
      expect(updated.variants.find((variant) => variant.id === v42!.id)).toMatchObject({
        code: '41',
        label: 'Vitrosa 41',
      });
    });

    it('deletes a removed row nothing points at', async () => {
      const product = await damru();
      const [v41] = product.variants;

      const updated = await catalog.updateProduct(
        product.id,
        { name: product.name, variants: [{ id: v41!.id, code: '41', label: 'Vitrosa 41' }] },
        actor,
      );

      expect(codesOf(updated.variants)).toEqual(['41']);
      // ...and its code is free again.
      const other = await catalog.createProduct(
        { name: 'Other', categoryName: CATEGORY, variants: [{ code: '42' }] },
        actor,
      );
      expect(other.variants[0]!.code).toBe('42');
    });

    it('deletes a removed row that only the retired stock tables mention (R15)', async () => {
      const product = await damru();
      const [v41, v42] = product.variants;
      // What a database from before 1.4 may hold for a colour that carried stock:
      // stock and its movements, each foreign-keyed to the variant, none read now.
      // (A reservation needs an order whose line quotes the variant, which keeps it in use.)
      await db()('inventory_stock').insert({
        id: randomUUID(),
        tenant_id: actor.tenantId,
        product_id: product.id,
        variant_id: v42!.id,
        quantity_boxes: 12,
      });
      await db()('stock_movements').insert({
        tenant_id: actor.tenantId,
        product_id: product.id,
        variant_id: v42!.id,
        movement_type: 'inbound',
        quantity_boxes: 12,
      });
      const updated = await catalog.updateProduct(
        product.id,
        { name: product.name, variants: [{ id: v41!.id, code: '41', label: 'Vitrosa 41' }] },
        actor,
      );

      // Deleted, not merely deactivated: old stock does not make a variant "in use".
      expect(updated.variants.map((variant) => [variant.code, variant.isActive])).toEqual([['41', true]]);
      expect(await db()('product_variants').where({ id: v42!.id }).first()).toBeUndefined();
      for (const table of ['inventory_stock', 'stock_movements']) {
        expect(await db()(table).where({ variant_id: v42!.id }).first(), table).toBeUndefined();
      }
    });

    it('refuses to retire a row a pending lead quotes; once none does, deactivates rather than deletes it', async () => {
      const product = await damru();
      const [v41, v42] = product.variants;
      const party = await catalog.createParty({ name: 'Patel Sanitary' }, actor);
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, variantId: v42!.id, quantity: 3, packaging: 'carton' }],
        },
        actor,
      );
      const trimmedSet = { name: product.name, variants: [{ id: v41!.id, code: '41', label: 'Vitrosa 41' }] };

      await expect(catalog.updateProduct(product.id, trimmedSet, actor)).rejects.toMatchObject({
        messageKey: 'error.conflict.variantRetiredWithPendingLines',
      });
      expect((await catalog.getProduct(product.id, actor)).variants.map((variant) => variant.isActive)).toEqual([
        true,
        true,
        true,
      ]);

      await leads.deleteLead(lead.id, actor);
      const updated = await catalog.updateProduct(product.id, trimmedSet, actor);

      expect(updated.variants.map((variant) => [variant.code, variant.isActive])).toEqual([
        ['41', true],
        ['42', false],
      ]);
      // The line is untouched, and still names the variant it was raised on.
      const line = await db()('line_items').where({ parent_id: lead.id }).first();
      expect(line).toMatchObject({ variant_id: v42!.id, code: '42' });

      // An inactive variant keeps its code: nobody else may reissue it while
      // history quotes it.
      await expect(
        catalog.createProduct(
          { name: 'Other', categoryName: CATEGORY, variants: [{ code: '42' }] },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'error.conflict.productCodeTaken' });

      // ...and a new lead can no longer pick it.
      await expect(
        leads.createLead(
          {
            partyId: party.id,
            items: [{ productId: product.id, variantId: v42!.id, quantity: 1, packaging: 'carton' }],
          },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.lead.variantMissing' });
    });

    it('takes several blank-colour rows as a product with variants when the caller did not say', async () => {
      const product = await catalog.createProduct(
        { name: 'Implied', categoryName: CATEGORY, variants: [{ code: 'I-1' }, { code: 'I-2' }] },
        actor,
      );
      expect(product.hasVariants).toBe(true);
      expect(codesOf(product.variants)).toEqual(['I-1', 'I-2']);
    });

    it('keeps each blank-colour row its own when a set is re-sent without ids', async () => {
      const product = await catalog.createProduct(
        {
          name: 'Plain',
          categoryName: CATEGORY,
          hasVariants: true,
          variants: [{ code: 'P-1' }, { code: 'P-2' }, { code: 'P-3', label: 'White' }],
        },
        actor,
      );
      const idOf = (code: string) => product.variants.find((variant) => variant.code === code)!.id;
      const party = await catalog.createParty({ name: 'Patel Sanitary' }, actor);
      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, variantId: idOf('P-1'), quantity: 1, packaging: 'carton' }] },
        actor,
      );

      // P-1 is what the pending lead quotes, and it is still in this set.
      const resent = await catalog.updateProduct(
        product.id,
        { name: product.name, variants: [{ code: 'P-1' }, { code: 'P-2', weightKg: 9 }, { code: 'P-3', label: 'White' }] },
        actor,
      );
      expect(resent.variants.map((variant) => [variant.code, variant.id, variant.isActive])).toEqual([
        ['P-1', idOf('P-1'), true],
        ['P-2', idOf('P-2'), true],
        ['P-3', idOf('P-3'), true],
      ]);

      // Leaving out the quoted one is seen as retiring it, not as renaming another blank row.
      await expect(
        catalog.updateProduct(
          product.id,
          { name: product.name, variants: [{ code: 'P-2' }, { code: 'P-3', label: 'White' }] },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'error.conflict.variantRetiredWithPendingLines' });

      await leads.deleteLead(lead.id, actor);
    });

    it('deactivates a removed row only a binned lead quotes, and reactivates it when it comes back', async () => {
      const product = await damru();
      const [v41, v42, white] = product.variants;
      const party = await catalog.createParty({ name: 'Patel Sanitary' }, actor);
      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, variantId: white!.id, quantity: 6, packaging: 'carton' }] },
        actor,
      );
      await leads.deleteLead(lead.id, actor);

      const trimmed = await catalog.updateProduct(
        product.id,
        {
          name: product.name,
          variants: [
            { id: v41!.id, code: '41', label: 'Vitrosa 41' },
            { id: v42!.id, code: '42', label: 'Vitrosa 42' },
          ],
        },
        actor,
      );
      expect(trimmed.variants.find((variant) => variant.id === white!.id)?.isActive).toBe(false);

      // Sent back by label: the same row, with its lines, comes back to life.
      const restored = await catalog.updateProduct(
        product.id,
        {
          name: product.name,
          variants: [
            { id: v41!.id, code: '41', label: 'Vitrosa 41' },
            { id: v42!.id, code: '42', label: 'Vitrosa 42' },
            { code: 'DAMRU-WHITE', label: 'White' },
          ],
        },
        actor,
      );
      const back = restored.variants.find((variant) => variant.label === 'White');
      expect(back).toMatchObject({ id: white!.id, isActive: true });

    });

    it('turns the switch off by keeping one unlabelled row, and refuses to do so with a labelled one', async () => {
      const product = await damru();
      const [v41] = product.variants;

      const plain = await catalog.updateProduct(
        product.id,
        { name: product.name, hasVariants: false, variants: [{ id: v41!.id, code: 'DAMRU' }] },
        actor,
      );
      expect(plain.hasVariants).toBe(false);
      expect(plain.variants).toEqual([expect.objectContaining({ id: v41!.id, code: 'DAMRU', label: null })]);

      await expect(
        catalog.updateProduct(
          product.id,
          { name: product.name, hasVariants: false, variants: [{ code: 'DAMRU', label: 'White' }] },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.product.variantLabelUnexpected' });
    });

    it('refuses a code another live product holds, naming it, and leaves the set as it was', async () => {
      const product = await damru();
      await catalog.createProduct(
        { name: 'Other', categoryName: CATEGORY, variants: [{ code: 'TAKEN-1' }] },
        actor,
      );

      await expect(
        catalog.updateProduct(
          product.id,
          {
            name: product.name,
            variants: [
              { code: '41', label: 'Vitrosa 41' },
              { code: 'taken-1', label: 'Vitrosa 42' },
              { code: 'DAMRU-WHITE', label: 'White' },
            ],
          },
          actor,
        ),
      ).rejects.toMatchObject({
        messageKey: 'error.conflict.productCodeTaken',
        params: { productCode: 'taken-1' },
      });

      expect(codesOf((await catalog.getProduct(product.id, actor)).variants)).toEqual([
        '41',
        '42',
        'DAMRU-WHITE',
      ]);
    });

    it('leaves the variants alone when the form did not send them', async () => {
      const product = await damru();

      const renamed = await catalog.updateProduct(product.id, { name: 'DAMRU PLUS' }, actor);

      expect(renamed.name).toBe('DAMRU PLUS');
      expect(codesOf(renamed.variants)).toEqual(['41', '42', 'DAMRU-WHITE']);
      expect(renamed.sync.fieldHlc.variants).toBeUndefined();
    });
  });
});
