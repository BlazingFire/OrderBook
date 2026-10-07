/**
 * The colour chain from a line to the printouts (D10's W2 audit, 2026-10-07).
 *
 *  - W2-1: editing the lines of an old lead must not rewrite what an old line
 *    was sold as. A lead taken as Ivory on a model made in every colour keeps
 *    Ivory after the model is corrected to a fixed White sub product
 *    (`20261015000000_catalogue_corrections`) and somebody edits the lead,
 *    online or from an Office's offline queue.
 *  - A NEW line's colour must be on the company list: normalised to the list's
 *    spelling, refused with a coded 400 otherwise, and an Office's queued line
 *    is rejected readably instead of being stored. Old lines are left alone.
 *  - W2-2 and W2-3: the Dispatches report counts each line under the colour it
 *    was sold in, and its CSV carries that breakdown.
 *  - The lead PDF prints the list's label for the stored value.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mutation } from '@orderbook/shared';
import { initialHlcState, tickHlc } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as noteRenderer from '../src/pdf/note-renderer.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as reports from '../src/services/report.service.js';
import * as sync from '../src/services/sync.service.js';

const PANEL = 'C0L0R1';
let actor: ActorContext;

async function seed() {
  for (const value of ['White', 'Ivory', 'Red Brown', 'Magenta']) {
    await fields.createValue({ listKey: 'stock.colour', value, label: value }, actor);
  }
  const party = await catalog.createParty({ name: 'Colour Traders' }, actor);
  const closet = await catalog.createProduct(
    {
      name: 'MODERN',
      categoryName: 'ONE PIECE CLOSET',
      multiColour: true,
      variants: [{ code: 'MOD-1', weightKg: 30 }],
    },
    actor,
  );
  const basin = await catalog.createProduct(
    { name: 'ROMA', categoryName: 'WASH BASIN', multiColour: true, variants: [{ code: 'ROMA-1', weightKg: 12 }] },
    actor,
  );
  return { party, closet, closetVariant: closet.variants[0]!, basin, basinVariant: basin.variants[0]! };
}

const line = (productId: string, variantId: string, quantity: number, extra: Record<string, unknown> = {}) => ({
  productId,
  variantId,
  quantity,
  packaging: 'carton',
  ...extra,
});

/** What the catalogue correction did to a multicolour closet: a fixed White sub product. */
async function correctToFixedWhite(productId: string, variantId: string): Promise<void> {
  await db()('products').where({ id: productId }).update({ multi_colour: false, has_variants: true });
  await db()('product_variants').where({ id: variantId }).update({ label: 'White' });
}

describe.skipIf(!canRunIntegrationTests)('the colour chain (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('W2-1: an edit keeps what an old line was sold as', () => {
    it('online: adding a line to a lead on a since-corrected closet leaves Ivory and Red Brown as they were', async () => {
      const { party, closet, closetVariant, basin, basinVariant } = await seed();
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(closet.id, closetVariant.id, 4, { colour: 'Ivory' }),
            line(closet.id, closetVariant.id, 2, { colour: 'Red Brown' }),
          ],
        },
        actor,
      );
      await correctToFixedWhite(closet.id, closetVariant.id);

      // The panel resends every line as it holds it (colour and label, no id)
      // and adds one.
      const resent = lead.items.map((item) =>
        line(item.productId, item.variantId, item.quantity, { colour: item.colour, variantLabel: item.variantLabel }),
      );
      const edited = await leads.updateLead(
        lead.id,
        { items: [...resent, line(basin.id, basinVariant.id, 1, { colour: 'Magenta' })] },
        actor,
      );

      expect(edited.items.map((item) => [item.colour, item.variantLabel])).toEqual([
        ['Ivory', null],
        ['Red Brown', null],
        ['Magenta', null],
      ]);
    });

    it('online: a NEW line of the corrected closet takes no colour and the fixed White', async () => {
      const { party, closet, closetVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(closet.id, closetVariant.id, 4, { colour: 'Ivory' })] },
        actor,
      );
      await correctToFixedWhite(closet.id, closetVariant.id);

      const edited = await leads.updateLead(
        lead.id,
        {
          items: [
            line(closet.id, closetVariant.id, 4, { colour: 'Ivory', variantLabel: null }),
            line(closet.id, closetVariant.id, 3, { colour: 'Red Brown' }),
          ],
        },
        actor,
      );

      expect(edited.items.map((item) => [item.colour, item.variantLabel])).toEqual([
        ['Ivory', null],
        [null, 'White'],
      ]);
    });

    it('offline: an Office edit merged later keeps the old colours the same way', async () => {
      const { party, closet, closetVariant, basin, basinVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(closet.id, closetVariant.id, 4, { colour: 'Ivory' })] },
        actor,
      );
      await correctToFixedWhite(closet.id, closetVariant.id);

      const response = await sync.applyPush(
        {
          mutations: [
            mutation(lead.id, [
              line(closet.id, closetVariant.id, 4, { colour: 'Ivory', variantLabel: null }),
              line(basin.id, basinVariant.id, 2, { colour: 'Ivory' }),
            ]),
          ],
        },
        await testActor({ deviceCode: PANEL, actorType: 'office_panel' }),
      );

      expect(response.results[0]?.status).not.toBe('rejected');
      const stored = await leads.getLead(lead.id, actor);
      expect(stored.items.map((item) => [item.colour, item.variantLabel])).toEqual([
        ['Ivory', null],
        ['Ivory', null],
      ]);
    });
  });

  describe('a new line takes a colour only from the company list', () => {
    it('spells it as the list does, case and spacing aside', async () => {
      const { party, basin, basinVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(basin.id, basinVariant.id, 1, { colour: ' red brown ' })] },
        actor,
      );
      expect(lead.items[0]?.colour).toBe('Red Brown');
    });

    it('refuses an unknown colour online with a coded 400, and stores nothing', async () => {
      const { party, basin, basinVariant } = await seed();
      await expect(
        leads.createLead({ partyId: party.id, items: [line(basin.id, basinVariant.id, 1, { colour: 'Blue' })] }, actor),
      ).rejects.toMatchObject({ statusCode: 400, messageKey: 'validation.lead.colourUnknown' });
      expect(await db()('leads').count({ n: '*' }).first()).toMatchObject({ n: '0' });
    });

    it('rejects an Office line queued with an unknown colour readably, never storing it', async () => {
      const { party, basin, basinVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(basin.id, basinVariant.id, 1, { colour: 'Ivory' })] },
        actor,
      );

      const response = await sync.applyPush(
        {
          mutations: [
            mutation(lead.id, [
              line(basin.id, basinVariant.id, 1, { colour: 'Ivory' }),
              line(basin.id, basinVariant.id, 2, { colour: 'Blue' }),
            ]),
          ],
        },
        await testActor({ deviceCode: PANEL, actorType: 'office_panel' }),
      );

      expect(response.results[0]?.status).toBe('rejected');
      expect(response.results[0]?.error).toMatch(/Blue is not in the company colour list/);
      const stored = await leads.getLead(lead.id, actor);
      expect(stored.items.map((item) => item.colour)).toEqual(['Ivory']);
    });

    it('leaves an old line whose colour was since taken off the list as it is', async () => {
      const { party, basin, basinVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(basin.id, basinVariant.id, 1, { colour: 'Magenta' })] },
        actor,
      );
      await db()('option_lists').where({ list_key: 'stock.colour', value: 'Magenta' }).update({ deleted_at: new Date() });

      const edited = await leads.updateLead(
        lead.id,
        { items: [line(basin.id, basinVariant.id, 5, { colour: 'Magenta' })] },
        actor,
      );
      expect(edited.items.map((item) => [item.colour, item.quantity])).toEqual([['Magenta', 5]]);
    });
  });

  describe('W2-2 and W2-3: the Dispatches report', () => {
    it('counts each line under the colour it was sold in, and the CSV carries the breakdown', async () => {
      const { party, closet, closetVariant, basin, basinVariant } = await seed();
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(closet.id, closetVariant.id, 8, { colour: 'Ivory' }),
            line(basin.id, basinVariant.id, 5, { colour: 'Magenta' }),
          ],
        },
        actor,
      );
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      await orders.dispatchOrder({ orderId: order.id }, actor);
      // Corrected after the sale: the live variant now says White.
      await correctToFixedWhite(closet.id, closetVariant.id);

      const report = await reports.dispatchReport({ period: 'thisMonth' }, actor);
      expect(Object.fromEntries(report.colours.map((bucket) => [bucket.colour, bucket.pieces]))).toEqual({
        Ivory: 8,
        Magenta: 5,
      });

      const exported = (await reports.exportReport('dispatches', { period: 'thisMonth' }, actor)) as { csv: string };
      const lines = exported.csv.split('\r\n');
      expect(lines[0]).toBe('month,orderCount,pieces');
      const section = lines.indexOf('colour,pieces');
      expect(section).toBeGreaterThan(1);
      expect(lines[section - 1]).toBe('');
      expect(lines.slice(section + 1, section + 3).sort()).toEqual(['Ivory,8', 'Magenta,5']);
    });

    it('W2-4 and W2-5: prints a renamed colour by its label, and lines with no colour as "No colour"', async () => {
      const { party, basin, basinVariant } = await seed();
      const { product: plain, variant: plainVariant } = await (async () => {
        const created = await catalog.createProduct(
          { name: 'PLAIN PAN', categoryName: 'PAN', variants: [{ code: 'PAN-1', weightKg: 5 }] },
          actor,
        );
        return { product: created, variant: created.variants[0]! };
      })();
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [line(basin.id, basinVariant.id, 5, { colour: 'Magenta' }), line(plain.id, plainVariant.id, 3)],
        },
        actor,
      );
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      await orders.dispatchOrder({ orderId: order.id }, actor);
      // Renamed in Fields after the sale; the line still holds the value.
      await db()('option_lists')
        .where({ list_key: 'stock.colour', value: 'Magenta' })
        .update({ label: 'Magenta Pink' });

      const report = await reports.dispatchReport({ period: 'thisMonth' }, actor);
      expect(Object.fromEntries(report.colours.map((bucket) => [bucket.colour, bucket.pieces]))).toEqual({
        'Magenta Pink': 5,
        'No colour': 3,
      });

      const exported = (await reports.exportReport('dispatches', { period: 'thisMonth' }, actor)) as { csv: string };
      const lines = exported.csv.split('\r\n');
      const section = lines.indexOf('colour,pieces');
      expect(lines.slice(section + 1, section + 3).sort()).toEqual(['Magenta Pink,5', 'No colour,3']);
    });
  });

  describe('the lead PDF prints the colour list label', () => {
    it('resolves the stored value to its current label at print time', async () => {
      const { party, basin, basinVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(basin.id, basinVariant.id, 2, { colour: 'Red Brown' })] },
        actor,
      );
      // Renamed in Fields after the sale: the value on the line stays.
      await db()('option_lists').where({ list_key: 'stock.colour', value: 'Red Brown' }).update({ label: 'Rust' });

      const render = vi.spyOn(noteRenderer, 'renderNotePdf');
      try {
        await leads.leadPdf(lead.id, actor);
        const printed = render.mock.calls[0]?.[0].pages[0]?.left[0]?.[0]?.colour;
        expect(printed).toBe('Rust');
      } finally {
        render.mockRestore();
      }
      expect((await leads.getLead(lead.id, actor)).items[0]?.colour).toBe('Red Brown');
    });
  });
});

function mutation(leadId: string, items: unknown[]): Mutation {
  return {
    mutationId: `m-${Math.random().toString(36).slice(2)}`,
    hlc: tickHlc(initialHlcState(PANEL), Date.now() + 60_000).hlc,
    deviceCode: PANEL,
    kind: 'lead.update',
    entity: 'lead',
    entityId: leadId,
    fields: ['items'],
    payload: { items },
    baseFieldHlc: {},
    actorUserId: null,
    createdAt: new Date().toISOString(),
  } as Mutation;
}
