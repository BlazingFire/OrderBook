/**
 * Row mapping is where node-postgres's string-typed NUMERIC/BIGINT values get
 * normalised, so these tests pin the coercions that everything downstream
 * assumes.
 */

import { describe, expect, it } from 'vitest';

import {
  firstCount,
  mapLead,
  mapLeadItem,
  mapParty,
  mapProduct,
  toIso,
  toNumber,
  toRequiredIso,
  toRequiredNumber,
} from '../src/repositories/mappers.js';

describe('toNumber', () => {
  it('parses the strings Postgres returns for NUMERIC columns', () => {
    expect(toNumber('12.50')).toBe(12.5);
    expect(toNumber('0')).toBe(0);
    expect(toNumber('-3')).toBe(-3);
  });

  it('passes numbers through', () => {
    expect(toNumber(42)).toBe(42);
  });

  it('maps absent values to null rather than 0, so "no price" stays distinct from "free"', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });

  it('returns null for values that are not numeric at all', () => {
    expect(toNumber('abc')).toBeNull();
    expect(toNumber({})).toBeNull();
  });

  it('treats an empty string as null, not as zero', () => {
    // Number('') is 0, which would silently turn a blank column into a real
    // quantity — this asserts we do not inherit that behaviour.
    expect(toNumber('')).toBeNull();
  });
});

describe('toRequiredNumber', () => {
  it('falls back to 0 for NOT NULL columns', () => {
    expect(toRequiredNumber('7')).toBe(7);
    expect(toRequiredNumber(null)).toBe(0);
  });
});

describe('toIso', () => {
  it('serialises Date objects', () => {
    expect(toIso(new Date('2026-08-20T10:15:00.000Z'))).toBe('2026-08-20T10:15:00.000Z');
  });

  it('returns null for missing timestamps', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  it('always produces a string for NOT NULL timestamp columns', () => {
    expect(typeof toRequiredIso(null)).toBe('string');
  });
});

describe('firstCount', () => {
  it('parses the string Postgres returns for count()', () => {
    expect(firstCount([{ count: '17' }])).toBe(17);
  });

  it('returns 0 for an empty result instead of NaN', () => {
    expect(firstCount([])).toBe(0);
  });
});

describe('mapParty', () => {
  it('converts snake_case columns and coerces the boolean flag', () => {
    const party = mapParty({
      id: 'p1',
      party_code: 'P-0001',
      name: 'Patel Tiles',
      phone: '9876543210',
      alt_phone: null,
      email: null,
      address_line1: null,
      address_line2: null,
      city: 'Morbi',
      state: null,
      pincode: null,
      gst_number: null,
      notes: null,
      is_active: true,
      created_by_user_id: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(party).toMatchObject({
      id: 'p1',
      partyCode: 'P-0001',
      name: 'Patel Tiles',
      city: 'Morbi',
      isActive: true,
      altPhone: null,
    });
  });
});

describe('mapProduct', () => {
  it('coerces NUMERIC columns and defaults missing JSONB parameters to an object', () => {
    const product = mapProduct({
      id: 'pr1',
      product_code: 'GVT-01',
      name: 'Carrara White',
      category_id: 'c1',
      category_name: 'Floor Tile',
      size: '600x600mm',
      finish: 'Glossy',
      series: null,
      color: null,
      thickness_mm: '9.50',
      pieces_per_box: 4,
      box_coverage_sqft: '15.50',
      price_per_box: 45000,
      price_per_sqft: null,
      hsn_code: null,
      parameters: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(product.thicknessMm).toBe(9.5);
    expect(product.boxCoverageSqft).toBe(15.5);
    expect(product.pricePerBox).toBe(45000);
    expect(product.pricePerSqft).toBeNull();
    expect(product.parameters).toEqual({});
    expect(product.categoryName).toBe('Floor Tile');
  });
});

describe('mapLeadItem', () => {
  it('carries the joined product identity alongside the line values', () => {
    const item = mapLeadItem({
      id: 'li1',
      lead_id: 'l1',
      product_id: 'pr1',
      product_code: 'GVT-01',
      product_name: 'Carrara White',
      quantity_boxes: '12.00',
      quantity_sqft: null,
      unit_price: 45000,
      line_total: 540000,
      parameters: { note: 'matte edge' },
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(item).toMatchObject({
      productCode: 'GVT-01',
      productName: 'Carrara White',
      quantityBoxes: 12,
      unitPrice: 45000,
      lineTotal: 540000,
      parameters: { note: 'matte edge' },
    });
  });
});

describe('mapLead', () => {
  it('attaches items and the joined party name', () => {
    const lead = mapLead(
      {
        id: 'l1',
        lead_number: 'L-000001',
        party_id: 'p1',
        party_name: 'Patel Tiles',
        status: 'new',
        source_panel_id: 'panel-1',
        created_by_user_id: null,
        notes: null,
        total_amount: '540000',
        order_date: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      [],
    );

    expect(lead).toMatchObject({
      leadNumber: 'L-000001',
      partyName: 'Patel Tiles',
      status: 'new',
      totalAmount: 540000,
      orderDate: null,
      items: [],
    });
  });
});
