/**
 * Loading the Swisware catalogue: the whole product master arrives through
 * the ordinary catalogue service, weights blank, and a second press changes
 * nothing.
 *
 * Seeded once for the file: it is two hundred and fifty product creates, and
 * every test here reads the same result.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DataChangedEvent, LoadCatalogueResult } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import {
  catalogueTotals,
  SWISWARE_CATALOGUE,
  SWISWARE_COLOURS,
} from '../src/domain/swisware-catalogue.js';
import * as catalog from '../src/services/catalog.service.js';
import { onChange } from '../src/services/change-bus.js';
import { seedCatalogue } from '../src/services/catalogue-seed.service.js';
import * as fields from '../src/services/fields.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

const TOTALS = catalogueTotals();

describe.skipIf(!canRunIntegrationTests)('the Swisware catalogue seed (integration)', () => {
  let first: LoadCatalogueResult;
  let events: DataChangedEvent[] = [];

  beforeAll(async () => {
    await setupDatabase();
    await resetData();

    // With no actor given, the seed runs as the installation's first
    // administrator — so there has to be one.
    const actor = await testActor();
    const role = await roleService.createRole(
      { name: 'Owner', tier: 'admin', permissions: ['products.create', 'products.view', 'fields.manage', 'fields.view'] },
      actor,
    );
    await userService.createUser({ username: 'owner', displayName: 'Owner', roleId: role.id }, actor);

    const stop = onChange((event) => {
      events.push(event);
    });
    try {
      first = await seedCatalogue();
    } finally {
      stop();
    }
  }, 120_000);
  afterAll(teardownDatabase);

  it('loads every category, model and variant the transcription holds, and nothing else', async () => {
    expect(first).toEqual({
      categories: TOTALS.categories,
      products: TOTALS.products,
      variants: TOTALS.variants,
      skipped: 0,
    });
    expect(TOTALS).toEqual({ categories: 12, products: 251, variants: 549 });

    const actor = await testActor();
    expect((await catalog.listProducts({ limit: 1 }, actor)).total).toBe(TOTALS.products);
    expect((await catalog.listCategories(actor)).map((category) => category.name)).toEqual(
      SWISWARE_CATALOGUE.map((category) => category.name).sort((a, b) => a.localeCompare(b)),
    );
    const variants = await db()('product_variants').count('* as n').first<{ n: string }>();
    expect(Number(variants?.n)).toBe(TOTALS.variants);
  });

  it('leaves every weight blank, flagged for the administrator to enter', async () => {
    const actor = await testActor();
    const weighed = await db()('product_variants').whereNotNull('weight_kg').count('* as n').first<{ n: string }>();
    expect(Number(weighed?.n)).toBe(0);
    expect((await catalog.listProducts({ missingWeight: true, limit: 1 }, actor)).total).toBe(
      TOTALS.products,
    );
  });

  it('keeps a model and its variants together, in catalogue order, with the codes as printed', async () => {
    const actor = await testActor();
    const damru = await catalog.findProductByCode('41', actor);

    expect(damru).toMatchObject({
      name: 'DAMRU',
      categoryName: 'ONE PIECE BASIN',
      hasVariants: true,
      brand: 'Swisware',
      uom: 'piece',
    });
    // The plain member first, then the patterns in the catalogue's order.
    expect(damru!.variants.slice(0, 3)).toEqual([
      expect.objectContaining({ code: 'DAMRU-WHITE', label: 'White', sequence: 1, weightKg: null }),
      expect.objectContaining({ code: '41', label: 'Vitrosa 41', sequence: 2, weightKg: null }),
      expect.objectContaining({ code: '42', label: 'Vitrosa 42', sequence: 3, weightKg: null }),
    ]);

    // A single-code product is exactly that: one unlabelled row.
    const toilet = await catalog.findProductByCode('102', actor);
    expect(toilet).toMatchObject({ categoryName: 'ONE PIECE TOILET', hasVariants: false });
    expect(toilet!.variants).toEqual([expect.objectContaining({ code: '102', label: null })]);
  });

  it('seeds the colour palette the variant labels draw their swatches from', async () => {
    const actor = await testActor();
    const { items } = await fields.listValues({ listKey: 'stock.colour' }, actor);
    const byValue = new Map(items.map((item) => [item.value, item.hex?.toLowerCase()]));
    for (const colour of SWISWARE_COLOURS) {
      expect(byValue.get(colour.value), colour.value).toBe(colour.hex.toLowerCase());
    }
  });

  it('announces the load once, as one catalogue change, on the administrator\'s behalf', async () => {
    const catalogEvents = events.filter((event) => event.entity === 'catalog');
    expect(catalogEvents).toHaveLength(1);
    expect(catalogEvents[0]).toMatchObject({
      action: 'updated',
      payload: { created: TOTALS.products, updated: 0, skipped: 0, failed: 0 },
    });

    const [entry] = await db()('activity_log').where({ entity_type: 'catalog', action: 'imported' });
    expect(entry).toMatchObject({ actor_type: 'user', actor_name: 'Owner' });
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

    expect(second).toEqual({ categories: 0, products: 0, variants: 0, skipped: TOTALS.products });
    expect(events.filter((event) => event.entity === 'catalog')).toEqual([]);
    const variants = await db()('product_variants').count('* as n').first<{ n: string }>();
    expect(Number(variants?.n)).toBe(TOTALS.variants);
  });

  it('leaves a model the administrator has been editing alone, even when only one of its codes remains', async () => {
    const actor = await testActor();
    const damru = (await catalog.findProductByCode('41', actor))!;

    // Trim DAMRU to one code and rename another of its variants: neither is
    // the catalogue's business any more.
    await catalog.updateProduct(
      damru.id,
      { name: 'DAMRU (edited)', variants: [{ id: damru.variants[0]!.id, code: '41', label: 'Vitrosa 41' }] },
      actor,
    );

    const third = await seedCatalogue({ actor });
    expect(third.products).toBe(0);
    expect((await catalog.getProduct(damru.id, actor)).name).toBe('DAMRU (edited)');
    expect((await catalog.getProduct(damru.id, actor)).variants).toHaveLength(1);
  });
});
