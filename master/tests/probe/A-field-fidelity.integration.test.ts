/**
 * Probe, lens A: field fidelity of the product backup zip.
 *
 * Builds a catalogue through the ordinary services (the screens' own paths),
 * dumps every product-related table a person can set (ids and timestamps
 * aside), exports the zip, and restores it (1) into an emptied catalogue and
 * (2) over the same catalogue. Each test compares one part of the dump, so a
 * failure names exactly the field a round trip lost or altered.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../../src/domain/actor.js';
import { db } from '../../src/db/knex.js';
import * as customFieldRepo from '../../src/repositories/custom-field.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import * as fields from '../../src/services/fields.service.js';
import { importProducts } from '../../src/services/product-import.service.js';
import {
  exportProductZip,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from '../helpers/fixtures.js';

let admin: ActorContext;
let dir: string;

async function exported(): Promise<string> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return file;
}

async function emptyAll(): Promise<void> {
  await resetData();
  customFieldRepo.invalidateFieldCache();
}

/** Every product-related value a person can set, in catalogue order, no ids or timestamps. */
async function dump() {
  const tenantId = admin.tenantId;
  const mains = await db()('product_categories')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .orderByRaw('sort_order ASC NULLS LAST, lower(name) ASC, id ASC')
    .select('name', 'code', 'brand', 'sort_order');
  const products = await db()('products as p')
    .join('product_categories as c', 'c.id', 'p.category_id')
    .where('p.tenant_id', tenantId)
    .whereNull('p.deleted_at')
    .orderByRaw(
      'c.sort_order ASC NULLS LAST, lower(c.name) ASC, p.sort_order ASC NULLS LAST, lower(p.name) ASC, p.id ASC',
    )
    .select(
      'p.id',
      'c.code as main',
      'c.name as main_name',
      'c.brand as main_brand',
      'p.name',
      'p.alias',
      'p.size',
      'p.has_variants',
      'p.multi_colour',
      'p.is_active',
      'p.custom_fields',
    );
  const subs = [];
  for (const { id, ...product } of products) {
    const variants = await db()('product_variants')
      .where({ product_id: id })
      .whereNull('deleted_at')
      .orderBy('sequence')
      .select('code', 'label', db().raw('weight_kg::text as weight_kg'), 'is_active');
    subs.push({ ...product, variants });
  }
  const list = (listKey: string) =>
    db()('option_lists')
      .where({ tenant_id: tenantId, list_key: listKey })
      .whereNull('deleted_at')
      .orderBy('sequence')
      .select('value', 'label', 'hex', 'is_active');
  return {
    mains,
    subs,
    colours: await list('stock.colour'),
    brands: await list('product.brand'),
  };
}

const value = (listKey: 'stock.colour' | 'product.brand', v: string, hex: string | null = null, label = v) =>
  fields.createValue({ listKey, value: v, label, hex }, admin);

/** The catalogue every test starts from: only values the screens can set. */
async function build(): Promise<void> {
  await value('product.brand', 'Swisware+');
  await value('product.brand', 'Brand Two');

  const white = await value('stock.colour', 'White', '#ffffff');
  const ivory = await value('stock.colour', 'Ivory');
  const magenta = await value('stock.colour', 'Magenta', '#ff00ff');
  const hindi = await value('stock.colour', 'सफ़ेद', '#fafafa');
  // A colour list order that is neither creation nor alphabetical order.
  await fields.reorderValues(
    { listKey: 'stock.colour', ids: [magenta.id, white.id, hindi.id, ivory.id] },
    admin,
  );

  // Main products, in an Order that is not alphabetical; WASH BASIN twice, under two brands.
  const opt = await catalog.createCategory({ name: 'ONE PIECE TOILET', code: 'OPT', brand: 'Swisware+', sortOrder: 1 }, admin);
  const wb1 = await catalog.createCategory({ name: 'WASH BASIN', code: 'WB1', brand: 'Swisware+', sortOrder: 2 }, admin);
  const wb2 = await catalog.createCategory({ name: 'WASH BASIN', code: 'WB2', brand: 'Brand Two', sortOrder: 3 }, admin);
  const seat = await catalog.createCategory({ name: 'Seat, "Covers"', code: 'Sc9', brand: 'Brand Two', sortOrder: 4 }, admin);
  await catalog.createCategory({ name: 'EMPTY MAIN', code: 'EMPTY1', brand: null, sortOrder: 5 }, admin);

  const sub = (categoryId: string, name: string, rest: Record<string, unknown>) =>
    catalog.createProduct({ categoryId, name, ...rest } as never, admin);

  // A fixed sub product with three colours, in an order that is not alphabetical.
  await sub(opt.id, 'DAMRU', {
    alias: 'Dmr',
    size: '10-12',
    sortOrder: 2,
    hasVariants: true,
    variants: [
      { code: 'OPT-0003', label: 'Magenta', weightKg: 1234567.891 },
      { code: 'OPT-0001', label: 'White', weightKg: 12.345 },
      { code: 'opt/0002', label: 'Ivory', weightKg: null },
    ],
  });
  // Dedicated, a code with leading zeros, the smallest weight, a size with an inch mark.
  await sub(opt.id, '102', {
    size: '9"',
    sortOrder: 1,
    hasVariants: false,
    variants: [{ code: '00123', label: null, weightKg: 0.001 }],
  });
  // Multicolour, mixed-case code.
  await sub(opt.id, 'MULTI', {
    size: 'L-27 B-15 H-26',
    sortOrder: 3,
    multiColour: true,
    hasVariants: false,
    variants: [{ code: 'Mc-1', label: null, weightKg: 7 }],
  });
  // Has variants, but only one.
  await sub(opt.id, 'SINGLE FIXED', {
    sortOrder: 4,
    hasVariants: true,
    variants: [{ code: 'SF-1', label: 'White', weightKg: 5.5 }],
  });
  await sub(wb1.id, 'Basin, "Royal"', {
    alias: 'Royal, "the"',
    hasVariants: false,
    variants: [{ code: 'WB1-1', label: null, weightKg: null }],
  });
  await sub(wb1.id, 'हिंदी नाम', {
    alias: 'नाम',
    hasVariants: true,
    variants: [{ code: 'ÄÖ-ü1', label: 'सफ़ेद', weightKg: 2.25 }],
  });
  // Cells the CSV writer guards against formulas: they must come back without the guard.
  await sub(wb2.id, '-Minus', {
    alias: '@home',
    size: '=5',
    hasVariants: false,
    variants: [{ code: '+91-1', label: null, weightKg: null }],
  });
  await sub(wb2.id, 'Basin, "Royal"', {
    hasVariants: false,
    variants: [{ code: 'WB2-1', label: null, weightKg: 3 }],
  });
  // Sub product order inside a main product that is not alphabetical.
  await sub(seat.id, 'ZZZ', { sortOrder: 1, hasVariants: false, variants: [{ code: 'SC-Z', label: null }] });
  await sub(seat.id, 'AAA', { sortOrder: 2, hasVariants: false, variants: [{ code: 'SC-A', label: null }] });
}

/** Rank of each main product in catalogue order: what a person sees as "the order". */
const ranks = (mains: Array<{ code: string }>) => mains.map((main) => main.code);

describe.skipIf(!canRunIntegrationTests)('probe A: product backup zip field fidelity', () => {
  beforeAll(async () => {
    await setupDatabase();
  }, 120_000);
  afterAll(async () => {
    await teardownDatabase();
  });
  beforeEach(async () => {
    await emptyAll();
    admin = await testActor();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-a-'));
  });

  describe('restored into an emptied catalogue', () => {
    let before: Awaited<ReturnType<typeof dump>>;
    let after: Awaited<ReturnType<typeof dump>>;
    let problems: unknown[];
    let failed: number;

    beforeEach(async () => {
      await build();
      before = await dump();
      const file = await exported();
      await emptyAll();
      const report = await restoreProductZip(file, 'p.zip', {}, admin);
      problems = report.problems;
      failed = report.products.failed;
      after = await dump();
    });

    it('A-e0 restores with no problems and no failed rows', () => {
      expect({ problems, failed }).toEqual({ problems: [], failed: 0 });
    });

    it('A-e1 keeps every main product: name, code, brand, and the order they list in', () => {
      expect(after.mains.map(({ sort_order: _s, ...main }) => main)).toEqual(
        before.mains.map(({ sort_order: _s, ...main }) => main),
      );
      expect(ranks(after.mains)).toEqual(ranks(before.mains));
    });

    it('A-e2 keeps every sub product field and every variant (code, colour, weight, order)', () => {
      expect(after.subs).toEqual(before.subs);
    });

    it('A-e3 keeps the colour list: values, hex, order', () => {
      expect(after.colours.map(({ value: v, hex }) => ({ v, hex }))).toEqual(
        before.colours.map(({ value: v, hex }) => ({ v, hex })),
      );
    });

    it('A-e4 keeps the brand list', () => {
      expect(after.brands).toEqual(before.brands);
    });
  });

  it('A-e5 keeps the main product Order a person typed (Main products screen, Order field)', async () => {
    await value('product.brand', 'Swisware+');
    const a = await catalog.createCategory({ name: 'A FIRST', code: 'AF', brand: 'Swisware+', sortOrder: 10 }, admin);
    await catalog.createCategory({ name: 'B SECOND', code: 'BS', brand: 'Swisware+', sortOrder: 20 }, admin);
    await catalog.createCategory({ name: 'C UNORDERED', code: 'CU', brand: 'Swisware+', sortOrder: null }, admin);
    await catalog.createProduct({ categoryId: a.id, name: 'X', hasVariants: false, variants: [{ code: 'AF-1', label: null }] }, admin);
    const before = (await dump()).mains;
    const file = await exported();
    await emptyAll();
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = (await dump()).mains;
    expect(after).toEqual(before);
  });

  it('A-e8 keeps the brand list order a person set in Fields', async () => {
    const zeta = await value('product.brand', 'Zeta');
    const alpha = await value('product.brand', 'Alpha');
    await fields.reorderValues({ listKey: 'product.brand', ids: [zeta.id, alpha.id] }, admin);
    // Alpha's main product lists first in the catalogue.
    const a = await catalog.createCategory({ name: 'A', code: 'A', brand: 'Alpha', sortOrder: 1 }, admin);
    const z = await catalog.createCategory({ name: 'Z', code: 'Z', brand: 'Zeta', sortOrder: 2 }, admin);
    await catalog.createProduct({ categoryId: a.id, name: 'S', hasVariants: false, variants: [{ code: 'A-1', label: null }] }, admin);
    await catalog.createProduct({ categoryId: z.id, name: 'S', hasVariants: false, variants: [{ code: 'Z-1', label: null }] }, admin);
    const before = (await dump()).brands.map((brand) => brand.value);
    const file = await exported();
    await emptyAll();
    await restoreProductZip(file, 'p.zip', {}, admin);
    expect((await dump()).brands.map((brand) => brand.value)).toEqual(before);
  });

  describe('main products with no code (made by the product form or an import that names a new main product)', () => {
    async function buildCodeless(): Promise<void> {
      await value('product.brand', 'B');
      // A code-less BASIN with no brand (made first, so the form's name creates it), a coded
      // BASIN under brand B, and a code-less TANK under brand B.
      await catalog.createProduct({ categoryName: 'BASIN', categoryBrand: null, name: 'S2', hasVariants: false, variants: [{ code: 'NB-1', label: null }] } as never, admin);
      const coded = await catalog.createCategory({ name: 'BASIN', code: 'CB', brand: 'B', sortOrder: 1 }, admin);
      await catalog.createProduct({ categoryId: coded.id, name: 'S1', hasVariants: false, variants: [{ code: 'CB-1', label: null }] }, admin);
      await catalog.createProduct({ categoryName: 'TANK', categoryBrand: 'B', name: 'S3', hasVariants: false, variants: [{ code: 'T-1', label: null }] } as never, admin);
    }

    it('A-c1 restore into an emptied catalogue keeps them and their sub products where they were', async () => {
      await buildCodeless();
      const before = await dump();
      expect(before.mains.filter((main) => main.code === null)).toHaveLength(2);
      const file = await exported();
      await emptyAll();
      const report = await restoreProductZip(file, 'p.zip', {}, admin);
      const after = await dump();
      expect({
        failed: report.products.failed,
        mains: after.mains.map(({ sort_order: _s, ...main }) => main),
        subs: after.subs,
      }).toEqual({
        failed: 0,
        mains: before.mains.map(({ sort_order: _s, ...main }) => main),
        subs: before.subs,
      });
    });

    it('A-c2 restore over the same catalogue reads as unchanged', async () => {
      await buildCodeless();
      const before = await dump();
      const file = await exported();
      const preview = await previewProductZip(file, 'p.zip', admin);
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect({
        added: preview.mainProducts.added,
        changed: preview.rows.changed,
        problems: preview.problems,
        after: await dump(),
      }).toEqual({ added: [], changed: [], problems: [], after: before });
    });

    it('A-c3 a code-less main product whose name has a double space comes back once, holding its sub product', async () => {
      await value('product.brand', 'B');
      await catalog.createProduct({ categoryName: 'WALL  HUNG', categoryBrand: 'B', name: 'S', hasVariants: false, variants: [{ code: 'W-1', label: null }] } as never, admin);
      const before = await dump();
      const file = await exported();
      await emptyAll();
      await restoreProductZip(file, 'p.zip', {}, admin);
      const after = await dump();
      expect({ mains: after.mains.map((main) => main.name), subs: after.subs }).toEqual({
        mains: before.mains.map((main) => main.name),
        subs: before.subs,
      });
    });
  });

  it('A-c4 demonstrates: the same code-less double-space main product, restored over the same catalogue, gets a twin', async () => {
    await value('product.brand', 'B');
    await catalog.createProduct({ categoryName: 'WALL  HUNG', categoryBrand: 'B', name: 'S', hasVariants: false, variants: [{ code: 'W-1', label: null }] } as never, admin);
    const before = await dump();
    const file = await exported();
    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = await dump();
    expect({ changed: preview.rows.changed, mains: after.mains.map((main) => main.name), subs: after.subs }).toEqual({
      changed: [],
      mains: before.mains.map((main) => main.name),
      subs: before.subs,
    });
  });

  describe('two sub products of one main product sharing a name (a second import makes them; the name rule only guards the form)', () => {
    async function buildTwins(): Promise<void> {
      await value('product.brand', 'B');
      await catalog.createCategory({ name: 'M', code: 'M', brand: 'B', sortOrder: 1 }, admin);
      const csv = (code: string) =>
        Buffer.from(
          `Brand,Main product code,Main product,Sub product,Size,Colour rule,Colour,Code,Weight (kg),Alias\r\nB,M,M,TWIN,,dedicated,,${code},,\r\n`,
          'utf8',
        );
      await importProducts({ buffer: csv('TW-1'), fileName: 'a.csv' }, { dryRun: false, mode: 'create' }, admin);
      await importProducts({ buffer: csv('TW-2'), fileName: 'b.csv' }, { dryRun: false, mode: 'create' }, admin);
    }

    it('A-t1 demonstrates: restore into an emptied catalogue keeps one twin and refuses the other', async () => {
      await buildTwins();
      const before = (await dump()).subs;
      expect(before.map((sub) => sub.variants[0]?.code)).toEqual(['TW-1', 'TW-2']);
      const file = await exported();
      await emptyAll();
      const report = await restoreProductZip(file, 'p.zip', {}, admin);
      expect({ failed: report.products.failed, subs: (await dump()).subs }).toEqual({ failed: 0, subs: before });
    });

    it('A-t3 demonstrates: twins with a colour each come back merged into one sub product with two colours', async () => {
      await value('product.brand', 'B');
      await catalog.createCategory({ name: 'M', code: 'M', brand: 'B', sortOrder: 1 }, admin);
      const csv = (colour: string, code: string) =>
        Buffer.from(
          `Brand,Main product code,Main product,Sub product,Size,Colour rule,Colour,Code,Weight (kg),Alias\r\nB,M,M,TWIN,,fixed,${colour},${code},,\r\n`,
          'utf8',
        );
      await importProducts({ buffer: csv('White', 'TW-W'), fileName: 'a.csv' }, { dryRun: false, mode: 'create' }, admin);
      await importProducts({ buffer: csv('Black', 'TW-B'), fileName: 'b.csv' }, { dryRun: false, mode: 'create' }, admin);
      const before = (await dump()).subs;
      expect(before).toHaveLength(2);
      const file = await exported();
      await emptyAll();
      const report = await restoreProductZip(file, 'p.zip', {}, admin);
      expect({ failed: report.products.failed, subs: (await dump()).subs }).toEqual({ failed: 0, subs: before });
    });

    it('A-t2 demonstrates: an unedited export over the same catalogue fails one twin as a duplicate row', async () => {
      await buildTwins();
      const file = await exported();
      const preview = await previewProductZip(file, 'p.zip', admin);
      expect({ failed: preview.products.failed, unchanged: preview.products.unchanged, issues: preview.products.issues.map((issue) => issue.messageKey) }).toEqual({
        failed: 0,
        unchanged: 2,
        issues: [],
      });
    });
  });

  it('A-e6 keeps a colour switched off and a colour label renamed in Fields', async () => {
    await value('stock.colour', 'White', '#ffffff', 'Pure White');
    const off = await value('stock.colour', 'Retired', '#123456');
    await fields.updateValue(off.id, { isActive: false, expectedVersion: off.version }, admin);
    await value('stock.colour', 'Ivory');
    await value('product.brand', 'B');
    const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B' }, admin);
    await catalog.createProduct(
      { categoryId: main.id, name: 'S', hasVariants: true, variants: [{ code: 'M-1', label: 'White' }] },
      admin,
    );
    const before = (await dump()).colours;
    const file = await exported();
    await emptyAll();
    await restoreProductZip(file, 'p.zip', {}, admin);
    expect((await dump()).colours).toEqual(before);
  });

  it('A-e7 keeps a brand with no main product, a brand label renamed in Fields, and a brand switched off', async () => {
    await value('product.brand', 'SWP', null, 'Swisware Plus');
    await value('product.brand', 'Unused Brand');
    const off = await value('product.brand', 'Old Brand');
    const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'SWP' }, admin);
    const old = await catalog.createCategory({ name: 'N', code: 'N', brand: 'Old Brand' }, admin);
    await fields.updateValue(off.id, { isActive: false, expectedVersion: off.version }, admin);
    await catalog.createProduct({ categoryId: main.id, name: 'S', hasVariants: false, variants: [{ code: 'M-1', label: null }] }, admin);
    await catalog.createProduct({ categoryId: old.id, name: 'S', hasVariants: false, variants: [{ code: 'N-1', label: null }] }, admin);
    const before = (await dump()).brands;
    const file = await exported();
    await emptyAll();
    await restoreProductZip(file, 'p.zip', {}, admin);
    expect((await dump()).brands).toEqual(before);
  });

  describe('restored over the same catalogue', () => {
    it('A-s1 an unedited export reads as unchanged, writes nothing, and a second run changes nothing', async () => {
      await build();
      const before = await dump();
      const file = await exported();

      const preview = await previewProductZip(file, 'p.zip', admin);
      expect(preview.products).toMatchObject({ created: 0, updated: 0, failed: 0, skipped: 0 });
      expect(preview.mainProducts).toEqual({ added: [], renamed: [] });
      expect(preview.rows).toEqual({ added: [], changed: [], notInFile: [] });
      expect(preview.colours).toEqual({ added: [], changed: [] });
      expect(preview.problems).toEqual([]);

      const first = await restoreProductZip(file, 'p.zip', {}, admin);
      expect(first.products).toMatchObject({ created: 0, updated: 0, failed: 0 });
      expect(await dump()).toEqual(before);
      const second = await restoreProductZip(file, 'p.zip', {}, admin);
      expect(second.products).toMatchObject({ created: 0, updated: 0, failed: 0 });
      expect(await dump()).toEqual(before);
    });

    it('A-s2 an emptied-then-restored catalogue restored again from the same zip changes nothing', async () => {
      await build();
      const file = await exported();
      await emptyAll();
      await restoreProductZip(file, 'p.zip', {}, admin);
      const once = await dump();
      const again = await restoreProductZip(file, 'p.zip', {}, admin);
      expect({
        products: again.products.created + again.products.updated,
        mains: again.mainProducts,
        colours: again.colours,
        rows: again.rows.changed,
        problems: again.problems,
      }).toEqual({ products: 0, mains: { added: [], renamed: [] }, colours: { added: [], changed: [] }, rows: [], problems: [] });
      expect(await dump()).toEqual(once);
    });
  });

  describe('a sub product the form marks both "has colours" and "multicolour"', () => {
    async function buildBoth(variants: Array<{ code: string; label: string }>) {
      await value('stock.colour', 'White');
      await value('stock.colour', 'Ivory');
      await value('product.brand', 'B');
      const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B' }, admin);
      await catalog.createProduct(
        { categoryId: main.id, name: 'BOTH', multiColour: true, hasVariants: true, variants },
        admin,
      );
    }

    it('A-m1 demonstrates: two colours come back refused (empty restore) instead of restored', async () => {
      await buildBoth([
        { code: 'B-1', label: 'White' },
        { code: 'B-2', label: 'Ivory' },
      ]);
      const before = (await dump()).subs;
      const file = await exported();
      await emptyAll();
      const report = await restoreProductZip(file, 'p.zip', {}, admin);
      expect({ failed: report.products.failed, subs: (await dump()).subs }).toEqual({ failed: 0, subs: before });
    });

    it('A-m2 demonstrates: one colour loses its colour and its has-colours switch (empty restore)', async () => {
      await buildBoth([{ code: 'B-1', label: 'White' }]);
      const before = (await dump()).subs;
      const file = await exported();
      await emptyAll();
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect((await dump()).subs).toEqual(before);
    });

    it('A-m3 demonstrates: an unedited export over the same catalogue renames its colours', async () => {
      await buildBoth([
        { code: 'B-1', label: 'White' },
        { code: 'B-2', label: 'Ivory' },
      ]);
      const before = (await dump()).subs;
      const file = await exported();
      const preview = await previewProductZip(file, 'p.zip', admin);
      const run = await restoreProductZip(file, 'p.zip', {}, admin);
      expect({
        previewUpdated: preview.products.updated,
        previewFailed: preview.products.failed,
        changed: run.rows.changed,
        subs: (await dump()).subs,
      }).toEqual({ previewUpdated: 0, previewFailed: 0, changed: [], subs: before });
    });
  });

  describe('text the form keeps as typed', () => {
    it('A-w1 a double space inside a sub product name, alias, size and colour survives an empty restore', async () => {
      await value('stock.colour', 'Off  White');
      await value('product.brand', 'B');
      const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B' }, admin);
      await catalog.createProduct(
        {
          categoryId: main.id,
          name: 'TWO  SPACES',
          alias: 'a  b',
          size: 'L-27  B-15',
          hasVariants: true,
          variants: [{ code: 'M-1', label: 'Off  White' }],
        },
        admin,
      );
      const before = (await dump()).subs;
      const file = await exported();
      await emptyAll();
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect((await dump()).subs).toEqual(before);
    });

    it('A-w2 the same, restored over the same catalogue, reads as unchanged and changes nothing', async () => {
      await value('stock.colour', 'Off  White');
      await value('product.brand', 'B');
      const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B' }, admin);
      await catalog.createProduct(
        {
          categoryId: main.id,
          name: 'TWO  SPACES',
          alias: 'a  b',
          size: 'L-27  B-15',
          hasVariants: true,
          variants: [{ code: 'M-1', label: 'Off  White' }],
        },
        admin,
      );
      const before = (await dump()).subs;
      const file = await exported();
      const preview = await previewProductZip(file, 'p.zip', admin);
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect({ changed: preview.rows.changed, subs: (await dump()).subs }).toEqual({ changed: [], subs: before });
    });

    it('A-w3 a colour typed in another case than the colour list survives a restore over the same catalogue', async () => {
      await value('stock.colour', 'White');
      await value('product.brand', 'B');
      const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B' }, admin);
      await catalog.createProduct(
        { categoryId: main.id, name: 'S', hasVariants: true, variants: [{ code: 'M-1', label: 'WHITE' }] },
        admin,
      );
      const before = (await dump()).subs;
      const file = await exported();
      const preview = await previewProductZip(file, 'p.zip', admin);
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect({ changed: preview.rows.changed, subs: (await dump()).subs }).toEqual({ changed: [], subs: before });
    });

    it('A-w4 a value that starts with an apostrophe before - = + @ keeps its apostrophe', async () => {
      await value('product.brand', 'B');
      const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B' }, admin);
      await catalog.createProduct(
        { categoryId: main.id, name: "'-90 BEND", alias: "'+1", hasVariants: false, variants: [{ code: "'-1", label: null }] },
        admin,
      );
      const before = (await dump()).subs;
      const file = await exported();
      await emptyAll();
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect((await dump()).subs).toEqual(before);
    });
  });
});
