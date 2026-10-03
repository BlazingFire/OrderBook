/**
 * The lead flow end to end, and the conversion guarantees the guide asks to be
 * explicitly tested (docs/LEAD_GENERATION_FLOW.md §5.2):
 *
 *   1. Conversion copies line items unchanged — no silent recalculation.
 *   2. A line's snapshotted weight does not move when the product or its
 *      variant is edited afterwards.
 *   3. `packaging` is never auto-filled during conversion.
 *   4. Order lines are per variant, never aggregated to the product.
 *
 * A line is one variant with one quantity; the code and the weight resolve
 * from the variant, and two colours of one model are two lines. A colour
 * chosen on a multi-colour model rides on the line and is frozen like the
 * rest of it; one sent for any other model is dropped, never refused
 * (`docs/catalogue/CATALOGUE_MODEL.md` §2).
 */

import { financialYearLabel, PO_NUMBER_PATTERN } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setupDatabase,
  stageIdByName,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ConflictError } from '../src/lib/errors.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as settings from '../src/services/settings.service.js';

let actor: ActorContext;

/** A one-form product, a model with three colour variants (one unweighed), and a model made in every colour. */
async function seed() {
  const party = await catalog.createParty({ name: 'Patel Sanitary' }, actor);
  const plain = await catalog.createProduct(
    {
      name: '102',
      categoryName: 'ONE PIECE TOILET',
      size: '9" · L-27 B-15 H-26',
      variants: [{ code: '102', weightKg: 32.5 }],
    },
    actor,
  );
  const anyColour = await catalog.createProduct(
    {
      name: 'E.W.C - S TRAP',
      categoryName: 'WATER CLOSET',
      multiColour: true,
      variants: [{ code: 'EWC-S-TRAP', weightKg: 22 }],
    },
    actor,
  );
  const model = await catalog.createProduct(
    {
      name: 'XYZ',
      categoryName: 'ONE PIECE TOILET',
      hasVariants: true,
      variants: [
        { code: '1111', label: 'White', weightKg: 32 },
        { code: '1112', label: 'Blue', weightKg: 32.5 },
        { code: '1113', label: 'Red' },
      ],
    },
    actor,
  );
  const byLabel = (label: string) => {
    const found = model.variants.find((variant) => variant.label === label);
    if (!found) throw new Error(`seed: no ${label} variant`);
    return found;
  };
  return {
    party,
    plain,
    plainVariant: plain.variants[0]!,
    anyColour,
    anyColourVariant: anyColour.variants[0]!,
    model,
    white: byLabel('White'),
    blue: byLabel('Blue'),
    red: byLabel('Red'),
  };
}

function line(
  productId: string,
  variantId: string,
  quantity: number,
  overrides: Record<string, unknown> = {},
) {
  return { productId, variantId, quantity, packaging: 'carton', ...overrides };
}

describe.skipIf(!canRunIntegrationTests)('lead flow (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('editing racing a conversion', () => {
    it('refuses an update that was waiting on the lock when the lead got converted', async () => {
      const { party, plain, plainVariant } = await seed();
      const make = () =>
        leads.createLead({ partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] }, actor);
      const target = await make();
      const donor = await make();
      const order = await orders.convertLead({ leadId: donor.id }, actor);

      // Hold the target's row lock, start the edit (it passes its unlocked
      // checks and queues behind the lock), then convert and release.
      const holder = await db().transaction();
      await holder('leads').where({ id: target.id }).forUpdate().first('id');
      const edit = leads.updateLead(target.id, { notes: 'late' }, actor);
      const outcome = edit.then(
        () => 'saved',
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder('leads').where({ id: target.id }).update({ converted_order_id: order.id });
      await holder.commit();

      expect(await outcome).toMatch(/final order|converted/i);
      expect((await leads.getLead(target.id, actor)).notes).not.toBe('late');
    });
  });

  describe('creating', () => {
    it('assigns permanent ids in the documented 12-character shape', async () => {
      const { party, plain, plainVariant } = await seed();

      const first = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 10)] },
        actor,
      );
      const second = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 10)] },
        actor,
      );

      expect(first.id).toBe('LD0000000001');
      expect(second.id).toBe('LD0000000002');
    });

    it('numbers each lead PO/<fy>/00001 onwards, and the final order shows the number of its lead', async () => {
      const { party, plain, plainVariant } = await seed();
      const year = financialYearLabel(new Date());

      const first = await leads.createLead({ partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] }, actor);
      const second = await leads.createLead({ partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] }, actor);

      expect(first.poNumber).toBe(`PO/${year}/00001`);
      expect(second.poNumber).toBe(`PO/${year}/00002`);
      expect(first.poNumber).toMatch(PO_NUMBER_PATTERN);
      expect((await leads.getLead(first.id, actor)).poNumber).toBe(first.poNumber);

      const order = await orders.convertLead({ leadId: second.id }, actor);
      expect(order.poNumber).toBe(second.poNumber);
      expect((await orders.listOrders({ search: '00002' }, actor)).items.map((o) => o.id)).toEqual([order.id]);
      expect((await leads.listLeads({ search: first.poNumber! }, actor)).items.map((l) => l.id)).toEqual([first.id]);
    });

    it('takes no number for a create that is refused', async () => {
      const { party, plain, plainVariant } = await seed();
      await expect(leads.createLead({ partyId: party.id, items: [] }, actor)).rejects.toThrow();

      const lead = await leads.createLead({ partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] }, actor);
      expect(lead.poNumber).toBe(`PO/${financialYearLabel(new Date())}/00001`);
    });

    it('resolves the code and the weight from the variant and weighs the line', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 12)] },
        actor,
      );

      const item = lead.items[0];
      expect(item?.code).toBe('102');
      expect(item?.variantLabel).toBeNull();
      expect(item?.colour).toBeNull();
      expect(item?.size).toBe('9" · L-27 B-15 H-26');
      expect(item?.quantity).toBe(12);
      expect(item?.weightKg).toBe(32.5);
      expect(item?.lineWeightKg).toBe(390);
      expect(lead.totalWeightKg).toBe(390);
      expect(lead.linesWithoutWeight).toBe(0);
    });

    it('keeps a colour chosen on a model made in every colour', async () => {
      const { party, anyColour, anyColourVariant } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(anyColour.id, anyColourVariant.id, 10, { colour: 'Ivory' }),
            line(anyColour.id, anyColourVariant.id, 5),
          ],
        },
        actor,
      );

      // Two lines of the same variant, one in a colour and one as it comes:
      // the colour is a line attribute, so both point at the one variant.
      expect(lead.items.map((item) => item.colour)).toEqual(['Ivory', null]);
      expect(lead.items.map((item) => item.variantId)).toEqual([anyColourVariant.id, anyColourVariant.id]);
      expect(lead.items.map((item) => item.code)).toEqual(['EWC-S-TRAP', 'EWC-S-TRAP']);
    });

    it('keeps the grade the panel chose, on any product, and carries it to the order', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(plain.id, plainVariant.id, 3, { grade: 'A' }),
            line(plain.id, plainVariant.id, 2),
          ],
        },
        actor,
      );

      // A grade needs no switch on the product — it says what *this line* was
      // sold as, so one variant goes out as A on one line and ungraded on the
      // next. `20260325000000_line_item_grade` is the column behind this.
      expect(lead.items.map((item) => item.grade)).toEqual(['A', null]);

      const order = await orders.convertLead({ leadId: lead.id }, actor);
      expect(order.items.map((item) => item.grade)).toEqual(['A', null]);
    });

    it('drops a colour sent for a product that is not made in colours, and takes the lead', async () => {
      // It used to be refused — and a lead queued offline with a stray colour
      // then sat in the outbox for good, over a field the line never needed.
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1, { colour: 'Ivory' })] },
        actor,
      );

      expect(lead.items).toHaveLength(1);
      expect(lead.items[0]?.colour).toBeNull();
      expect(lead.items[0]?.quantity).toBe(1);
    });

    it('keeps several colours of one multi-colour sub product as lines on its one variant', async () => {
      const { party, anyColour, anyColourVariant } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(anyColour.id, anyColourVariant.id, 10, { colour: 'White' }),
            line(anyColour.id, anyColourVariant.id, 5, { colour: 'Ivory' }),
          ],
        },
        actor,
      );

      expect(lead.items.map((item) => [item.variantId, item.colour, item.quantity])).toEqual([
        [anyColourVariant.id, 'White', 10],
        [anyColourVariant.id, 'Ivory', 5],
      ]);

      // Both lines ride across to the order against the one variant.
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      expect(order.items.map((item) => item.colour)).toEqual(['White', 'Ivory']);
      expect(order.items.map((item) => [item.variantId, item.quantity])).toEqual([
        [anyColourVariant.id, 10],
        [anyColourVariant.id, 5],
      ]);
    });

    it('freezes the brand and the product code beside the category, and carries them to the order', async () => {
      const party = await catalog.createParty({ name: 'Patel Sanitary' }, actor);
      await db().transaction((trx) =>
        productRepo.ensureCategories(
          actor.tenantId,
          [{ name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+', sortOrder: 1 }],
          trx,
        ),
      );
      const subProduct = await catalog.createProduct(
        { name: '102 (9")', categoryCode: 'OPT', variants: [{ code: 'OPT-0001' }] },
        actor,
      );
      const variant = subProduct.variants[0]!;

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(subProduct.id, variant.id, 2),
            // An offline panel's snapshot wins over today's catalogue.
            line(subProduct.id, variant.id, 1, { categoryCode: 'OPX', brandName: 'Swisware' }),
          ],
        },
        actor,
      );
      expect(lead.items.map((item) => [item.categoryName, item.categoryCode, item.brandName])).toEqual([
        ['One Piece Toilet', 'OPT', 'Swisware+'],
        ['One Piece Toilet', 'OPX', 'Swisware'],
      ]);

      // Renaming the category afterwards moves nothing already taken.
      await db()('product_categories').where({ code: 'OPT' }).update({ code: 'OPT2', brand: 'Other' });

      const order = await orders.convertLead({ leadId: lead.id }, actor);
      expect(order.items.map((item) => [item.categoryCode, item.brandName])).toEqual([
        ['OPT', 'Swisware+'],
        ['OPX', 'Swisware'],
      ]);
    });

    it('prints a lead only for someone holding leads.export', async () => {
      // The socket's `lead:pdf` reaches the service with no route guard in
      // front of it, so the service's own check is the one that counts there.
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );
      const viewer = await testActor({
        permissions: {
          roleId: null,
          roleName: 'Viewer',
          tier: 'office',
          permissions: ['leads.view'],
        },
      });

      await expect(leads.leadPdf(lead.id, viewer)).rejects.toMatchObject({ statusCode: 403 });
      const { bytes } = await leads.leadPdf(lead.id, actor);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    it('takes the code and the weight from the chosen colour of a model', async () => {
      const { party, model, blue, red } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [line(model.id, blue.id, 10), line(model.id, red.id, 3)],
        },
        actor,
      );

      const [blueLine, redLine] = lead.items;
      expect(blueLine?.code).toBe('1112');
      expect(blueLine?.variantLabel).toBe('Blue');
      expect(blueLine?.weightKg).toBe(32.5);
      expect(blueLine?.lineWeightKg).toBe(325);
      // Red has no weight entered yet: the line says so instead of guessing.
      expect(redLine?.code).toBe('1113');
      expect(redLine?.weightKg).toBeNull();
      expect(redLine?.lineWeightKg).toBeNull();
      expect(lead.totalWeightKg).toBe(325);
      expect(lead.linesWithoutWeight).toBe(1);
    });

    it('keeps several colours of one model as separate lines, each with its own total', async () => {
      const { party, model, white, blue, red } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [line(model.id, white.id, 5), line(model.id, blue.id, 10), line(model.id, red.id, 3)],
        },
        actor,
      );

      expect(lead.items).toHaveLength(3);
      expect(lead.items.map((item) => [item.code, item.quantity])).toEqual([
        ['1111', 5],
        ['1112', 10],
        ['1113', 3],
      ]);
      // 5 × 32 + 10 × 32.5; the unweighed red line is left out and counted.
      expect(lead.totalWeightKg).toBe(485);
      expect(lead.linesWithoutWeight).toBe(1);
    });

    it('refuses a variant that belongs to another product', async () => {
      const { party, plain, blue } = await seed();

      await expect(
        leads.createLead({ partyId: party.id, items: [line(plain.id, blue.id, 1)] }, actor),
      ).rejects.toThrow(/variants no longer exists/i);
    });

    it('refuses a variant the administrator has taken off the form', async () => {
      const { party, model, white, blue, red } = await seed();
      // Blue is removed from the model; nothing references it yet, so it goes.
      await catalog.updateProduct(
        model.id,
        {
          name: 'XYZ',
          variants: [
            { id: white.id, code: '1111', label: 'White', weightKg: 32 },
            { id: red.id, code: '1113', label: 'Red' },
          ],
        },
        actor,
      );

      await expect(
        leads.createLead({ partyId: party.id, items: [line(model.id, blue.id, 1)] }, actor),
      ).rejects.toThrow(/variants no longer exists/i);
    });

    it('refuses a line with no quantity', async () => {
      const { party, plain, plainVariant } = await seed();

      await expect(
        leads.createLead({ partyId: party.id, items: [line(plain.id, plainVariant.id, 0)] }, actor),
      ).rejects.toThrow(/quantity/i);
    });

    it('starts the lead in the pipeline’s default stage', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );

      expect(lead.stageName).toBe('New');
      expect(lead.timeline.map((entry) => entry.message)).toContain('Lead created');
    });

    it('rejects a lead with no products', async () => {
      const { party } = await seed();

      await expect(leads.createLead({ partyId: party.id, items: [] }, actor)).rejects.toThrow(
        /at least one product/i,
      );
    });

    it('rejects a source platform that is not a configured option', async () => {
      const { party, plain, plainVariant } = await seed();

      await expect(
        leads.createLead(
          {
            partyId: party.id,
            sourcePlatform: 'whatsap',
            items: [line(plain.id, plainVariant.id, 1)],
          },
          actor,
        ),
      ).rejects.toThrow(/not a configured pending order source/i);
    });

    it('accepts a configured source platform', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          sourcePlatform: 'whatsapp',
          items: [line(plain.id, plainVariant.id, 1)],
        },
        actor,
      );

      expect(lead.sourcePlatform).toBe('whatsapp');
    });
  });

  describe('editing', () => {
    it('stamps the lines\' clock, the lead\'s hlc and its version when only the items change', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );

      const edited = await leads.updateLead(
        lead.id,
        { items: [line(plain.id, plainVariant.id, 6)] },
        actor,
      );

      expect(edited.items[0]?.quantity).toBe(6);
      expect(edited.sync.fieldHlc.items).not.toBe(lead.sync.fieldHlc.items);
      expect(edited.sync.hlc).not.toBe(lead.sync.hlc);
      expect(edited.sync.version).toBe(lead.sync.version + 1);
    });

    it('refuses a field someone saved after the editor opened the lead, with 409 staleEdit', async () => {
      const { party, plain, plainVariant } = await seed();
      const opened = await leads.createLead(
        { partyId: party.id, notes: 'first', items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );
      // Somebody else saves the notes while this editor has the lead open.
      const theirs = await leads.updateLead(opened.id, { notes: 'theirs' }, actor);

      const stale = leads.updateLead(
        opened.id,
        { notes: 'mine', baseFieldHlc: opened.sync.fieldHlc },
        actor,
      );
      await expect(stale).rejects.toBeInstanceOf(ConflictError);
      await expect(stale).rejects.toMatchObject({
        statusCode: 409,
        messageKey: 'error.conflict.staleEdit',
        details: { stale: ['notes'], fieldHlc: theirs.sync.fieldHlc },
      });
      expect((await leads.getLead(opened.id, actor)).notes).toBe('theirs');

      // A field nobody else touched still saves on the old clocks.
      const followUp = await leads.updateLead(
        opened.id,
        { followUpDate: '2026-12-01', baseFieldHlc: opened.sync.fieldHlc },
        actor,
      );
      expect(followUp.followUpDate).toBe('2026-12-01');

      // "Keep mine": the same edit on the clocks as they are now.
      const kept = await leads.updateLead(
        opened.id,
        { notes: 'mine', baseFieldHlc: followUp.sync.fieldHlc },
        actor,
      );
      expect(kept.notes).toBe('mine');

      // Without a base the edit applies as it always has.
      expect((await leads.updateLead(opened.id, { notes: 'plain' }, actor)).notes).toBe('plain');
    });

    it('refuses a stale edit to a final order the same way', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead({ partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] }, actor);
      const opened = await orders.convertLead({ leadId: lead.id }, actor);
      await orders.updateOrder(opened.id, { vehicleNumber: 'GJ 01 AB 1234' }, actor);

      await expect(
        orders.updateOrder(opened.id, { vehicleNumber: 'GJ 03 CD 5678', baseFieldHlc: opened.sync.fieldHlc }, actor),
      ).rejects.toMatchObject({ messageKey: 'error.conflict.staleEdit', details: { stale: ['vehicleNumber'] } });
      expect((await orders.getOrder(opened.id, actor)).vehicleNumber).toBe('GJ 01 AB 1234');

      const notes = await orders.updateOrder(opened.id, { notes: 'call first', baseFieldHlc: opened.sync.fieldHlc }, actor);
      expect(notes.notes).toBe('call first');
    });

    it('refuses lines with no product or variant id, and a party id that is not text', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );

      await expect(leads.updateLead(lead.id, { items: [{} as never] }, actor)).rejects.toThrow(
        /no longer exists/i,
      );
      await expect(
        leads.updateLead(lead.id, { items: [{ productId: plain.id, quantity: 1 } as never] }, actor),
      ).rejects.toThrow(/variants? no longer exists/i);
      await expect(leads.updateLead(lead.id, { partyId: 42 as never }, actor)).rejects.toThrow(
        /select a party/i,
      );
      await expect(
        leads.createLead({ partyId: 42 as never, items: [line(plain.id, plainVariant.id, 1)] }, actor),
      ).rejects.toThrow(/select a party/i);
    });
  });

  describe('moving through the pipeline', () => {
    it('records a system timeline entry for every stage change', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );

      const moved = await leads.setStage(
        { id: lead.id, stageId: await stageIdByName('lead', 'Quoted') },
        actor,
      );

      expect(moved.stageName).toBe('Quoted');
      expect(moved.timeline.map((entry) => entry.message)).toContain('Moved from New to Quoted');
    });

    it('stores a remark alongside the automatic entry, not instead of it', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );

      const moved = await leads.setStage(
        {
          id: lead.id,
          stageId: await stageIdByName('lead', 'Negotiating'),
          remark: 'Asked for delivery by Friday',
        },
        actor,
      );

      const kinds = moved.timeline.map((entry) => entry.kind);
      expect(kinds).toContain('system');
      expect(kinds).toContain('remark');
    });
  });

  describe('converting to an order', () => {
    async function convertible() {
      const seeded = await seed();
      const { party, model, white, blue } = seeded;
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(model.id, white.id, 4, { packaging: 'wooden crate' }),
            line(model.id, blue.id, 6, { packaging: 'wooden crate' }),
          ],
        },
        actor,
      );
      return { ...seeded, lead };
    }

    it('creates an order that points back at the lead, and keeps the lead', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);
      const original = await leads.getLead(lead.id, actor);

      expect(order.id).toBe('OD0000000001');
      expect(order.leadId).toBe(lead.id);
      expect(original.convertedOrderId).toBe(order.id);
      expect(original.convertedAt).not.toBeNull();
      // The lead survives with its lines intact — it is history, not a husk.
      expect(original.items).toHaveLength(2);
    });

    it('copies line items unchanged — product, variant, code, colour, weight, quantity', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items).toHaveLength(2);
      for (const [index, before] of lead.items.entries()) {
        const after = order.items[index];
        expect(after?.productId).toBe(before.productId);
        expect(after?.variantId).toBe(before.variantId);
        expect(after?.productName).toBe(before.productName);
        expect(after?.code).toBe(before.code);
        expect(after?.variantLabel).toBe(before.variantLabel);
        expect(after?.colour).toBe(before.colour);
        expect(after?.grade).toBe(before.grade);
        expect(after?.size).toBe(before.size);
        expect(after?.weightKg).toBe(before.weightKg);
        expect(after?.quantity).toBe(before.quantity);
        expect(after?.lineWeightKg).toBe(before.lineWeightKg);
      }
    });

    it('carries a chosen colour onto the order', async () => {
      const { party, anyColour, anyColourVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(anyColour.id, anyColourVariant.id, 4, { colour: 'Ivory' })] },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items[0]?.colour).toBe('Ivory');
    });

    it('does not move the snapshotted weight when the master is edited afterwards', async () => {
      const { model, white, blue, red, lead } = await convertible();

      // The catalogue changes *between* quoting and converting — the exact case
      // §8.3 exists to guard against: a corrected weight.
      await catalog.updateProduct(
        model.id,
        {
          name: 'XYZ',
          variants: [
            { id: white.id, code: '1111', label: 'White', weightKg: 40 },
            { id: blue.id, code: '1112', label: 'Blue', weightKg: 41 },
            { id: red.id, code: '1113', label: 'Red', weightKg: 42 },
          ],
        },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items.map((item) => item.weightKg)).toEqual([32, 32.5]);
      // 4 × 32 + 6 × 32.5, from the frozen figures, not the corrected ones.
      expect(order.totalWeightKg).toBe(323);
    });

    it('leaves an existing order untouched when the variant is edited later', async () => {
      const { model, white, blue, red, lead } = await convertible();
      const order = await orders.convertLead({ leadId: lead.id }, actor);

      await catalog.updateProduct(
        model.id,
        {
          name: 'XYZ',
          variants: [
            { id: white.id, code: '1111-N', label: 'White', weightKg: 40 },
            { id: blue.id, code: '1112-N', label: 'Blue', weightKg: 41 },
            { id: red.id, code: '1113-N', label: 'Red', weightKg: 42 },
          ],
        },
        actor,
      );

      const stored = await orders.getOrder(order.id, actor);
      expect(stored.items.map((item) => [item.code, item.weightKg])).toEqual([
        ['1111', 32],
        ['1112', 32.5],
      ]);
      expect(stored.totalWeightKg).toBe(323);
    });

    it('carries packaging across exactly as entered, never re-derived', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items.map((item) => item.packaging)).toEqual(['wooden crate', 'wooden crate']);
    });

    it('refuses to convert a lead whose line has no packaging, when the company requires it', async () => {
      // Off by default since catalogue v2 (`leads.packagingRequiredOnConvert`);
      // the rule itself is unchanged for a company that switches it on.
      await settings.writeSetting(actor, 'leads.packagingRequiredOnConvert', true);
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1, { packaging: null })] },
        actor,
      );

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(
        /choose packaging/i,
      );
    });

    it('carries each line to the order against its own variant, never per product', async () => {
      const { lead, white, blue } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items).toHaveLength(2);
      const byVariant = Object.fromEntries(order.items.map((item) => [item.variantId, item.quantity]));
      expect(byVariant).toEqual({ [white.id]: 4, [blue.id]: 6 });
    });


    it('sums the order weight from the line weights, over the lines that have one', async () => {
      const { party, model, blue, red } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(model.id, blue.id, 10), line(model.id, red.id, 3)] },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      // 32.5 kg × 10; the unweighed red line is counted, not guessed.
      expect(order.totalWeightKg).toBe(325);
      expect(order.linesWithoutWeight).toBe(1);
      expect(order.weightSource).toBe('computed');
    });

    it('starts the order in its own pipeline, independent of the lead’s', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.stageName).toBe('In Progress');
      expect(order.stageId).toBe(await stageIdByName('order', 'In Progress'));
    });

    it('refuses to convert the same lead twice', async () => {
      const { lead } = await convertible();
      await orders.convertLead({ leadId: lead.id }, actor);

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(
        /already been converted/i,
      );
    });

    it('stops a converted lead being moved or edited', async () => {
      const { lead } = await convertible();
      await orders.convertLead({ leadId: lead.id }, actor);

      await expect(
        leads.setStage({ id: lead.id, stageId: await stageIdByName('lead', 'Lost') }, actor),
      ).rejects.toThrow(/already become a final order/i);

      await expect(leads.updateLead(lead.id, { notes: 'too late' }, actor)).rejects.toThrow(
        /can no longer be edited/i,
      );
    });
  });

  describe('deleting an order', () => {
    async function convertedOrder() {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 2)] },
        actor,
      );
      return orders.convertLead({ leadId: lead.id }, actor);
    }

    it('refuses a dispatched order with the blocker named', async () => {
      const order = await convertedOrder();
      await orders.dispatchOrder({ orderId: order.id }, actor);

      const failure = await orders.deleteOrder(order.id, actor).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictError);
      expect((failure as ConflictError).details).toMatchObject({
        blockedBy: [expect.objectContaining({ id: order.id, reason: 'dispatched' })],
      });
    });

    it('re-checks under the row lock, so a dispatch that commits mid-delete still blocks it', async () => {
      const order = await convertedOrder();

      // Hold the row, start the delete (its first read sees an undispatched
      // order and its transaction then queues on the lock), dispatch under the
      // lock and commit. Without the re-check the delete went on to tombstone a
      // shipped order.
      const holder = await db().transaction();
      await holder('orders').where({ id: order.id }).forUpdate().first();
      const deletion = orders.deleteOrder(order.id, actor).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await holder('orders').where({ id: order.id }).update({ dispatched_at: holder.fn.now() });
      await holder.commit();

      expect(await deletion).toBeInstanceOf(ConflictError);
      expect((await db()('orders').where({ id: order.id }).first())?.deleted_at).toBeNull();
    });
  });

  describe('order weight override', () => {
    it('keeps the computed figure and only relabels which one is shown', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 10)] },
        actor,
      );
      const order = await orders.convertLead({ leadId: lead.id }, actor);

      const overridden = await orders.updateOrder(order.id, { totalWeightKgOverride: 200 }, actor);
      expect(overridden.weightSource).toBe('manual');
      expect(overridden.totalWeightKgOverride).toBe(200);
      // Still known, so clearing the override restores the real number.
      expect(overridden.totalWeightKg).toBe(325);

      const cleared = await orders.updateOrder(order.id, { totalWeightKgOverride: null }, actor);
      expect(cleared.weightSource).toBe('computed');
      expect(cleared.totalWeightKg).toBe(325);
    });

    it('sets, normalises and clears the vehicle number, and rejects a bad one', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 10)] },
        actor,
      );
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      expect(order.vehicleNumber).toBeNull();
      expect(order.leadCreatedAt).toBe(lead.createdAt);

      const set = await orders.updateOrder(order.id, { vehicleNumber: ' mh 12  ab-1234 ' }, actor);
      expect(set.vehicleNumber).toBe('MH 12 AB-1234');

      await expect(
        orders.updateOrder(order.id, { vehicleNumber: 'X'.repeat(21) }, actor),
      ).rejects.toThrow();
      await expect(orders.updateOrder(order.id, { vehicleNumber: 'MH!12' }, actor)).rejects.toThrow();

      const cleared = await orders.updateOrder(order.id, { vehicleNumber: '  ' }, actor);
      expect(cleared.vehicleNumber).toBeNull();
    });
  });
});
