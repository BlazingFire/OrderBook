/**
 * Rust sidecar parity for picker scoring (`lib/pick-via-rust.ts`,
 * `services/offline-pick.ts`).
 *
 * The fallback path (no helper binary on this checkout) must order exactly
 * like the sync `pickScore`/`pickFromView` it stands in for; when a binary
 * is present the same assertions prove the Rust answers byte-for-byte.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Party, Product, SyncSnapshot } from '@orderbook/shared';
import { pickScore } from '@orderbook/shared';

import { pickScoresViaRust } from '../src/lib/pick-via-rust.js';
import { resetRustBridgeForTest, tryHelper } from '../src/lib/rust-bridge.js';
import {
  OfflinePickForbidden,
  pickFromView,
  pickFromViewAsync,
} from '../src/services/offline-pick.js';

const SYNC = { version: 1, hlc: 'x', fieldHlc: {}, temporaryId: null };
const NOW = '2026-08-01T00:00:00.000Z';

function product(id: string, code: string, name: string): Product {
  return {
    id,
    tenantId: 't1',
    name,
    alias: null,
    categoryId: 'PC1',
    categoryName: 'Tiles',
    categoryCode: null,
    brand: null,
    sortOrder: null,
    size: null,
    hasVariants: false,
    variants: [
      {
        id: `${id}-V1`,
        productId: id,
        code,
        label: null,
        weightKg: null,
        sequence: 1,
        isActive: true,
      },
    ],
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

const VIEW = {
  products: [
    product('PR1', 'GLZ-100', 'Glazed Vitrified Tile'),
    product('PR2', 'MAT-200', 'Ivory Matt Finish'),
    product('PR3', 'RST-300', 'Rustic Formatted Tile'),
  ],
  categories: [{ id: 'PC1', tenantId: 't1', name: 'Tiles', createdAt: NOW }],
  parties: [party('PT1', 'Patel Tiles'), party('PT2', 'Shree Ceramics')],
} as unknown as SyncSnapshot;

const ALL = ['products.view', 'parties.view'];

const FIELDS: Array<Array<string | null | undefined>> = [
  ['GLZ-100', 'Glazed Vitrified Tile', null],
  ['MAT-200', 'Ivory Matt Finish', undefined],
  ['RST-300', 'Rustic Formatted Tile', ''],
  ['Formatted Tile', 'MATT', 'x'],
];

afterEach(() => {
  delete process.env.ORDERBOOK_RUST_HELPER;
  resetRustBridgeForTest();
});

describe('pick scores via Rust', () => {
  it('scores every row exactly like pickScore', async () => {
    for (const term of ['matt', 'tile', 'GLZ', '(matt', '  ']) {
      const expected = FIELDS.map((row) => pickScore(row, term));
      await expect(pickScoresViaRust(FIELDS, term)).resolves.toEqual(expected);
    }
  });

  it('falls back row by row when the helper is missing', async () => {
    process.env.ORDERBOOK_RUST_HELPER = 'C:\\definitely-not-here\\orderbook-helper.exe';
    resetRustBridgeForTest();
    await expect(tryHelper({ op: 'pickBatch', rows: [['a']], term: 'a' })).resolves.toBeNull();
    await expect(pickScoresViaRust(FIELDS, 'matt')).resolves.toEqual(
      FIELDS.map((row) => pickScore(row, 'matt')),
    );
  });
});

describe('pickFromViewAsync', () => {
  it('orders ranked branches exactly like the sync view', async () => {
    for (const [kind, query] of [
      ['product', { term: 'matt' }],
      ['product', { term: '' }],
      ['product', { term: 'tile', limit: 2 }],
      ['party', { term: 'pat' }],
      ['party', { term: '' }],
      ['category', { term: 'tile' }],
    ] as const) {
      await expect(pickFromViewAsync(kind, query, VIEW, ALL)).resolves.toEqual(
        pickFromView(kind, query, VIEW, ALL),
      );
    }
  });

  it('keeps the permission gate, asynchronously', async () => {
    await expect(pickFromViewAsync('product', { term: 'matt' }, VIEW, [])).rejects.toBeInstanceOf(
      OfflinePickForbidden,
    );
  });
});
