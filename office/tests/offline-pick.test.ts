/**
 * The picker when the Master is switched off.
 *
 * The point of the whole product is that an Office PC keeps working with the
 * Master off, and a picker that goes blank the moment the link drops takes the
 * Add Lead screen with it. What this pins is the two ways serving it locally
 * could quietly become a hole:
 *
 *  · it must rank the **masked, scoped** view, never the raw snapshot, which
 *    was built for whoever was signed in when the link last worked;
 *  · it must gate on the session's permissions, because offline there is no
 *    `requirePermission` to lean on.
 */

import { describe, expect, it } from 'vitest';

import type { Party, Product, ProductCategory, SyncSnapshot } from '@orderbook/shared';

import {
  OfflinePickForbidden,
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
    size: null,
    sin: null,
    grade: null,
    productType: null,
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
    finish: null,
    series: null,
    thicknessMm: null,
    piecesPerBox: null,
    boxCoverageSqft: null,
    rate: 100,
    pricePerSqft: null,
    hsnCode: null,
    mrp: null,
    gstRatePct: null,
    uom: 'box',
    barcode: null,
    brand: null,
    shade: null,
    calibre: null,
    waterAbsorptionPct: null,
    peiRating: null,
    edgeType: null,
    surfaceTexture: null,
    application: null,
    originPlant: null,
    parameters: {},
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

  it('offers categories, and only categories, for the first stage', () => {
    const page = pickFromView('category', { term: 'tile' }, VIEW, ALL) as { items: ProductCategory[] };
    expect(page.items.map((item) => item.name)).toEqual(['Wall tiles', 'Floor tiles']);
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
});

describe('the catalogue page offline', () => {
  const VITRIFIED = { id: 'PC10', name: 'Vitrified' };
  const CERAMIC = { id: 'PC11', name: 'Ceramic' };
  const typed = {
    ...VIEW,
    products: [
      product('PR1', 'GLZ-100', 'Glazed Vitrified Tile', VITRIFIED),
      product('PR2', 'GLS-200', 'Glossy Wall Tile', CERAMIC),
      { ...product('PR3', 'RST-300', 'Rustic Floor Tile', VITRIFIED), brand: 'Kajaria' },
      product('PR4', 'UNT-400', 'Untyped', CERAMIC),
    ],
  } as unknown as SyncSnapshot;

  it('pages alphabetically by name and reports the total', () => {
    const page = listProductsFromView({ limit: 2, offset: 1 }, typed, ALL);
    expect(page.items.map((item) => item.name)).toEqual(['Glossy Wall Tile', 'Rustic Floor Tile']);
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 1 });
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
