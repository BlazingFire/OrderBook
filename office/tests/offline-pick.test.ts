/**
 * The picker when the Master is switched off.
 *
 * The point of the whole product is that an Office PC keeps working with the
 * Master off, and a picker that goes blank the moment the link drops takes the
 * Add Lead screen with it. What this pins is the two ways serving it locally
 * could quietly become a hole:
 *
 *  · it must rank the **gated, scoped** view, never the raw snapshot, which
 *    was built for whoever was signed in when the link last worked;
 *  · it must gate on the session's permissions, because offline there is no
 *    `requirePermission` to lean on.
 */

import { describe, expect, it } from 'vitest';

import type { Party, Product, ProductCategory, SyncSnapshot } from '@orderbook/shared';

import {
  OfflinePickForbidden,
  listCategoriesFromView,
  listProductsFromView,
  pickFromView,
} from '../src/services/offline-pick.js';

const SYNC = { version: 1, hlc: 'x', fieldHlc: {}, temporaryId: null };
const NOW = '2026-08-01T00:00:00.000Z';

function product(
  id: string,
  code: string,
  name: string,
  category: { id: string; name: string } = { id: 'PC1', name: 'Tiles' },
  variants: Array<{ code: string; label: string | null }> = [{ code, label: null }],
): Product {
  return {
    id,
    tenantId: 't1',
    name,
    alias: null,
    categoryId: category.id,
    categoryName: category.name,
    categoryCode: null,
    brand: null,
    sortOrder: null,
    size: null,
    hasVariants: variants.some((variant) => variant.label !== null),
    variants: variants.map((variant, index) => ({
      id: `${id}-V${index + 1}`,
      productId: id,
      code: variant.code,
      label: variant.label,
      weightKg: null,
      sequence: index + 1,
      isActive: true,
    })),
    multiColour: false,
    customFields: {},
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    sync: SYNC,
    images: [],
  };
}

function party(id: string, name: string): Party {
  return {
    id,
    tenantId: 't1',
    name,
    partyCode: `P-${id}`,
    phone: null,
    altPhone: null,
    email: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    pincode: null,
    gstNumber: null,
    notes: null,
    customFields: {},
    isActive: true,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    sync: SYNC,
  };
}

const FLOOR = { id: 'PC1', name: 'Floor tiles' };
const WALL = { id: 'PC2', name: 'Wall tiles' };

const VIEW = {
  products: [
    product('PR1', 'GLZ-100', 'Glazed Vitrified Tile', FLOOR),
    product('PR2', 'GLS-200', 'Glossy Wall Tile', WALL),
    product('PR3', 'RST-300', 'Rustic Floor Tile', FLOOR, [
      { code: 'RST-300', label: 'Terracotta' },
      { code: 'RST-301', label: 'Slate' },
    ]),
  ],
  categories: [
    { id: FLOOR.id, tenantId: 't1', name: FLOOR.name, createdAt: NOW },
    { id: WALL.id, tenantId: 't1', name: WALL.name, createdAt: NOW },
  ],
  parties: [party('PT1', 'Patel Tiles'), party('PT2', 'Shree Ceramics')],
} as unknown as SyncSnapshot;

const ALL = ['products.view', 'parties.view'];

const codesOf = (page: { items: Product[] }) =>
  page.items.map((item) => item.variants.map((variant) => variant.code).join(','));

describe('picking offline', () => {
  it('matches a prefix of the name', () => {
    const page = pickFromView('product', { term: 'gla' }, VIEW, ALL) as { items: Product[] };
    expect(codesOf(page)).toEqual(['GLZ-100']);
  });

  it('matches a code typed in full, however the words break', () => {
    const page = pickFromView('product', { term: 'RST-300' }, VIEW, ALL) as { items: Product[] };
    expect(codesOf(page)).toEqual(['RST-300,RST-301']);
  });

  it('finds a model by any of its variant codes or colours', () => {
    expect(codesOf(pickFromView('product', { term: 'RST-301' }, VIEW, ALL) as { items: Product[] })).toEqual([
      'RST-300,RST-301',
    ]);
    expect(codesOf(pickFromView('product', { term: 'slate' }, VIEW, ALL) as { items: Product[] })).toEqual([
      'RST-300,RST-301',
    ]);
  });

  it('scopes products to the chosen category', () => {
    const page = pickFromView('product', { term: '', categoryId: FLOOR.id }, VIEW, ALL) as {
      items: Product[];
    };
    expect(page.items.map((item) => item.id).sort()).toEqual(['PR1', 'PR3']);
    expect(
      (pickFromView('product', { term: 'glossy', categoryId: FLOOR.id }, VIEW, ALL) as { items: Product[] }).items,
    ).toHaveLength(0);
  });

  it('offers categories, and only categories, for the first stage — in catalogue order', () => {
    // Neither carries a catalogue order, so the name decides, as on the Master.
    const page = pickFromView('category', { term: 'tile' }, VIEW, ALL) as { items: ProductCategory[] };
    expect(page.items.map((item) => item.name)).toEqual(['Floor tiles', 'Wall tiles']);
    expect(() => pickFromView('category', { term: '' }, VIEW, ['leads.view'])).toThrow(
      OfflinePickForbidden,
    );
  });

  it('returns everything when nothing has been typed', () => {
    const page = pickFromView('product', { term: '' }, VIEW, ALL) as { items: Product[] };
    expect(page.items).toHaveLength(3);
  });

  it('keeps an included row the term excludes', () => {
    const page = pickFromView('product', { term: 'gla', include: ['PR3'] }, VIEW, ALL) as {
      items: Product[];
    };
    expect(page.items.map((item) => item.id)).toContain('PR3');
  });

  it('says when it stopped counting', () => {
    const page = pickFromView('product', { term: '', limit: 2 }, VIEW, ALL) as {
      items: Product[];
      truncated: boolean;
    };
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it('refuses without the permission, offline as online', () => {
    // There is no `requirePermission` out here; this is its counterpart, and
    // without it the picker would be the one read path with no check at all.
    expect(() => pickFromView('product', { term: 'gla' }, VIEW, ['leads.view'])).toThrow(
      OfflinePickForbidden,
    );
  });

  it('picks parties too', () => {
    const page = pickFromView('party', { term: 'pat' }, VIEW, ALL) as { items: Party[] };
    expect(page.items.map((item) => item.name)).toEqual(['Patel Tiles']);
  });

  it('picks main products, and narrows models to one of them', () => {
    const category = (id: string, name: string): ProductCategory => ({
      id,
      tenantId: 't1',
      name,
      code: null,
      brand: null,
      sortOrder: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    });
    const named = {
      ...VIEW,
      categories: [category('C1', 'One Piece Toilet'), category('C2', 'One Piece Basin')],
      products: [
        { ...product('PR1', 'H-10', '102 (9")'), categoryId: 'C1', categoryName: 'One Piece Toilet' },
        { ...product('PR2', 'H-11', 'Damru'), categoryId: 'C2', categoryName: 'One Piece Basin' },
      ],
    } as unknown as SyncSnapshot;

    const mains = pickFromView('category', { term: 'one piece' }, named, ALL) as {
      items: ProductCategory[];
    };
    expect(mains.items.map((item) => item.name)).toEqual(['One Piece Basin', 'One Piece Toilet']);

    const models = pickFromView('product', { term: '', categoryId: 'C1' }, named, ALL) as {
      items: Product[];
    };
    expect(models.items.map((item) => item.name)).toEqual(['102 (9")']);

    // A main product with no live product on this panel is a dead end and is
    // not offered.
    const empty = { ...named, products: [] } as unknown as SyncSnapshot;
    const none = pickFromView('category', { term: '' }, empty, ALL) as {
      items: ProductCategory[];
    };
    expect(none.items).toEqual([]);
  });
});

describe('the catalogue page offline', () => {
  const VITRIFIED = { id: 'PC10', name: 'Vitrified' };
  const CERAMIC = { id: 'PC11', name: 'Ceramic' };
  const typed = {
    ...VIEW,
    products: [
      product('PR1', 'GLZ-100', 'Glazed Vitrified Tile', VITRIFIED),
      product('PR2', 'GLS-200', 'Glossy Wall Tile', CERAMIC),
      { ...product('PR3', 'RST-300', 'Rustic Floor Tile', VITRIFIED), alias: 'Kajaria rustic' },
      product('PR4', 'UNT-400', 'Untyped', CERAMIC),
    ],
  } as unknown as SyncSnapshot;

  it('pages alphabetically by name and reports the total', () => {
    const page = listProductsFromView({ limit: 2, offset: 1 }, typed, ALL);
    expect(page.items.map((item) => item.name)).toEqual(['Glossy Wall Tile', 'Rustic Floor Tile']);
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 1 });
  });

  it('sorts by a column in both directions, with a missing value last, and ignores an unknown key (1.4 R17)', () => {
    const sized = {
      ...typed,
      products: typed.products.map((entry, index) => ({
        ...entry,
        size: ['600x600', '300x300', null, '800x800'][index] ?? null,
      })),
    } as unknown as SyncSnapshot;
    const ids = (query: Parameters<typeof listProductsFromView>[0]) =>
      listProductsFromView(query, sized, ALL).items.map((item) => item.id);

    expect(ids({ sort: 'size', dir: 'asc' })).toEqual(['PR2', 'PR1', 'PR4', 'PR3']);
    expect(ids({ sort: 'size', dir: 'desc' })).toEqual(['PR4', 'PR1', 'PR2', 'PR3']);
    expect(ids({ sort: 'code', dir: 'asc' })).toEqual(['PR2', 'PR1', 'PR3', 'PR4']);
    expect(ids({ sort: 'nope', dir: 'desc' })).toEqual(ids({}));
  });

  it('filters by size and by whether there is a photo (1.4 R17)', () => {
    const sized = {
      ...typed,
      products: typed.products.map((entry, index) => ({
        ...entry,
        size: index === 0 ? '600x600' : null,
        images: index === 1 ? [{ id: 'I1' }] : [],
      })),
    } as unknown as SyncSnapshot;
    const ids = (query: Parameters<typeof listProductsFromView>[0]) =>
      listProductsFromView(query, sized, ALL).items.map((item) => item.id);

    expect(ids({ size: '600X600' })).toEqual(['PR1']);
    expect(ids({ hasPhoto: true })).toEqual(['PR2']);
    expect(ids({ hasPhoto: false })).toEqual(['PR1', 'PR4', 'PR3'].sort((a, b) => ids({}).indexOf(a) - ids({}).indexOf(b)));
  });

  it('searches the same fields the Master does, case-insensitively', () => {
    expect(listProductsFromView({ search: 'kajaria' }, typed, ALL).items.map((item) => item.id)).toEqual(['PR3']);
    expect(listProductsFromView({ search: 'gls-2' }, typed, ALL).items.map((item) => item.id)).toEqual(['PR2']);
    expect(listProductsFromView({ search: 'vitrified' }, typed, ALL).total).toBe(2);
  });

  it('filters by category while counting the facet over the search alone', () => {
    const page = listProductsFromView({ categoryId: VITRIFIED.id }, typed, ALL);
    expect(page.items.map((item) => item.id)).toEqual(['PR1', 'PR3']);
    expect(page.categories).toEqual([
      { id: CERAMIC.id, name: 'Ceramic', count: 2 },
      { id: VITRIFIED.id, name: 'Vitrified', count: 2 },
    ]);
  });

  it('lists only the models with a weight still to enter when asked', () => {
    const page = listProductsFromView({ missingWeight: true }, typed, ALL);
    // Every fixture variant has a null weight, so all four qualify.
    expect(page.total).toBe(4);
  });

  it('clamps a silly page size', () => {
    expect(listProductsFromView({ limit: 0 }, typed, ALL).limit).toBe(100);
    expect(listProductsFromView({ limit: 9999 }, typed, ALL).limit).toBe(500);
  });

  it('refuses without products.view, offline as online', () => {
    expect(() => listProductsFromView({}, typed, ['leads.view'])).toThrow(OfflinePickForbidden);
  });
});

/*
 * Catalogue v2 (`docs/catalogue/CATALOGUE_MODEL.md` §5): the product bar and
 * the sub-product bar keep the Master's catalogue order offline, so neither
 * reshuffles when the link drops or comes back.
 */
describe('the product and sub-product bars offline', () => {
  const category = (
    id: string,
    code: string | null,
    name: string,
    sortOrder: number | null,
    brand: string | null = 'Swisware+',
  ): ProductCategory => ({
    id,
    tenantId: 't1',
    name,
    code,
    brand,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  });
  const OPT = category('C1', 'OPT', 'One Piece Toilet', 1);
  const OPB = category('C2', 'OPB', 'One Piece Basin', 2);
  const WC = category('C3', 'WC', 'Water Closet', 3, 'Other Brand');
  const LOOSE = category('C4', null, 'Loose Stock', null, null);
  // `OP` is a prefix of OPT and OPB, and last in the catalogue.
  const OP = category('C5', 'OP', 'Orissa Pan', 4);

  const sub = (
    id: string,
    of: ProductCategory,
    name: string,
    sortOrder: number | null,
    code: string,
  ): Product => ({
    ...product(id, code, name, { id: of.id, name: of.name }),
    categoryCode: of.code,
    brand: of.brand,
    sortOrder,
  });

  // Sixty sub products under OPT, stored out of order: past the old default of
  // twenty, and past the old 50 cap, the bar must still list every one.
  const toilets = Array.from({ length: 60 }, (_, index) =>
    sub(
      `T${index}`,
      OPT,
      `${1100 + index}`,
      60 - index,
      `OPT-${String(60 - index).padStart(4, '0')}`,
    ),
  );
  const catalogue = {
    ...VIEW,
    categories: [WC, LOOSE, OP, OPB, OPT],
    products: [
      ...toilets,
      sub('B1', OPB, 'DAMRU', 1, 'OPB-0001'),
      sub('W1', WC, 'E.W.C - S TRAP', 1, 'WC-0001'),
      sub('L1', LOOSE, 'Odd piece', null, 'L-1'),
      sub('P1', OP, '20" O.P', 1, 'OP-0001'),
    ],
  } as unknown as SyncSnapshot;

  const names = (page: unknown) =>
    (page as { items: Array<{ name: string }> }).items.map((item) => item.name);

  it('lists products in catalogue order, a code typed in full first, and matches code, name or brand', () => {
    expect(names(pickFromView('category', { term: '' }, catalogue, ALL))).toEqual([
      'One Piece Toilet',
      'One Piece Basin',
      'Water Closet',
      'Orissa Pan',
      'Loose Stock',
    ]);
    // `WC` is an exact code, and outranks catalogue order.
    expect(names(pickFromView('category', { term: 'wc' }, catalogue, ALL))).toEqual([
      'Water Closet',
    ]);
    expect(names(pickFromView('category', { term: 'op' }, catalogue, ALL))).toEqual([
      'Orissa Pan',
      'One Piece Toilet',
      'One Piece Basin',
    ]);
    expect(names(pickFromView('category', { term: 'other brand' }, catalogue, ALL))).toEqual([
      'Water Closet',
    ]);
    expect(names(pickFromView('category', { term: 'opb' }, catalogue, ALL))[0]).toBe(
      'One Piece Basin',
    );
  });

  it('lists every sub product of a product, in catalogue order, when no limit is asked', () => {
    const page = pickFromView('product', { term: '', categoryId: OPT.id }, catalogue, ALL) as {
      items: Product[];
      truncated: boolean;
    };
    expect(page.items).toHaveLength(60);
    expect(page.truncated).toBe(false);
    expect(page.items.map((item) => item.sortOrder)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
  });

  it('narrows the sub-product bar by name anywhere or code from its start, keeping the order', () => {
    // 1150–1159 and 1115, in catalogue order — never ranked by how well they match.
    expect(
      names(pickFromView('product', { term: '115', categoryId: OPT.id }, catalogue, ALL)),
    ).toEqual([...Array.from({ length: 10 }, (_, index) => `${1159 - index}`), '1115']);
    expect(
      names(pickFromView('product', { term: 'OPT-0002', categoryId: OPT.id }, catalogue, ALL)),
    ).toEqual(['1158']);
    // A code prefix, not a code anywhere: `0002` is inside every OPT-000x code.
    expect(
      names(pickFromView('product', { term: '0002', categoryId: OPT.id }, catalogue, ALL)),
    ).toEqual([]);
  });

  it('answers the Products list from the snapshot: order, counts, search and brand', () => {
    const rows = listCategoriesFromView({}, catalogue, ALL);
    expect(rows.map((row) => [row.code, row.subProductCount])).toEqual([
      ['OPT', 60],
      ['OPB', 1],
      ['WC', 1],
      ['OP', 1],
      [null, 1],
    ]);
    expect(
      listCategoriesFromView({ search: 'opb' }, catalogue, ALL).map((row) => row.name),
    ).toEqual(['One Piece Basin']);
    expect(
      listCategoriesFromView({ brand: 'other BRAND' }, catalogue, ALL).map((row) => row.code),
    ).toEqual(['WC']);
    expect(() => listCategoriesFromView({}, catalogue, ['leads.view'])).toThrow(
      OfflinePickForbidden,
    );
  });

  it('filters the catalogue page by brand, and finds a sub product by its product code', () => {
    expect(
      listProductsFromView({ brand: 'other brand' }, catalogue, ALL).items.map((item) => item.id),
    ).toEqual(['W1']);
    expect(
      listProductsFromView({ search: 'opb' }, catalogue, ALL).items.map((item) => item.id),
    ).toEqual(['B1']);
  });
});
