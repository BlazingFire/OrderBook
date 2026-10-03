/**
 * Role-based access (docs/LEAD_GENERATION_FLOW.md §1, §9.5).
 *
 * The thing asserted that a screenshot could not show: a refusal **names the
 * permission it wanted**, so an operator can tell a broken screen from one
 * they lack access to.
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
    { categoryName: 'Tiles', variants: [{ code: 'PRM-01' }], name: 'Glazed Tile' },
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
          variantId: product.variants[0]!.id,
          quantity: 4,
          packaging: 'carton',
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
                variantId: product.variants[0]!.id,
                quantity: 1,
                packaging: 'carton',
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
              variantId: product.variants[0]!.id,
              quantity: 2,
              packaging: 'carton',
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
                variantId: product.variants[0]!.id,
                quantity: 1,
                packaging: 'carton',
              },
            ],
          },
          officeUser,
        ),
      ).rejects.toThrow(/Missing permission: record\.reassignOwner/);
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
