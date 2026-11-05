/**
 * Loading the SWISWARE catalogue file (`docs/catalogue/CATALOGUE_MODEL.md` §4):
 * the real file lands as 41 products and 549 sub products, each with exactly
 * one variant coded `CODE-0001…` in catalogue order, the colour rules stored
 * the way `colourRuleOf` reads them back, the brand and the 21-colour range
 * seeded with their hex. An additive press twice changes nothing the second
 * time; a replacing reload clears what quotes the old catalogue and keeps
 * parties and the activity log.
 *
 * Loaded once per `describe`: it is 549 sub products, and every test in a
 * block reads the same result.
 */


import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { colourRuleOf, type DataChangedEvent, type LoadCatalogueResult } from '@orderbook/shared';

import { canRunIntegrationTests, testConnectionUrl } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ParsedCatalogue } from '../src/domain/catalogue-markdown.js';
import * as catalog from '../src/services/catalog.service.js';
import { onChange } from '../src/services/change-bus.js';
import {
  loadCatalogue,
  otherDatabaseClients,
  readCatalogueFile,
  seedCatalogue,
} from '../src/services/catalogue-seed.service.js';
import * as fields from '../src/services/fields.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as roleService from '../src/services/role.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import * as userService from '../src/services/user.service.js';

let CATALOGUE: ParsedCatalogue;

async function count(table: string, where: Record<string, unknown> = {}): Promise<number> {
  const row = await db()(table).where(where).count('* as n').first<{ n: string }>();
  return Number(row?.n);
}

async function liveCount(table: string, where: Record<string, unknown> = {}): Promise<number> {
  const row = await db()(table)
    .where(where)
    .whereNull('deleted_at')
    .count('* as n')
    .first<{ n: string }>();
  return Number(row?.n);
}

describe.skipIf(!canRunIntegrationTests)('loading the SWISWARE catalogue (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    CATALOGUE = await readCatalogueFile();
  });
  afterAll(teardownDatabase);

  describe('additively, as the /api/developer/load-catalogue route and seed:catalogue do', () => {
    let first: LoadCatalogueResult;
    let events: DataChangedEvent[] = [];

    beforeAll(async () => {
      await resetData();
      // With no actor given, the load runs as the installation's first
      // administrator — so there has to be one.
      const actor = await testActor();
      const role = await roleService.createRole(
        {
          name: 'Owner',
          tier: 'admin',
          permissions: ['products.create', 'products.view', 'fields.manage', 'fields.view'],
        },
        actor,
      );
      await userService.createUser(
        { username: 'owner', displayName: 'Owner', roleId: role.id },
        actor,
      );

      const stop = onChange((event) => {
        events.push(event);
      });
      try {
        first = await seedCatalogue();
      } finally {
        stop();
      }
    }, 120_000);

    it('lands every product and sub product of the file, one variant each, and nothing else', async () => {
      expect(first).toEqual({
        brands: 1,
        colours: 21,
        products: 41,
        subProducts: 549,
        skipped: 0,
        removedLeads: 0,
        removedOrders: 0,
      });
      expect(await liveCount('product_categories')).toBe(41);
      expect(await liveCount('products')).toBe(549);
      expect(await count('product_variants')).toBe(549);
      expect(await liveCount('option_lists', { list_key: 'product.brand' })).toBe(1);
    });

    it('gives each product its code, brand and catalogue order', async () => {
      const actor = await testActor();
      const rows = await catalog.listCategories(actor);
      expect(rows.map((row) => row.code)).toEqual(
        CATALOGUE.products.map((product) => product.code),
      );
      expect(rows[0]).toMatchObject({
        code: 'OPT',
        name: 'One Piece Toilet',
        brand: 'Swisware+',
        sortOrder: 1,
        subProductCount: 56,
      });
    });

    it('codes every sub product CODE-#### by its place in the product, weights blank', async () => {
      const { rows } = await db().raw<{
        rows: Array<{ code: string; expected: string; weight_kg: unknown }>;
      }>(
        `SELECT v.code, c.code || '-' || lpad(p.sort_order::text, 4, '0') AS expected, v.weight_kg
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           JOIN product_categories c ON c.id = p.category_id`,
      );
      expect(rows.filter((row) => row.code !== row.expected)).toEqual([]);
      expect(rows.filter((row) => row.weight_kg !== null)).toEqual([]);

      const actor = await testActor();
      const toilet = await catalog.findProductByCode('OPT-0001', actor);
      expect(toilet).toMatchObject({
        name: '102',
        size: '9", L-27, B-15, H-26',
        sortOrder: 1,
        categoryCode: 'OPT',
      });
    });

    it('lists sub products in catalogue order, product by product', async () => {
      const actor = await testActor();
      const products = (await catalog.listProducts({ limit: 1000 }, actor)).items;
      const expected = CATALOGUE.products.flatMap((product) =>
        product.subProducts.map((sub) => `${product.code}|${sub.name}`),
      );

      expect(products.map((product) => `${product.categoryCode}|${product.name}`)).toEqual(
        expected,
      );
    });

    it('stores every sub product so that colourRuleOf reads back the rule the file prints', async () => {
      const actor = await testActor();
      const products = (await catalog.listProducts({ limit: 1000 }, actor)).items;
      const byKey = new Map(
        products.map((product) => [`${product.categoryCode}|${product.name}`, product]),
      );

      const mismatched = CATALOGUE.products.flatMap((product) =>
        product.subProducts.flatMap((sub) => {
          const stored = byKey.get(`${product.code}|${sub.name}`);
          const label = stored?.variants[0]?.label ?? null;
          return stored &&
            colourRuleOf(stored) === sub.rule &&
            label === (sub.rule === 'fixed' ? sub.colour : null)
            ? []
            : [`${product.code} ${sub.name}`];
        }),
      );
      expect(mismatched).toEqual([]);

      // One of each, spelled out.
      expect(byKey.get('OPT|102')).toMatchObject({ hasVariants: true, multiColour: false });
      expect(byKey.get('OPT|1111')).toMatchObject({ hasVariants: false, multiColour: false });
      expect(byKey.get('WC|E.W.C - S TRAP')).toMatchObject({
        hasVariants: false,
        multiColour: true,
      });
    });

    it('seeds the colour range with the printed hex', async () => {
      const actor = await testActor();
      const { items } = await fields.listValues({ listKey: 'stock.colour' }, actor);
      const byValue = new Map(items.map((item) => [item.value, item.hex?.toUpperCase()]));
      for (const colour of CATALOGUE.colours)
        expect(byValue.get(colour.name), colour.name).toBe(colour.hex);
    });

    it('reaches a panel whole: the snapshot carries every sub product', async () => {
      // At the old page of 500 the tail of the catalogue went missing offline.
      const snapshot = await buildSnapshot(await testActor());
      expect(snapshot.products).toHaveLength(549);
      expect(snapshot.categories).toHaveLength(41);
      expect(snapshot.productsComplete).toBe(true);
    });

    it("announces the load once, and logs it once, on the administrator's behalf", async () => {
      const catalogEvents = events.filter((event) => event.entity === 'catalog');
      expect(catalogEvents).toHaveLength(1);
      expect(catalogEvents[0]).toMatchObject({
        action: 'updated',
        payload: { created: 549, skipped: 0 },
      });

      const entries = await db()('activity_log').where({ entity_type: 'catalog' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'imported',
        actor_type: 'user',
        actor_name: 'Owner',
      });
    });

    it('does nothing on a second press, and says so', async () => {
      events = [];
      const stop = onChange((event) => {
        events.push(event);
      });
      let second: LoadCatalogueResult;
      try {
        second = await seedCatalogue();
      } finally {
        stop();
      }

      expect(second).toMatchObject({
        brands: 0,
        colours: 0,
        products: 0,
        subProducts: 0,
        skipped: 549,
      });
      expect(events.filter((event) => event.entity === 'catalog')).toEqual([]);
      expect(await count('product_variants')).toBe(549);
      expect(await count('activity_log', { entity_type: 'catalog' })).toBe(1);
    });

    it('adds back only what is missing, on a code nobody holds', async () => {
      const actor = await testActor();
      const toilet = (await catalog.findProductByCode('OPT-0001', actor))!;
      await catalog.deleteProduct(toilet.id, actor);

      const third = await seedCatalogue({ actor });

      expect(third).toMatchObject({ products: 0, subProducts: 1, skipped: 548 });
      // OPT-0001 stays with the binned one, so its restore can never collide.
      const readded = await db()('products as p')
        .join('product_variants as v', 'v.product_id', 'p.id')
        .where('p.name', '102')
        .whereNull('p.deleted_at')
        .first('v.code');
      expect(readded).toMatchObject({ code: 'OPT-0057' });
    });

    it('announces a press that only switched a colour back on, so panels refresh their lists', async () => {
      const colour = CATALOGUE.colours[0]!.name;
      await db()('option_lists')
        .where({ list_key: 'stock.colour', value: colour })
        .update({ is_active: false });

      events = [];
      const stop = onChange((event) => {
        events.push(event);
      });
      let fourth: LoadCatalogueResult;
      try {
        fourth = await seedCatalogue();
      } finally {
        stop();
      }

      expect(fourth).toMatchObject({ colours: 1, subProducts: 0 });
      expect(events.filter((event) => event.entity === 'catalog')).toHaveLength(1);
    });
  });

  describe('replacing, as reload:catalog does', () => {
    it('clears what quotes the old catalogue, keeps parties and the log, and ends the same on a second run', async () => {
      await resetData();
      const actor = await testActor({ actorName: 'Catalogue reload' });

      const party = await catalog.createParty({ name: 'Kept Party' }, actor);
      const old = await catalog.createProduct(
        { name: 'Old Model', categoryName: 'Old Range', variants: [{ code: 'OLD-1' }] },
        actor,
      );
      const oldLine = { productId: old.id, variantId: old.variants[0]!.id, quantity: 1 };
      await leads.createLead({ partyId: party.id, items: [oldLine] }, actor);
      // And everything else that quotes the old model: an order, the party's own name for it.
      const converted = await leads.createLead({ partyId: party.id, items: [oldLine] }, actor);
      await orders.convertLead({ leadId: converted.id }, actor);
      await catalog.upsertVariant(
        { partyId: party.id, productId: old.id, alias: 'OLD-OWN' },
        actor,
      );
      // A colour somebody switched off comes back on, with its printed hex.
      await db()('option_lists').insert({
        id: '00000000-0000-4000-8000-000000000001',
        tenant_id: actor.tenantId,
        list_key: 'stock.colour',
        value: 'Ivory',
        label: 'Ivory',
        sequence: 1,
        is_active: false,
        hex: null,
      });
      // And one in the Recycle Bin is restored, not added again beside it.
      await db()('option_lists').insert({
        id: '00000000-0000-4000-8000-000000000002',
        tenant_id: actor.tenantId,
        list_key: 'stock.colour',
        value: 'White',
        label: 'Pure White',
        sequence: 2,
        is_active: true,
        hex: null,
        deleted_at: db().fn.now(),
      });

      const first = await loadCatalogue(CATALOGUE, actor, { replace: true });
      expect(first).toMatchObject({
        products: 41,
        subProducts: 549,
        removedLeads: 2,
        removedOrders: 1,
      });

      const second = await loadCatalogue(CATALOGUE, actor, { replace: true });
      expect(second).toMatchObject({ products: 41, subProducts: 549, colours: 0, removedLeads: 0 });

      expect(await liveCount('product_categories')).toBe(41);
      expect(await liveCount('products')).toBe(549);
      expect(await count('product_variants')).toBe(549);
      expect(await count('product_variants', { code: 'OLD-1' })).toBe(0);
      for (const table of [
        'leads',
        'orders',
        'line_items',
        'inventory_stock',
        'stock_movements',
        'stock_reservations',
        'party_product_variants',
      ])
        expect(await count(table), table).toBe(0);
      expect((await catalog.listParties({}, actor)).items.map((row) => row.name)).toEqual([
        'Kept Party',
      ]);

      expect(
        await db()('option_lists').where({ list_key: 'stock.colour', value: 'Ivory' }).first(),
      ).toMatchObject({
        is_active: true,
        hex: '#FFF4DE',
      });
      const whites = await db()('option_lists').where({ list_key: 'stock.colour', value: 'White' });
      expect(whites).toHaveLength(1);
      expect(whites[0]).toMatchObject({
        id: '00000000-0000-4000-8000-000000000002',
        label: 'Pure White',
        deleted_at: null,
        hex: '#FEFEFE',
      });

      // The log keeps what happened before — the party, the old product, the
      // lead — and gains one row per reload.
      const actions = await db()('activity_log').select('entity_type', 'action');
      expect(actions).toEqual(
        expect.arrayContaining([
          { entity_type: 'party', action: 'created' },
          { entity_type: 'product', action: 'created' },
          { entity_type: 'lead', action: 'created' },
        ]),
      );
      expect(actions.filter((row) => row.entity_type === 'catalog')).toEqual([
        { entity_type: 'catalog', action: 'reloaded' },
        { entity_type: 'catalog', action: 'reloaded' },
      ]);
    }, 120_000);

    it('names the other sessions on the database — what the CLI refuses on while a Master is up', async () => {
      const master = new pg.Client({
        connectionString: testConnectionUrl(),
        application_name: 'stand-in-master',
      });
      await master.connect();
      try {
        const others = await otherDatabaseClients(testConnectionUrl());
        expect(others.filter((who) => who === 'stand-in-master')).toHaveLength(1);
      } finally {
        await master.end();
      }
    });
  });
});
