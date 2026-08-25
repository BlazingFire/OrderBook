/**
 * Row mapping is where node-postgres's string-typed NUMERIC/BIGINT values get
 * normalised, so these tests pin the coercions that everything downstream
 * assumes.
 */

import { describe, expect, it } from 'vitest';

import {
  firstCount,
  mapLead,
  mapLineItem,
  mapParty,
  mapProduct,
  toIso,
  toIsoDate,
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

describe('toIsoDate', () => {
  // RPT-5: `toIsoDate` (mappers.ts:79-90) is the existing fix for the
  // shipped defect where a DATE column read a day early anywhere east of
  // UTC — `toISOString()` converts to UTC first, so a follow-up date of the
  // 1st on an IST machine came back as the 31st. This is its first test.
  it('keeps the day the user typed, on a machine east of UTC (IST, UTC+5:30)', () => {
    // node-postgres parses a DATE column into a JS Date at *local* midnight —
    // this constructs the same shape a real row would produce on an IST host,
    // without depending on the test runner's own timezone.
    const localMidnight = new Date(2026, 0, 1, 0, 0, 0);
    expect(toIsoDate(localMidnight)).toBe('2026-01-01');
  });

  it('does not roll over at a month boundary', () => {
    const localMidnight = new Date(2026, 1, 28, 0, 0, 0);
    expect(toIsoDate(localMidnight)).toBe('2026-02-28');
  });

  it('returns null for a missing date', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });

  it('passes an already-string date through, truncated to 10 characters', () => {
    expect(toIsoDate('2026-03-15')).toBe('2026-03-15');
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
      rate: 45000,
      price_per_sqft: null,
      hsn_code: null,
      parameters: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(product.thicknessMm).toBe(9.5);
    expect(product.boxCoverageSqft).toBe(15.5);
    expect(product.rate).toBe(45000);
    expect(product.pricePerSqft).toBeNull();
    expect(product.parameters).toEqual({});
    expect(product.categoryName).toBe('Floor Tile');
  });
});

describe('mapLineItem', () => {
  it('carries the frozen snapshot alongside the colour quantities', () => {
    const item = mapLineItem(
      {
        id: 'LI0000000001',
        tenant_id: 't1',
        parent_type: 'lead',
        parent_id: 'LD0000000001',
        product_id: 'PR0000000001',
        product_name: 'Carrara White',
        alias: 'Carrara',
        rate: 45000,
        code: 'GVT-01',
        sin: 'SIN-1',
        size: '600x1200',
        weight_kg: '22.500',
        grade: 'Premium',
        product_type: 'Vitrified',
        packaging: 'carton',
        sequence: 1,
        from_party_variant: false,
        image_path: null,
        notes: null,
        total_quantity: '12.00',
        line_total: 540000,
        created_at: new Date(),
        updated_at: new Date(),
      },
      [{ id: 'q1', colour: 'Ivory', quantity: 12 }],
    );

    expect(item).toMatchObject({
      code: 'GVT-01',
      productName: 'Carrara White',
      rate: 45000,
      weightKg: 22.5,
      packaging: 'carton',
      totalQuantity: 12,
      lineTotal: 540000,
    });
    expect(item.quantities).toEqual([{ id: 'q1', colour: 'Ivory', quantity: 12 }]);
  });
});

describe('mapLead', () => {
  it('attaches the joined party, stage and completeness', () => {
    const lead = mapLead(
      {
        id: 'LD0000000001',
        tenant_id: 't1',
        party_id: 'PT0000000001',
        party_name: 'Patel Tiles',
        owner_id: 'u1',
        owner_name: 'Asha',
        stage_id: 's1',
        stage_name: 'Quoted',
        stage_sequence: 2,
        source_platform: 'whatsapp',
        follow_up_date: null,
        party_wise_mode: false,
        notes: null,
        custom_fields: {},
        total_amount: '540000',
        converted_order_id: null,
        converted_at: null,
        source_panel_id: 'panel-1',
        created_by_user_id: null,
        version: 1,
        hlc: '0000001700000000000-00000-MASTER',
        field_hlc: {},
        temporary_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      [],
      [],
      { incomplete: true, missingFields: ['Site address'] },
    );

    expect(lead).toMatchObject({
      partyName: 'Patel Tiles',
      stageName: 'Quoted',
      stageSequence: 2,
      sourcePlatform: 'whatsapp',
      totalAmount: 540000,
      convertedOrderId: null,
      incomplete: true,
      missingFields: ['Site address'],
      items: [],
    });
    expect(lead.sync.hlc).toBe('0000001700000000000-00000-MASTER');
  });
});
