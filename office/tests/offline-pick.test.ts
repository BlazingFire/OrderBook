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

import type { Party, Product, SyncSnapshot } from '@orderbook/shared';

import {
  OfflinePickForbidden,
  listProductsFromView,
  pickFromView,
} from '../src/services/offline-pick.js';

const SYNC = { version: 1, hlc: 'x', fieldHlc: {}, temporaryId: null };
const NOW = '2026-08-01T00:00:00.000Z';

function product(id: string, code: string, name: string): Product {
  return {
    id,
    tenantId: 't1',
    productCode: code,
    name,
    alias: null,
    categoryId: null,
    categoryName: null,
    size: null,
    sin: null,
    grade: null,
    productType: null,
    weightKg: null,
    finish: null,
    series: null,
    color: null,
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

const VIEW = {
  products: [
    product('PR1', 'GLZ-100', 'Glazed Vitrified Tile'),
    product('PR2', 'GLS-200', 'Glossy Wall Tile'),
    product('PR3', 'RST-300', 'Rustic Floor Tile'),
  ],
  parties: [party('PT1', 'Patel Tiles'), party('PT2', 'Shree Ceramics')],
} as unknown as SyncSnapshot;

const ALL = ['products.view', 'parties.view'];

describe('picking offline', () => {
  it('matches a prefix of the name', () => {
    const page = pickFromView('product', { term: 'gla' }, VIEW, ALL) as { items: Product[] };
    expect(page.items.map((item) => item.productCode)).toEqual(['GLZ-100']);
  });

  it('matches a code typed in full, however the words break', () => {
    const page = pickFromView('product', { term: 'RST-300' }, VIEW, ALL) as { items: Product[] };
    expect(page.items.map((item) => item.productCode)).toEqual(['RST-300']);
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
  const typed = {
    ...VIEW,
    products: [
      { ...product('PR1', 'GLZ-100', 'Glazed Vitrified Tile'), productType: 'Vitrified' },
      { ...product('PR2', 'GLS-200', 'Glossy Wall Tile'), productType: 'Ceramic' },
      { ...product('PR3', 'RST-300', 'Rustic Floor Tile'), productType: 'Vitrified', brand: 'Kajaria' },
      product('PR4', 'UNT-400', 'Untyped'),
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

  it('filters by type while counting the facet over the search alone', () => {
    const page = listProductsFromView({ productType: 'Vitrified' }, typed, ALL);
    expect(page.items.map((item) => item.id)).toEqual(['PR1', 'PR3']);
    expect(page.productTypes).toEqual([
      { value: 'Ceramic', count: 1 },
      { value: 'Vitrified', count: 2 },
    ]);
  });

  it('clamps a silly page size', () => {
    expect(listProductsFromView({ limit: 0 }, typed, ALL).limit).toBe(100);
    expect(listProductsFromView({ limit: 9999 }, typed, ALL).limit).toBe(500);
  });

  it('refuses without products.view, offline as online', () => {
    expect(() => listProductsFromView({}, typed, ['leads.view'])).toThrow(OfflinePickForbidden);
  });
});
