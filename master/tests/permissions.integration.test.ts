/**
 * Role-based access and field-level visibility
 * (docs/LEAD_GENERATION_FLOW.md §1, §9.5).
 *
 * Two things are asserted that a screenshot could not show:
 *  · a refusal **names the permission it wanted**, so an operator can tell a
 *    broken screen from one they lack access to;
 *  · a gated field is **absent**, not null. `rate: null` is a factual claim that
 *    the line has no price, which is a different and wrong statement — and one a
 *    client would happily total to zero.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as search from '../src/services/search.service.js';

let admin: ActorContext;

async function seed() {
  const party = await catalog.createParty({ name: 'Permission Traders' }, admin);
  const product = await catalog.createProduct(
    { productCode: 'PRM-01', name: 'Glazed Tile', rate: 55_000 },
    admin,
  );
  return { party, product };
}

async function seedLead() {
  const { party, product } = await seed();
  return leads.createLead(
    {
      partyId: party.id,
      items: [
        {
          productId: product.id,
          packaging: 'carton',
          quantities: [{ colour: 'Ivory', quantity: 4 }],
        },
      ],
    },
    admin,
  );
}

/** What an office-tier lead desk actually holds — every key is office-legal. */
const OFFICE_KEYS = [
  'leads.view',
  'leads.create',
  'leads.edit',
  'lead.convert',
  'orders.view',
  'parties.view',
  'parties.create',
  'products.view',
  'inventory.view',
  'field.saleRate.view',
];

describe.skipIf(!canRunIntegrationTests)('permissions (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  describe('module actions', () => {
    it('refuses with the missing permission named, not a bare 403', async () => {
      const { party, product } = await seed();
      const viewer = await actorWith(['leads.view']);

      const failure = await leads
        .createLead(
          {
            partyId: party.id,
            items: [
              {
                productId: product.id,
                packaging: 'carton',
                quantities: [{ colour: 'Ivory', quantity: 1 }],
              },
            ],
          },
          viewer,
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ForbiddenError);
      expect((failure as ForbiddenError).permission).toBe('leads.create');
      expect((failure as ForbiddenError).statusCode).toBe(403);
      expect((failure as ForbiddenError).message).toBe('Missing permission: leads.create');
    });

    it('lets the seeded Office tier raise and convert a lead', async () => {
      const officeUser = await actorWith(OFFICE_KEYS);
      const { party, product } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            {
              productId: product.id,
              packaging: 'carton',
              quantities: [{ colour: 'Ivory', quantity: 2 }],
            },
          ],
        },
        officeUser,
      );

      // The day-to-day job: raise it and turn it into an order.
      const order = await orders.convertLead({ leadId: lead.id }, officeUser);
      expect(order.leadId).toBe(lead.id);
    });

    it('stops the Office tier dispatching, which is a warehouse decision', async () => {
      const officeUser = await actorWith(OFFICE_KEYS);
      const lead = await seedLead();
      const order = await orders.convertLead({ leadId: lead.id }, admin);

      await expect(
        orders.dispatchOrder({ orderId: order.id }, officeUser),
      ).rejects.toThrow(/Missing permission: orders\.dispatch/);
    });

    it('needs record.reassignOwner to hand a lead to someone else', async () => {
      const { party, product } = await seed();
      const officeUser = await actorWith(OFFICE_KEYS);

      const [someoneElse] = await db()('users').insert(
        {
          // A `US`-tagged text id now, like every other syncable record.
          id: 'US0000009999',
          tenant_id: admin.tenantId,
          username: 'colleague',
          password_hash: 'x',
          display_name: 'A Colleague',
          hlc: '0000001700000000000-00000-MASTER',
        },
        ['id'],
      );

      await expect(
        leads.createLead(
          {
            partyId: party.id,
            ownerId: String(someoneElse.id),
            items: [
              {
                productId: product.id,
                packaging: 'carton',
                quantities: [{ colour: 'Ivory', quantity: 1 }],
              },
            ],
          },
          officeUser,
        ),
      ).rejects.toThrow(/Missing permission: record\.reassignOwner/);
    });
  });

  describe('field-level visibility', () => {
    it('omits the rate entirely rather than nulling it', async () => {
      const lead = await seedLead();
      const blind = await actorWith(['leads.view', 'orders.view', 'products.view']);

      const seen = await leads.getLead(lead.id, blind);

      expect('totalAmount' in seen).toBe(false);
      expect('rate' in (seen.items[0] ?? {})).toBe(false);
      expect('lineTotal' in (seen.items[0] ?? {})).toBe(false);
      // Everything else is still there — masking is not redaction.
      expect(seen.items[0]?.productName).toBe('Glazed Tile');
      expect(seen.items[0]?.totalQuantity).toBe(4);
    });

    it('ignores a rate from somebody without field.saleRate.edit', async () => {
      const { party, product } = await seed();

      // Holds `leads.create` and can even *see* rates — but may not set one.
      // Before this was enforced the key existed in the catalogue, rendered as
      // a togglable cell, and changed nothing: unticking it did not stop
      // anybody pricing anything.
      const pricer = await actorWith(['leads.create', 'leads.view', 'field.saleRate.view']);

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            {
              productId: product.id,
              packaging: 'carton',
              rate: 1,
              quantities: [{ colour: 'Ivory', quantity: 4 }],
            },
          ],
        },
        pricer,
      );

      // Dropped, not rejected — so the line falls back to the catalogue price
      // rather than the 1 they asked for, and an offline panel replaying a day
      // of legitimate work is not refused wholesale.
      expect(lead.items[0]?.rate).toBe(55_000);
    });

    it('takes the rate from somebody who holds field.saleRate.edit', async () => {
      const { party, product } = await seed();
      const pricer = await actorWith([
        'leads.create',
        'leads.view',
        'field.saleRate.view',
        'field.saleRate.edit',
      ]);

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            {
              productId: product.id,
              packaging: 'carton',
              rate: 61_000,
              quantities: [{ colour: 'Ivory', quantity: 4 }],
            },
          ],
        },
        pricer,
      );

      expect(lead.items[0]?.rate).toBe(61_000);
    });

    it('ignores a product rate from somebody without field.saleRate.edit', async () => {
      const pricer = await actorWith(['products.create', 'products.view', 'field.saleRate.view']);

      const product = await catalog.createProduct(
        { productCode: 'PRM-02', name: 'Unpriced Tile', rate: 9 },
        pricer,
      );

      // `products.create` says you may add a product; pricing it is a separate
      // permission, or the pricing key is avoidable via the catalogue.
      expect(product.rate ?? null).toBeNull();
    });

    it('shows the rate to a role that holds field.saleRate.view', async () => {
      const lead = await seedLead();
      const sighted = await actorWith(['leads.view', 'field.saleRate.view']);

      const seen = await leads.getLead(lead.id, sighted);

      expect(seen.items[0]?.rate).toBe(55_000);
      expect(seen.totalAmount).toBe(220_000);
    });

    it('masks the product catalogue the same way', async () => {
      await seed();
      const blind = await actorWith(['products.view']);

      const page = await catalog.listProducts({}, blind);

      expect('rate' in (page.items[0] ?? {})).toBe(false);
      expect(page.items[0]?.name).toBe('Glazed Tile');
    });

    it('carries the rate through conversion even when the converter cannot see it', async () => {
      const lead = await seedLead();
      const blindConverter = await actorWith(['leads.view', 'lead.convert', 'orders.view']);

      const order = await orders.convertLead({ leadId: lead.id }, blindConverter);

      // They may not read the price, but the order must still carry it.
      expect('rate' in (order.items[0] ?? {})).toBe(false);
      const stored = await db()('line_items')
        .where({ parent_type: 'order', parent_id: order.id })
        .first();
      expect(Number(stored?.rate)).toBe(55_000);
    });
  });

  describe('search', () => {
    it('drops entities the caller may not view instead of refusing outright', async () => {
      await seed();
      // Can see products, cannot see parties.
      const partial = await actorWith(['products.view']);

      const hits = await search.search({ term: 'Glazed' }, partial);
      const kinds = new Set(hits.map((hit) => hit.kind));

      expect(hits.length).toBeGreaterThan(0);
      expect(kinds.has('product')).toBe(true);
      expect(kinds.has('party')).toBe(false);
    });

    it('returns nothing at all when the caller may view none of it', async () => {
      await seed();
      const nobody = await actorWith([]);

      expect(await search.search({ term: 'Glazed' }, nobody)).toEqual([]);
    });
  });
});
