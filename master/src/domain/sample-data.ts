/**
 * The sample dataset `sample-data.service.ts` seeds — a small ceramic-tile
 * trade, written down rather than generated, so that what a person sees on a
 * demo Master reads like a business and not like `Product 17`.
 *
 * Pure data and pure rules only: no database, no clock. Every date is a day
 * offset from the start of the seeded window (`SAMPLE_WINDOW_DAYS` days before
 * "today"), and every reference between records is by the human key the seed
 * resolves — a product *code*, a party *key*, a colour *name* — never an id,
 * because ids are minted at seed time.
 *
 * Money is in paise, like the columns it lands in (`docs/schema/00-overview.md`
 * §2). Sizes and box coverages are the real ones for those tile formats.
 */

import type { FieldListKey } from '@orderbook/shared';

/** How far back the generated history starts. */
export const SAMPLE_WINDOW_DAYS = 170;

/**
 * The code the seed checks before it writes anything. It is the first product
 * below: if that exists, this dataset has been seeded here before.
 */
export const SAMPLE_MARKER_PRODUCT_CODE = 'GVT-6060-CARR';

export type SampleUser = 'admin' | 'management' | 'office';

// --- Option lists ----------------------------------------------------------

export interface SampleOptionValue {
  value: string;
  hex?: string;
}

/** Every managed list gets values, so each picker on the Fields screen has rows. */
export const SAMPLE_OPTION_VALUES: Record<FieldListKey, readonly SampleOptionValue[]> = {
  // `lead.sourcePlatform` is seeded by the tenancy migration; nothing to add.
  'lead.sourcePlatform': [],
  'stock.colour': [
    { value: 'White', hex: '#F4F4F0' },
    { value: 'Ivory', hex: '#F6F1DC' },
    { value: 'Beige', hex: '#E4D5B7' },
    { value: 'Light Grey', hex: '#C9CBCF' },
    { value: 'Grey', hex: '#8E9196' },
    { value: 'Charcoal', hex: '#4A4D52' },
    { value: 'Black', hex: '#26282B' },
    { value: 'Brown', hex: '#7A5230' },
    { value: 'Walnut', hex: '#5C3D24' },
    { value: 'Sky Blue', hex: '#6FA8DC' },
    { value: 'Teal', hex: '#3C8C8A' },
    { value: 'Terracotta', hex: '#B85C38' },
  ],
  'product.productType': [
    { value: 'GVT' },
    { value: 'PGVT' },
    { value: 'Double Charge' },
    { value: 'Ceramic Wall' },
    { value: 'Ceramic Floor' },
    { value: 'Parking' },
    { value: 'Elevation' },
  ],
  'product.brand': [
    { value: 'Kavya Vitrified' },
    { value: 'Shubh Ceramics' },
    { value: 'Morbi Gold' },
  ],
  'product.shade': [{ value: 'Light' }, { value: 'Medium' }, { value: 'Dark' }],
  'product.surfaceTexture': [
    { value: 'Glossy' },
    { value: 'Matt' },
    { value: 'Satin' },
    { value: 'Sugar' },
    { value: 'Rustic' },
    { value: 'Carving' },
  ],
  'product.originPlant': [
    { value: 'Morbi Unit 1' },
    { value: 'Morbi Unit 2' },
    { value: 'Wankaner' },
  ],
  'line.packaging': [
    { value: 'Carton' },
    { value: 'Pallet' },
    { value: 'Wooden crate' },
    { value: 'Loose' },
  ],
  'line.grade': [{ value: 'Premium' }, { value: 'Standard' }, { value: 'Commercial' }],
};

// --- Custom fields ---------------------------------------------------------

export interface SampleCustomField {
  entity: 'lead' | 'order' | 'party' | 'product';
  key: string;
  label: string;
  fieldType: 'text' | 'number' | 'date' | 'select' | 'boolean';
  options?: string[];
}

export const SAMPLE_CUSTOM_FIELDS: readonly SampleCustomField[] = [
  {
    entity: 'lead',
    key: 'priority',
    label: 'Priority',
    fieldType: 'select',
    options: ['High', 'Medium', 'Low'],
  },
  { entity: 'lead', key: 'siteLocation', label: 'Site location', fieldType: 'text' },
  {
    entity: 'order',
    key: 'transport',
    label: 'Transport',
    fieldType: 'select',
    options: ['Own vehicle', 'Transporter', 'Customer pickup'],
  },
  { entity: 'order', key: 'vehicleNumber', label: 'Vehicle number', fieldType: 'text' },
  {
    entity: 'party',
    key: 'dealerType',
    label: 'Dealer type',
    fieldType: 'select',
    options: ['Dealer', 'Builder', 'Architect', 'Retail'],
  },
  { entity: 'party', key: 'creditDays', label: 'Credit days', fieldType: 'number' },
  { entity: 'product', key: 'launchYear', label: 'Launch year', fieldType: 'number' },
];

// --- Catalogue -------------------------------------------------------------

export interface SampleProduct {
  code: string;
  name: string;
  alias?: string;
  category: string;
  productType: string;
  size: string;
  finish: string;
  series: string;
  thicknessMm: number;
  piecesPerBox: number;
  boxCoverageSqft: number;
  /** Paise per box. */
  rate: number;
  mrp: number;
  purchaseRate: number;
  /** Paise per square foot. */
  pricePerSqft: number;
  weightKg: number;
  brand: string;
  shade: string;
  grade: string;
  waterAbsorptionPct: number;
  peiRating: number;
  edgeType: 'rectified' | 'non_rectified';
  application: 'floor' | 'wall' | 'floor_wall' | 'outdoor';
  originPlant: string;
  /** The first colour is the product's own `color`; every one gets stock. */
  colours: string[];
  /** Which swatch `tile-swatch.ts` draws for the photo. */
  pattern: 'marble' | 'wood' | 'stone' | 'plain';
  launchYear: number;
  /**
   * Never stocked and never quoted — so it can be deleted at the end. A
   * product with boxes on the floor or a line on a live lead cannot go to the
   * Recycle Bin (`liveReferencesToProduct`), and the bin should have one.
   */
  discontinued?: boolean;
}

const GVT = 'Glazed Vitrified Tiles';
const DC = 'Double Charge Vitrified';
const WALL = 'Ceramic Wall Tiles';
const FLOOR = 'Ceramic Floor Tiles';
const PARKING = 'Parking Tiles';
const ELEVATION = 'Elevation Tiles';

/* prettier-ignore */
export const SAMPLE_PRODUCTS: readonly SampleProduct[] = [
  {
    code: 'GVT-6060-CARR', name: 'Carrara Statuario', alias: 'Carrara', category: GVT, productType: 'GVT',
    size: '600x600', finish: 'Glossy', series: 'Marble', thicknessMm: 9, piecesPerBox: 4, boxCoverageSqft: 15.5,
    rate: 68000, mrp: 82000, purchaseRate: 52000, pricePerSqft: 4400, weightKg: 28.5, brand: 'Kavya Vitrified',
    shade: 'Light', grade: 'Premium', waterAbsorptionPct: 0.05, peiRating: 4, edgeType: 'rectified',
    application: 'floor_wall', originPlant: 'Morbi Unit 1', colours: ['White', 'Ivory', 'Light Grey'],
    pattern: 'marble', launchYear: 2024,
  },
  {
    code: 'GVT-6060-ONYX', name: 'Onyx Honey', category: GVT, productType: 'GVT',
    size: '600x600', finish: 'Glossy', series: 'Marble', thicknessMm: 9, piecesPerBox: 4, boxCoverageSqft: 15.5,
    rate: 66000, mrp: 80000, purchaseRate: 50000, pricePerSqft: 4260, weightKg: 28.5, brand: 'Kavya Vitrified',
    shade: 'Medium', grade: 'Premium', waterAbsorptionPct: 0.05, peiRating: 4, edgeType: 'rectified',
    application: 'floor_wall', originPlant: 'Morbi Unit 1', colours: ['Ivory', 'Beige', 'Brown'],
    pattern: 'marble', launchYear: 2024,
  },
  {
    code: 'GVT-6012-CALA', name: 'Calacatta Gold', alias: 'Calacatta', category: GVT, productType: 'PGVT',
    size: '600x1200', finish: 'Glossy', series: 'Marble', thicknessMm: 9, piecesPerBox: 2, boxCoverageSqft: 15.5,
    rate: 145000, mrp: 172000, purchaseRate: 112000, pricePerSqft: 9350, weightKg: 30, brand: 'Kavya Vitrified',
    shade: 'Light', grade: 'Premium', waterAbsorptionPct: 0.05, peiRating: 4, edgeType: 'rectified',
    application: 'floor_wall', originPlant: 'Morbi Unit 2', colours: ['White', 'Ivory'],
    pattern: 'marble', launchYear: 2025,
  },
  {
    code: 'GVT-6012-STAT', name: 'Statuario Bianco', category: GVT, productType: 'PGVT',
    size: '600x1200', finish: 'Matt', series: 'Marble', thicknessMm: 9, piecesPerBox: 2, boxCoverageSqft: 15.5,
    rate: 138000, mrp: 165000, purchaseRate: 106000, pricePerSqft: 8900, weightKg: 30, brand: 'Kavya Vitrified',
    shade: 'Light', grade: 'Premium', waterAbsorptionPct: 0.05, peiRating: 4, edgeType: 'rectified',
    application: 'floor_wall', originPlant: 'Morbi Unit 2', colours: ['White', 'Light Grey'],
    pattern: 'marble', launchYear: 2025,
  },
  {
    code: 'GVT-8016-ARMA', name: 'Armani Grey', category: GVT, productType: 'PGVT',
    size: '800x1600', finish: 'Glossy', series: 'Slab', thicknessMm: 9, piecesPerBox: 2, boxCoverageSqft: 27.5,
    rate: 290000, mrp: 340000, purchaseRate: 228000, pricePerSqft: 10550, weightKg: 52, brand: 'Morbi Gold',
    shade: 'Dark', grade: 'Premium', waterAbsorptionPct: 0.05, peiRating: 4, edgeType: 'rectified',
    application: 'floor_wall', originPlant: 'Morbi Unit 2', colours: ['Grey', 'Charcoal'],
    pattern: 'marble', launchYear: 2025,
  },
  {
    code: 'GVT-6060-SUGA', name: 'Sugar Crystal', category: GVT, productType: 'GVT',
    size: '600x600', finish: 'Sugar', series: 'Crystal', thicknessMm: 9, piecesPerBox: 4, boxCoverageSqft: 15.5,
    rate: 72000, mrp: 86000, purchaseRate: 55000, pricePerSqft: 4650, weightKg: 28.5, brand: 'Kavya Vitrified',
    shade: 'Light', grade: 'Premium', waterAbsorptionPct: 0.05, peiRating: 4, edgeType: 'rectified',
    application: 'floor_wall', originPlant: 'Morbi Unit 1', colours: ['Ivory', 'Beige', 'Grey'],
    pattern: 'stone', launchYear: 2024,
  },
  {
    code: 'GVT-2012-TEAK', name: 'Teak Wood Plank', alias: 'Teak plank', category: GVT, productType: 'GVT',
    size: '200x1200', finish: 'Matt', series: 'Wood', thicknessMm: 9, piecesPerBox: 6, boxCoverageSqft: 15.5,
    rate: 64000, mrp: 78000, purchaseRate: 49000, pricePerSqft: 4130, weightKg: 27, brand: 'Shubh Ceramics',
    shade: 'Dark', grade: 'Premium', waterAbsorptionPct: 0.08, peiRating: 4, edgeType: 'rectified',
    application: 'floor_wall', originPlant: 'Wankaner', colours: ['Brown', 'Walnut'],
    pattern: 'wood', launchYear: 2023,
  },
  {
    code: 'DC-6060-CRYS', name: 'Crystal Super White', alias: 'Super white', category: DC, productType: 'Double Charge',
    size: '600x600', finish: 'Glossy', series: 'Plain', thicknessMm: 8.5, piecesPerBox: 4, boxCoverageSqft: 15.5,
    rate: 52000, mrp: 64000, purchaseRate: 40000, pricePerSqft: 3350, weightKg: 27, brand: 'Morbi Gold',
    shade: 'Light', grade: 'Standard', waterAbsorptionPct: 0.05, peiRating: 5, edgeType: 'rectified',
    application: 'floor', originPlant: 'Morbi Unit 1', colours: ['White'],
    pattern: 'plain', launchYear: 2022,
  },
  {
    code: 'DC-6060-GALA', name: 'Galaxy Black', category: DC, productType: 'Double Charge',
    size: '600x600', finish: 'Glossy', series: 'Galaxy', thicknessMm: 8.5, piecesPerBox: 4, boxCoverageSqft: 15.5,
    rate: 56000, mrp: 68000, purchaseRate: 43000, pricePerSqft: 3600, weightKg: 27, brand: 'Morbi Gold',
    shade: 'Dark', grade: 'Standard', waterAbsorptionPct: 0.05, peiRating: 5, edgeType: 'rectified',
    application: 'floor', originPlant: 'Morbi Unit 1', colours: ['Black', 'Charcoal'],
    pattern: 'stone', launchYear: 2022,
  },
  {
    code: 'DC-8080-PEAR', name: 'Pearl Cream', category: DC, productType: 'Double Charge',
    size: '800x800', finish: 'Glossy', series: 'Pearl', thicknessMm: 10, piecesPerBox: 3, boxCoverageSqft: 20.66,
    rate: 118000, mrp: 140000, purchaseRate: 91000, pricePerSqft: 5700, weightKg: 45, brand: 'Morbi Gold',
    shade: 'Light', grade: 'Premium', waterAbsorptionPct: 0.05, peiRating: 5, edgeType: 'rectified',
    application: 'floor', originPlant: 'Morbi Unit 2', colours: ['Ivory', 'Beige'],
    pattern: 'marble', launchYear: 2023,
  },
  {
    code: 'DC-6060-NANO', name: 'Nano Ivory', category: DC, productType: 'Double Charge',
    size: '600x600', finish: 'Glossy', series: 'Nano', thicknessMm: 8.5, piecesPerBox: 4, boxCoverageSqft: 15.5,
    rate: 56000, mrp: 66000, purchaseRate: 43000, pricePerSqft: 3600, weightKg: 27, brand: 'Shubh Ceramics',
    shade: 'Light', grade: 'Standard', waterAbsorptionPct: 0.05, peiRating: 5, edgeType: 'rectified',
    application: 'floor', originPlant: 'Wankaner', colours: ['Ivory', 'White'],
    pattern: 'plain', launchYear: 2021,
  },
  {
    code: 'CW-3060-AQUA', name: 'Aqua Marine', category: WALL, productType: 'Ceramic Wall',
    size: '300x600', finish: 'Glossy', series: 'Aqua', thicknessMm: 8, piecesPerBox: 5, boxCoverageSqft: 9.68,
    rate: 31000, mrp: 38000, purchaseRate: 23000, pricePerSqft: 3200, weightKg: 14, brand: 'Shubh Ceramics',
    shade: 'Medium', grade: 'Standard', waterAbsorptionPct: 12, peiRating: 1, edgeType: 'non_rectified',
    application: 'wall', originPlant: 'Wankaner', colours: ['Sky Blue', 'Teal', 'White'],
    pattern: 'plain', launchYear: 2023,
  },
  {
    code: 'CW-3060-FLOR', name: 'Floral Bloom', category: WALL, productType: 'Ceramic Wall',
    size: '300x600', finish: 'Glossy', series: 'Floral', thicknessMm: 8, piecesPerBox: 5, boxCoverageSqft: 9.68,
    rate: 34000, mrp: 41000, purchaseRate: 25000, pricePerSqft: 3510, weightKg: 14, brand: 'Shubh Ceramics',
    shade: 'Light', grade: 'Standard', waterAbsorptionPct: 12, peiRating: 1, edgeType: 'non_rectified',
    application: 'wall', originPlant: 'Wankaner', colours: ['Ivory', 'Beige'],
    pattern: 'plain', launchYear: 2024,
  },
  {
    code: 'CW-3045-SUBW', name: 'Subway Classic', alias: 'Subway', category: WALL, productType: 'Ceramic Wall',
    size: '300x450', finish: 'Glossy', series: 'Subway', thicknessMm: 7.5, piecesPerBox: 6, boxCoverageSqft: 8.72,
    rate: 26000, mrp: 32000, purchaseRate: 19000, pricePerSqft: 2980, weightKg: 11, brand: 'Shubh Ceramics',
    shade: 'Light', grade: 'Commercial', waterAbsorptionPct: 14, peiRating: 1, edgeType: 'non_rectified',
    application: 'wall', originPlant: 'Wankaner', colours: ['White', 'Black', 'Sky Blue'],
    pattern: 'plain', launchYear: 2020,
  },
  {
    code: 'CW-3060-METR', name: 'Metro Concrete', category: WALL, productType: 'Ceramic Wall',
    size: '300x600', finish: 'Matt', series: 'Concrete', thicknessMm: 8, piecesPerBox: 5, boxCoverageSqft: 9.68,
    rate: 33000, mrp: 40000, purchaseRate: 24500, pricePerSqft: 3410, weightKg: 14, brand: 'Kavya Vitrified',
    shade: 'Medium', grade: 'Standard', waterAbsorptionPct: 11, peiRating: 1, edgeType: 'non_rectified',
    application: 'wall', originPlant: 'Morbi Unit 1', colours: ['Grey', 'Light Grey', 'Charcoal'],
    pattern: 'stone', launchYear: 2024,
  },
  {
    code: 'CF-3030-TERR', name: 'Terra Rustic', category: FLOOR, productType: 'Ceramic Floor',
    size: '300x300', finish: 'Matt', series: 'Terra', thicknessMm: 8, piecesPerBox: 10, boxCoverageSqft: 9.68,
    rate: 24000, mrp: 30000, purchaseRate: 17500, pricePerSqft: 2480, weightKg: 15, brand: 'Shubh Ceramics',
    shade: 'Dark', grade: 'Commercial', waterAbsorptionPct: 5, peiRating: 3, edgeType: 'non_rectified',
    application: 'floor', originPlant: 'Wankaner', colours: ['Terracotta', 'Brown'],
    pattern: 'stone', launchYear: 2019,
  },
  {
    code: 'CF-4040-SLAT', name: 'Slate Stone', category: FLOOR, productType: 'Ceramic Floor',
    size: '400x400', finish: 'Matt', series: 'Stone', thicknessMm: 8.5, piecesPerBox: 6, boxCoverageSqft: 10.33,
    rate: 29000, mrp: 35000, purchaseRate: 21500, pricePerSqft: 2810, weightKg: 16, brand: 'Shubh Ceramics',
    shade: 'Dark', grade: 'Standard', waterAbsorptionPct: 4, peiRating: 3, edgeType: 'non_rectified',
    application: 'floor', originPlant: 'Wankaner', colours: ['Grey', 'Charcoal', 'Brown'],
    pattern: 'stone', launchYear: 2021,
  },
  {
    code: 'CF-2012-OAKW', name: 'Oakwood Plank', category: FLOOR, productType: 'Ceramic Floor',
    size: '200x1200', finish: 'Matt', series: 'Wood', thicknessMm: 8.5, piecesPerBox: 6, boxCoverageSqft: 15.5,
    rate: 56000, mrp: 68000, purchaseRate: 42000, pricePerSqft: 3610, weightKg: 25, brand: 'Kavya Vitrified',
    shade: 'Medium', grade: 'Standard', waterAbsorptionPct: 3, peiRating: 4, edgeType: 'rectified',
    application: 'floor', originPlant: 'Morbi Unit 1', colours: ['Brown', 'Walnut', 'Beige'],
    pattern: 'wood', launchYear: 2023,
  },
  {
    code: 'PK-3030-HEAV', name: 'Heavy Duty Chequered', alias: 'Chequered', category: PARKING, productType: 'Parking',
    size: '300x300', finish: 'Matt', series: 'Heavy Duty', thicknessMm: 12, piecesPerBox: 10, boxCoverageSqft: 9.68,
    rate: 23000, mrp: 28000, purchaseRate: 16500, pricePerSqft: 2380, weightKg: 22, brand: 'Morbi Gold',
    shade: 'Medium', grade: 'Commercial', waterAbsorptionPct: 3, peiRating: 5, edgeType: 'non_rectified',
    application: 'outdoor', originPlant: 'Morbi Unit 2', colours: ['Grey', 'Terracotta', 'Ivory'],
    pattern: 'plain', launchYear: 2018,
  },
  {
    code: 'PK-4040-COBB', name: 'Cobblestone', category: PARKING, productType: 'Parking',
    size: '400x400', finish: 'Rustic', series: 'Cobble', thicknessMm: 12, piecesPerBox: 6, boxCoverageSqft: 10.33,
    rate: 30000, mrp: 36000, purchaseRate: 22000, pricePerSqft: 2900, weightKg: 24, brand: 'Morbi Gold',
    shade: 'Dark', grade: 'Standard', waterAbsorptionPct: 3, peiRating: 5, edgeType: 'non_rectified',
    application: 'outdoor', originPlant: 'Morbi Unit 2', colours: ['Grey', 'Brown'],
    pattern: 'stone', launchYear: 2022,
  },
  {
    code: 'EL-3060-BRIC', name: 'Brick Wall', category: ELEVATION, productType: 'Elevation',
    size: '300x600', finish: 'Rustic', series: 'Brick', thicknessMm: 10, piecesPerBox: 5, boxCoverageSqft: 9.68,
    rate: 38000, mrp: 46000, purchaseRate: 28500, pricePerSqft: 3930, weightKg: 17, brand: 'Kavya Vitrified',
    shade: 'Dark', grade: 'Standard', waterAbsorptionPct: 6, peiRating: 3, edgeType: 'non_rectified',
    application: 'outdoor', originPlant: 'Morbi Unit 1', colours: ['Terracotta', 'Brown', 'Charcoal'],
    pattern: 'stone', launchYear: 2023,
  },
  {
    code: 'EL-3060-SAND', name: 'Sandstone Cladding', category: ELEVATION, productType: 'Elevation',
    size: '300x600', finish: 'Sugar', series: 'Stone', thicknessMm: 10, piecesPerBox: 5, boxCoverageSqft: 9.68,
    rate: 40000, mrp: 48000, purchaseRate: 30000, pricePerSqft: 4130, weightKg: 17, brand: 'Kavya Vitrified',
    shade: 'Light', grade: 'Standard', waterAbsorptionPct: 6, peiRating: 3, edgeType: 'non_rectified',
    application: 'outdoor', originPlant: 'Morbi Unit 1', colours: ['Beige', 'Ivory'],
    pattern: 'stone', launchYear: 2024,
  },
  {
    code: 'CW-2030-PLNW', name: 'Plain White 8x12', category: WALL, productType: 'Ceramic Wall',
    size: '200x300', finish: 'Glossy', series: 'Basic', thicknessMm: 7, piecesPerBox: 16, boxCoverageSqft: 10.33,
    rate: 18000, mrp: 22000, purchaseRate: 13000, pricePerSqft: 1740, weightKg: 12, brand: 'Shubh Ceramics',
    shade: 'Light', grade: 'Commercial', waterAbsorptionPct: 15, peiRating: 1, edgeType: 'non_rectified',
    application: 'wall', originPlant: 'Wankaner', colours: ['White'],
    pattern: 'plain', launchYear: 2016, discontinued: true,
  },
];

// --- Parties ---------------------------------------------------------------

export interface SampleParty {
  key: string;
  name: string;
  phone: string;
  altPhone?: string;
  email?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  pincode: string;
  gstNumber?: string;
  notes?: string;
  dealerType: 'Dealer' | 'Builder' | 'Architect' | 'Retail';
  creditDays: number;
}

/* prettier-ignore */
export const SAMPLE_PARTIES: readonly SampleParty[] = [
  {
    key: 'ganesh', name: 'Shree Ganesh Tiles & Sanitary', phone: '98250 11223', altPhone: '0281 245 6677',
    email: 'shreeganeshtiles@example.com', addressLine1: '12, Gondal Road', addressLine2: 'Near Mavdi Chowk',
    city: 'Rajkot', state: 'Gujarat', pincode: '360004', gstNumber: '24AABCS1234F1Z5',
    notes: 'Largest dealer in Rajkot. Prefers Carrara and Calacatta. Payment within 30 days.',
    dealerType: 'Dealer', creditDays: 30,
  },
  {
    key: 'patel', name: 'Patel Ceramic Traders', phone: '99090 45678', email: 'patelceramic@example.com',
    addressLine1: 'Shop 4, Navrangpura Market', city: 'Ahmedabad', state: 'Gujarat', pincode: '380009',
    gstNumber: '24AAFCP5678G1ZK', notes: 'Weekly orders for wall tiles. Ask for Kirtibhai.',
    dealerType: 'Dealer', creditDays: 15,
  },
  {
    key: 'omsai', name: 'Om Sai Marble & Tiles', phone: '98980 22334', addressLine1: 'Ring Road, Opp. Silk City Mall',
    city: 'Surat', state: 'Gujarat', pincode: '395002', gstNumber: '24AAGCO9012H1Z3',
    notes: 'Stocks mainly vitrified. Wants sample boxes before every new series.', dealerType: 'Dealer', creditDays: 21,
  },
  {
    key: 'balaji', name: 'Balaji Buildcon', phone: '97250 33445', email: 'projects@balajibuildcon.example.com',
    addressLine1: '3rd Floor, Sun Plaza', addressLine2: 'Alkapuri', city: 'Vadodara', state: 'Gujarat',
    pincode: '390007', gstNumber: '24AAHCB3456J1Z9', notes: 'Builder — 4 residential projects in progress.',
    dealerType: 'Builder', creditDays: 45,
  },
  {
    key: 'mehta', name: 'Mehta Constructions', phone: '98200 55667', email: 'purchase@mehtacon.example.com',
    addressLine1: 'Unit 21, Andheri Industrial Estate', city: 'Mumbai', state: 'Maharashtra', pincode: '400053',
    gstNumber: '27AAACM7890K1ZP', notes: 'Handled by management only. Large slab orders.',
    dealerType: 'Builder', creditDays: 60,
  },
  {
    key: 'anand', name: 'Anand Tiles Depot', phone: '98220 66778', addressLine1: '45, Market Yard Road',
    city: 'Pune', state: 'Maharashtra', pincode: '411037', gstNumber: '27AABCA2345L1Z6',
    dealerType: 'Dealer', creditDays: 30,
  },
  {
    key: 'jaiambe', name: 'Jai Ambe Traders', phone: '94140 77889', addressLine1: 'Sanganer Road',
    addressLine2: 'Near Tonk Phatak', city: 'Jaipur', state: 'Rajasthan', pincode: '302015',
    gstNumber: '08AADCJ6789M1ZR', notes: 'Wants matt finishes only.', dealerType: 'Dealer', creditDays: 30,
  },
  {
    key: 'nakoda', name: 'Nakoda Ceramics', phone: '94600 88990', addressLine1: 'Sukhadia Circle',
    city: 'Udaipur', state: 'Rajasthan', pincode: '313001', gstNumber: '08AAECN0123N1ZT',
    dealerType: 'Dealer', creditDays: 21,
  },
  {
    key: 'vishwa', name: 'Vishwakarma Builders', phone: '98930 99001', email: 'site@vishwakarma.example.com',
    addressLine1: 'Plot 8, Scheme 78', city: 'Indore', state: 'Madhya Pradesh', pincode: '452010',
    gstNumber: '23AAFCV4567P1ZV', notes: 'Township project — parking and elevation tiles.',
    dealerType: 'Builder', creditDays: 45,
  },
  {
    key: 'krishna', name: 'Krishna Tiles', phone: '99250 10112', addressLine1: 'Sector 21, GH Road',
    city: 'Gandhinagar', state: 'Gujarat', pincode: '382021', gstNumber: '24AAKCK8901Q1ZX',
    dealerType: 'Retail', creditDays: 0,
  },
  {
    key: 'metro', name: 'Metro Tile Studio', phone: '98670 21223', email: 'hello@metrotilestudio.example.com',
    addressLine1: 'Linking Road, Bandra West', city: 'Mumbai', state: 'Maharashtra', pincode: '400050',
    gstNumber: '27AAMCM2345R1ZZ', notes: 'Architect-led studio. Slabs and premium marble looks.',
    dealerType: 'Architect', creditDays: 30,
  },
  {
    key: 'sunrise', name: 'Sunrise Developers', phone: '99790 32334', addressLine1: 'Sunrise House, S.G. Highway',
    addressLine2: 'Bopal', city: 'Ahmedabad', state: 'Gujarat', pincode: '380058', gstNumber: '24AAPCS6789S1ZB',
    notes: '2 towers under construction at Bopal. Site engineer: Rakeshbhai.', dealerType: 'Builder', creditDays: 45,
  },
  {
    key: 'laxmi', name: 'Laxmi Tiles & Hardware', phone: '98240 43445', addressLine1: 'Waghawadi Road',
    city: 'Bhavnagar', state: 'Gujarat', pincode: '364002', gstNumber: '24AALCL0123T1ZD',
    dealerType: 'Dealer', creditDays: 15,
  },
  {
    key: 'greenvalley', name: 'Green Valley Infra', phone: '98500 54556', addressLine1: 'Gangapur Road',
    city: 'Nashik', state: 'Maharashtra', pincode: '422013', gstNumber: '27AAGCG4567U1ZF',
    dealerType: 'Builder', creditDays: 30,
  },
  {
    key: 'royal', name: 'Royal Interiors', phone: '98790 65667', email: 'design@royalinteriors.example.com',
    addressLine1: '2nd Floor, Star Plaza', addressLine2: 'Phulchhab Chowk', city: 'Rajkot', state: 'Gujarat',
    pincode: '360001', dealerType: 'Architect', creditDays: 15,
  },
  {
    key: 'hariom', name: 'Hari Om Tile Mart', phone: '98790 76778', addressLine1: 'Bedi Gate',
    city: 'Jamnagar', state: 'Gujarat', pincode: '361001', gstNumber: '24AAHCH8901V1ZH',
    notes: 'Closed down — kept for history.', dealerType: 'Dealer', creditDays: 0,
  },
];

/** Party-wise rates: a dealer's negotiated price and their own name for a product. */
export interface SamplePartyVariant {
  party: string;
  product: string;
  alias?: string;
  /** Paise per box. */
  rate: number;
  packaging?: string;
}

export const SAMPLE_PARTY_VARIANTS: readonly SamplePartyVariant[] = [
  {
    party: 'ganesh',
    product: 'GVT-6060-CARR',
    alias: 'Carrara 2x2',
    rate: 62000,
    packaging: 'Pallet',
  },
  {
    party: 'ganesh',
    product: 'GVT-6012-CALA',
    alias: 'Calacatta 2x4',
    rate: 134000,
    packaging: 'Wooden crate',
  },
  {
    party: 'ganesh',
    product: 'DC-6060-CRYS',
    alias: 'Super white DC',
    rate: 48000,
    packaging: 'Pallet',
  },
  { party: 'patel', product: 'CW-3060-AQUA', alias: 'Aqua 1x2', rate: 29000, packaging: 'Carton' },
  { party: 'patel', product: 'CW-3045-SUBW', rate: 24500, packaging: 'Carton' },
  {
    party: 'omsai',
    product: 'GVT-6060-SUGA',
    alias: 'Sugar 2x2',
    rate: 67000,
    packaging: 'Pallet',
  },
];

/** Who may see which party. Parties absent from here are open to everyone. */
export interface SamplePartyAssignment {
  party: string;
  entries: Array<{ user: SampleUser; level: 'view' | 'manage' }>;
}

export const SAMPLE_PARTY_ASSIGNMENTS: readonly SamplePartyAssignment[] = [
  { party: 'patel', entries: [{ user: 'office', level: 'manage' }] },
  { party: 'krishna', entries: [{ user: 'office', level: 'manage' }] },
  {
    party: 'laxmi',
    entries: [
      { user: 'office', level: 'view' },
      { user: 'management', level: 'manage' },
    ],
  },
  { party: 'mehta', entries: [{ user: 'management', level: 'manage' }] },
];

// --- Stock -----------------------------------------------------------------

/** Two letters per colour, for the per-colour stock codes staff type on a line. */
const COLOUR_ABBREVIATIONS: Readonly<Record<string, string>> = {
  White: 'WH',
  Ivory: 'IV',
  Beige: 'BG',
  'Light Grey': 'LG',
  Grey: 'GR',
  Charcoal: 'CH',
  Black: 'BK',
  Brown: 'BR',
  Walnut: 'WN',
  'Sky Blue': 'SB',
  Teal: 'TL',
  Terracotta: 'TC',
};

/**
 * The short code for one product in one colour — `CARR-WH` for Carrara
 * Statuario in White. The last segment of the product code is unique across
 * the catalogue above, which is what keeps these unique per tenant.
 */
export function sampleVariantCode(productCode: string, colour: string): string {
  const suffix = productCode.slice(productCode.lastIndexOf('-') + 1);
  const abbreviation =
    COLOUR_ABBREVIATIONS[colour] ??
    colour
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 2)
      .toUpperCase();
  return `${suffix}-${abbreviation}`;
}

/**
 * Opening stock per colour, as boxes received from the factory in the first
 * days of the window. Colours not listed here for a product get
 * `DEFAULT_OPENING_BOXES`; a few are deliberately thin so the low-stock count
 * on the dashboard is not zero.
 */
export const DEFAULT_OPENING_BOXES = 180;
export const DEFAULT_REORDER_LEVEL = 40;
export const DEFAULT_MIN_STOCK_LEVEL = 20;
export const DEFAULT_MAX_STOCK_LEVEL = 600;

export const SAMPLE_OPENING_STOCK: Readonly<Record<string, number>> = {
  'GVT-6060-CARR/White': 320,
  'GVT-6060-CARR/Ivory': 260,
  'GVT-6060-CARR/Light Grey': 90,
  'GVT-6012-CALA/White': 140,
  'GVT-6012-CALA/Ivory': 36,
  'GVT-8016-ARMA/Grey': 48,
  'GVT-8016-ARMA/Charcoal': 22,
  'DC-6060-CRYS/White': 600,
  'DC-8080-PEAR/Beige': 28,
  'CW-3060-AQUA/Teal': 30,
  'CW-3045-SUBW/Black': 24,
  'CF-2012-OAKW/Walnut': 18,
  'PK-3030-HEAV/Grey': 900,
  'PK-3030-HEAV/Ivory': 15,
  'EL-3060-BRIC/Charcoal': 12,
  'GVT-2012-TEAK/Walnut': 34,
};

/** A physical count that disagreed with the ledger, at a point in the window. */
export interface SampleStockCount {
  day: number;
  product: string;
  colour: string;
  countedBoxes: number;
  note: string;
}

export const SAMPLE_STOCK_COUNTS: readonly SampleStockCount[] = [
  {
    day: 58,
    product: 'DC-6060-CRYS',
    colour: 'White',
    countedBoxes: 492,
    note: 'Monthly count — 8 boxes broken in godown',
  },
  {
    day: 101,
    product: 'CW-3045-SUBW',
    colour: 'White',
    countedBoxes: 106,
    note: 'Found 6 extra boxes behind pallet row 3',
  },
  { day: 147, product: 'PK-3030-HEAV', colour: 'Grey', countedBoxes: 446, note: 'Quarterly count' },
];

/** Stock that arrived later in the window, so the ledger is not one opening entry per row. */
export interface SampleStockArrival {
  day: number;
  product: string;
  colour: string;
  boxes: number;
  note: string;
}

export const SAMPLE_STOCK_ARRIVALS: readonly SampleStockArrival[] = [
  {
    day: 44,
    product: 'GVT-6012-CALA',
    colour: 'White',
    boxes: 120,
    note: 'Truck GJ-03-AX-4521 from Morbi Unit 2',
  },
  { day: 71, product: 'GVT-6060-CARR', colour: 'White', boxes: 200, note: 'Fresh lot, calibre C1' },
  {
    day: 96,
    product: 'CW-3060-FLOR',
    colour: 'Ivory',
    boxes: 150,
    note: 'Restock for wedding season',
  },
  { day: 118, product: 'DC-6060-GALA', colour: 'Black', boxes: 100, note: 'Truck GJ-03-BT-9910' },
  {
    day: 139,
    product: 'GVT-8016-ARMA',
    colour: 'Grey',
    boxes: 40,
    note: 'Slab lot — handle with crane',
  },
  { day: 160, product: 'CF-2012-OAKW', colour: 'Brown', boxes: 90, note: 'Restock' },
];

// --- Leads, orders and their histories -------------------------------------

export interface SampleLine {
  product: string;
  /** `null` leaves packaging unset — a half-built lead that cannot convert yet. */
  packaging: string | null;
  grade?: string;
  /** Paise per box, when the line was priced by hand rather than from the catalogue. */
  rate?: number;
  notes?: string;
  quantities: Array<[colour: string, boxes: number]>;
}

export type SampleOrderPath =
  | { kind: 'inProgress' }
  | { kind: 'postponed'; remark: string }
  | {
      kind: 'dispatched';
      /** Days after the lead was won. */
      afterDays: number;
      /**
       * An absolute day of the window instead, for the one dispatch that has
       * to land *today*: the dashboard's "dispatched this week" starts at the
       * current business week's Monday, and only today is inside it whatever
       * weekday the seed runs on.
       */
      onDay?: number;
      note: string;
    }
  | { kind: 'cancelled'; remark: string };

export type SampleLeadOutcome =
  | { kind: 'open'; stage: 'New' | 'Quoted' | 'Negotiating' }
  | { kind: 'lost'; remark: string }
  | {
      kind: 'won';
      order: SampleOrderPath;
      dispatchAddress: string;
      transport?: string;
      vehicle?: string;
    };

export interface SampleLead {
  /** Day of the window the lead was raised on. */
  day: number;
  party: string;
  owner: SampleUser;
  source: string;
  partyWise?: boolean;
  /** Days from *today*; negative is overdue. Absent means no follow-up set. */
  followUpInDays?: number;
  notes?: string;
  priority?: 'High' | 'Medium' | 'Low';
  siteLocation?: string;
  lines: SampleLine[];
  /** Typed remarks, spread along the lead's history in this order. */
  remarks?: string[];
  outcome: SampleLeadOutcome;
}

/* prettier-ignore */
export const SAMPLE_LEADS: readonly SampleLead[] = [
  // --- The oldest history: won, dispatched months ago ---
  {
    day: 12, party: 'ganesh', owner: 'management', source: 'call', partyWise: true, priority: 'High',
    notes: 'Showroom refill for the new season.',
    lines: [
      { product: 'GVT-6060-CARR', packaging: 'Pallet', grade: 'Premium', quantities: [['White', 60], ['Ivory', 40]] },
      { product: 'DC-6060-CRYS', packaging: 'Pallet', grade: 'Standard', quantities: [['White', 100]] },
    ],
    remarks: ['Rate list shared on WhatsApp', 'Confirmed at party rate, advance of ₹50,000 received'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 9, note: 'Dispatched by Shreeji Roadlines' },
      dispatchAddress: 'Godown — Gondal Road, Rajkot', transport: 'Transporter', vehicle: 'GJ-03-AX-4521',
    },
  },
  {
    day: 15, party: 'balaji', owner: 'admin', source: 'referral', priority: 'High',
    siteLocation: 'Sun Residency, Alkapuri, Vadodara',
    lines: [
      { product: 'DC-6060-NANO', packaging: 'Pallet', grade: 'Standard', quantities: [['Ivory', 120]] },
      { product: 'CW-3060-AQUA', packaging: 'Carton', grade: 'Standard', quantities: [['Sky Blue', 40], ['White', 40]] },
    ],
    remarks: ['Quoted for tower A — 48 flats', 'Site engineer approved the Nano Ivory sample'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 14, note: 'Two trucks, unloaded at site' },
      dispatchAddress: 'Site — Sun Residency, Alkapuri', transport: 'Transporter', vehicle: 'GJ-06-BB-2210',
    },
  },
  {
    day: 19, party: 'jaiambe', owner: 'office', source: 'whatsapp',
    lines: [{ product: 'CF-4040-SLAT', packaging: 'Carton', grade: 'Standard', quantities: [['Grey', 50], ['Charcoal', 30]] }],
    remarks: ['Asked for glossy option — told matt only in this series'],
    outcome: { kind: 'lost', remark: 'Went with a cheaper local supplier' },
  },
  {
    day: 24, party: 'omsai', owner: 'management', source: 'walk_in', partyWise: true, priority: 'Medium',
    lines: [
      { product: 'GVT-6060-SUGA', packaging: 'Pallet', grade: 'Premium', quantities: [['Ivory', 80], ['Beige', 40]] },
    ],
    remarks: ['Sample box given from showroom stock'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 11, note: 'Delivered to Ring Road shop' },
      dispatchAddress: 'Shop — Ring Road, Surat', transport: 'Own vehicle', vehicle: 'GJ-03-CC-7781',
    },
  },
  {
    day: 31, party: 'nakoda', owner: 'office', source: 'website',
    lines: [{ product: 'GVT-6060-ONYX', packaging: 'Pallet', grade: 'Premium', quantities: [['Beige', 30]] }],
    outcome: { kind: 'lost', remark: 'Budget cut — will revisit next season' },
  },
  {
    day: 36, party: 'vishwa', owner: 'admin', source: 'call', priority: 'High',
    siteLocation: 'Vishwakarma Township, Scheme 78, Indore',
    notes: 'Township phase 1 — parking areas and boundary elevation.',
    lines: [
      { product: 'PK-3030-HEAV', packaging: 'Pallet', grade: 'Commercial', quantities: [['Grey', 300]] },
      { product: 'EL-3060-BRIC', packaging: 'Carton', grade: 'Standard', quantities: [['Terracotta', 100], ['Brown', 60]] },
    ],
    remarks: ['Quoted with freight included up to Indore', 'PO received by email'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 16, note: 'Dispatched in two lots, second lot 3 days later' },
      dispatchAddress: 'Site — Scheme 78, Indore', transport: 'Transporter', vehicle: 'MP-09-HT-3344',
    },
  },
  {
    day: 42, party: 'anand', owner: 'management', source: 'referral',
    lines: [
      { product: 'CW-3060-METR', packaging: 'Carton', grade: 'Standard', quantities: [['Grey', 60], ['Light Grey', 60]] },
      { product: 'CW-3045-SUBW', packaging: 'Carton', grade: 'Commercial', quantities: [['White', 80]] },
    ],
    remarks: ['Referred by Shree Ganesh Tiles'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 8, note: 'Pune transport — 2 days transit' },
      dispatchAddress: 'Depot — Market Yard Road, Pune', transport: 'Transporter', vehicle: 'MH-12-KL-9087',
    },
  },
  {
    day: 49, party: 'krishna', owner: 'office', source: 'walk_in',
    lines: [{ product: 'CF-3030-TERR', packaging: 'Carton', grade: 'Commercial', quantities: [['Terracotta', 20]] }],
    outcome: { kind: 'lost', remark: 'Customer did not return after quotation' },
  },
  {
    day: 55, party: 'metro', owner: 'admin', source: 'website', priority: 'High',
    siteLocation: 'Penthouse project, Bandra West',
    lines: [
      { product: 'GVT-8016-ARMA', packaging: 'Wooden crate', grade: 'Premium', quantities: [['Grey', 24]] },
      { product: 'GVT-6012-CALA', packaging: 'Wooden crate', grade: 'Premium', rate: 141000, quantities: [['White', 40]] },
    ],
    remarks: ['Architect wants book-matched slabs — confirmed same lot', 'Confirmed on call, 50% advance'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 12, note: 'Crated, dispatched with insurance' },
      dispatchAddress: 'Site — Bandra West, Mumbai', transport: 'Transporter', vehicle: 'MH-02-DE-4410',
    },
  },
  {
    day: 63, party: 'ganesh', owner: 'management', source: 'call', partyWise: true,
    lines: [
      { product: 'GVT-6012-CALA', packaging: 'Wooden crate', grade: 'Premium', quantities: [['White', 30], ['Ivory', 20]] },
    ],
    remarks: ['Second lot for the same showroom'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 6, note: 'Same-day loading' },
      dispatchAddress: 'Godown — Gondal Road, Rajkot', transport: 'Own vehicle', vehicle: 'GJ-03-CC-7781',
    },
  },
  {
    day: 70, party: 'sunrise', owner: 'admin', source: 'referral', priority: 'High',
    siteLocation: 'Sunrise Heights, Bopal — Tower B',
    notes: 'Full flooring for tower B. Phase-wise delivery.',
    lines: [
      { product: 'DC-6060-CRYS', packaging: 'Pallet', grade: 'Standard', quantities: [['White', 200]] },
      { product: 'CW-3060-FLOR', packaging: 'Carton', grade: 'Standard', quantities: [['Ivory', 90]] },
      { product: 'PK-3030-HEAV', packaging: 'Pallet', grade: 'Commercial', quantities: [['Grey', 150]] },
    ],
    remarks: ['Negotiated 4% on the whole lot', 'Work order signed'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 21, note: 'Phase 1 of 2 dispatched' },
      dispatchAddress: 'Site — Bopal, Ahmedabad', transport: 'Transporter', vehicle: 'GJ-01-JT-6612',
    },
  },
  {
    day: 78, party: 'laxmi', owner: 'management', source: 'whatsapp',
    lines: [{ product: 'CW-3060-AQUA', packaging: 'Carton', grade: 'Standard', quantities: [['Teal', 25], ['Sky Blue', 25]] }],
    outcome: { kind: 'lost', remark: 'Project postponed indefinitely' },
  },
  {
    day: 85, party: 'greenvalley', owner: 'admin', source: 'call', priority: 'Medium',
    siteLocation: 'Green Valley Phase 2, Gangapur Road, Nashik',
    lines: [
      { product: 'PK-4040-COBB', packaging: 'Pallet', grade: 'Standard', quantities: [['Grey', 120], ['Brown', 60]] },
      { product: 'EL-3060-SAND', packaging: 'Carton', grade: 'Standard', quantities: [['Beige', 80]] },
    ],
    remarks: ['Quoted ex-godown', 'Confirmed — wants delivery after monsoon'],
    outcome: {
      kind: 'won', order: { kind: 'postponed', remark: 'Party asked to hold until site road is ready' },
      dispatchAddress: 'Site — Gangapur Road, Nashik', transport: 'Transporter',
    },
  },
  {
    day: 92, party: 'patel', owner: 'office', source: 'whatsapp', partyWise: true,
    lines: [
      { product: 'CW-3060-AQUA', packaging: 'Carton', grade: 'Standard', quantities: [['Sky Blue', 40], ['White', 30]] },
      { product: 'CW-3045-SUBW', packaging: 'Carton', grade: 'Commercial', quantities: [['White', 60], ['Black', 20]] },
    ],
    remarks: ['Weekly order — same as last month'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 3, note: 'Tempo delivery to Navrangpura' },
      dispatchAddress: 'Shop — Navrangpura, Ahmedabad', transport: 'Own vehicle', vehicle: 'GJ-01-TT-1201',
    },
  },
  {
    day: 99, party: 'royal', owner: 'management', source: 'referral',
    siteLocation: 'Bungalow at Kalawad Road, Rajkot',
    lines: [
      { product: 'GVT-6012-STAT', packaging: 'Wooden crate', grade: 'Premium', quantities: [['White', 24]] },
      { product: 'GVT-2012-TEAK', packaging: 'Carton', grade: 'Premium', quantities: [['Walnut', 30]] },
    ],
    remarks: ['Interior designer picked Statuario matt for living room'],
    outcome: {
      kind: 'won', order: { kind: 'cancelled', remark: 'Client changed to imported marble' },
      dispatchAddress: 'Site — Kalawad Road, Rajkot',
    },
  },
  {
    day: 106, party: 'mehta', owner: 'management', source: 'call', priority: 'High',
    siteLocation: 'Andheri commercial tower',
    lines: [
      { product: 'GVT-8016-ARMA', packaging: 'Wooden crate', grade: 'Premium', quantities: [['Charcoal', 20], ['Grey', 20]] },
      { product: 'DC-8080-PEAR', packaging: 'Pallet', grade: 'Premium', quantities: [['Ivory', 90]] },
    ],
    remarks: ['Lobby flooring — needs 10% extra for cutting', 'Purchase order no. MC/2026/118'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 10, note: 'Crane loading at Morbi Unit 2' },
      dispatchAddress: 'Site — Andheri East, Mumbai', transport: 'Transporter', vehicle: 'MH-04-GH-2288',
    },
  },
  {
    day: 113, party: 'omsai', owner: 'office', source: 'call', partyWise: true,
    lines: [{ product: 'GVT-6060-ONYX', packaging: 'Pallet', grade: 'Premium', quantities: [['Ivory', 40], ['Brown', 20]] }],
    outcome: { kind: 'lost', remark: 'Comparing with another Morbi unit — lost on rate' },
  },
  {
    day: 120, party: 'balaji', owner: 'admin', source: 'referral', priority: 'Medium',
    siteLocation: 'Sun Residency — tower B',
    lines: [
      { product: 'DC-6060-NANO', packaging: 'Pallet', grade: 'Standard', quantities: [['Ivory', 50], ['White', 40]] },
      { product: 'CW-3060-FLOR', packaging: 'Carton', grade: 'Standard', quantities: [['Beige', 60]] },
    ],
    remarks: ['Repeat of tower A order', 'Confirmed'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 12, note: 'Delivered, POD received' },
      dispatchAddress: 'Site — Sun Residency, Alkapuri', transport: 'Transporter', vehicle: 'GJ-06-BB-2210',
    },
  },
  {
    day: 127, party: 'jaiambe', owner: 'management', source: 'whatsapp',
    lines: [
      { product: 'CF-2012-OAKW', packaging: 'Carton', grade: 'Standard', quantities: [['Brown', 60], ['Walnut', 10]] },
      { product: 'CF-4040-SLAT', packaging: 'Carton', grade: 'Standard', quantities: [['Brown', 40]] },
    ],
    remarks: ['Matt wood look — exactly what they asked for last time'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 7, note: 'Jaipur transport, 3 days transit' },
      dispatchAddress: 'Shop — Sanganer Road, Jaipur', transport: 'Transporter', vehicle: 'RJ-14-GC-5566',
    },
  },
  {
    day: 134, party: 'nakoda', owner: 'office', source: 'website',
    lines: [{ product: 'GVT-6060-SUGA', packaging: 'Pallet', grade: 'Premium', quantities: [['Grey', 30]] }],
    remarks: ['Wants to see the sugar finish in daylight — photos sent'],
    outcome: { kind: 'won', order: { kind: 'inProgress' }, dispatchAddress: 'Shop — Sukhadia Circle, Udaipur', transport: 'Transporter' },
  },
  // --- Recent history: orders in progress and the live pipeline ---
  {
    day: 141, party: 'sunrise', owner: 'admin', source: 'referral', priority: 'High',
    siteLocation: 'Sunrise Heights, Bopal — Tower B (phase 2)',
    lines: [
      { product: 'DC-6060-CRYS', packaging: 'Pallet', grade: 'Standard', quantities: [['White', 150]] },
      { product: 'GVT-6060-CARR', packaging: 'Pallet', grade: 'Premium', quantities: [['White', 40]] },
    ],
    remarks: ['Phase 2 — lobby in Carrara', 'Confirmed against the same work order'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 9, note: 'Phase 2 dispatched' },
      dispatchAddress: 'Site — Bopal, Ahmedabad', transport: 'Transporter', vehicle: 'GJ-01-JT-6612',
    },
  },
  {
    day: 148, party: 'anand', owner: 'management', source: 'call',
    lines: [{ product: 'GVT-2012-TEAK', packaging: 'Carton', grade: 'Premium', quantities: [['Brown', 50]] }],
    remarks: ['For a café interior — needs by month end'],
    outcome: {
      kind: 'won', order: { kind: 'inProgress' },
      dispatchAddress: 'Depot — Market Yard Road, Pune', transport: 'Transporter',
    },
  },
  {
    day: 152, party: 'ganesh', owner: 'management', source: 'call', partyWise: true, priority: 'Medium',
    lines: [
      { product: 'DC-6060-CRYS', packaging: 'Pallet', grade: 'Standard', quantities: [['White', 100]] },
      { product: 'GVT-6060-CARR', packaging: 'Pallet', grade: 'Premium', quantities: [['Light Grey', 30]] },
    ],
    remarks: ['Monthly refill'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 5, onDay: SAMPLE_WINDOW_DAYS, note: 'Loaded this morning' },
      dispatchAddress: 'Godown — Gondal Road, Rajkot', transport: 'Own vehicle', vehicle: 'GJ-03-CC-7781',
    },
  },
  {
    day: 155, party: 'vishwa', owner: 'admin', source: 'call', priority: 'High',
    siteLocation: 'Vishwakarma Township — phase 2',
    lines: [
      { product: 'PK-3030-HEAV', packaging: 'Pallet', grade: 'Commercial', quantities: [['Grey', 250], ['Terracotta', 60]] },
      { product: 'PK-4040-COBB', packaging: 'Pallet', grade: 'Standard', quantities: [['Grey', 60]] },
    ],
    remarks: ['Phase 2 parking — PO awaited', 'PO received, loading next week'],
    outcome: {
      kind: 'won', order: { kind: 'inProgress' },
      dispatchAddress: 'Site — Scheme 78, Indore', transport: 'Transporter',
    },
  },
  {
    day: 158, party: 'metro', owner: 'admin', source: 'website', priority: 'High', followUpInDays: -3,
    siteLocation: 'Villa project, Alibaug',
    lines: [
      { product: 'GVT-6012-CALA', packaging: 'Wooden crate', grade: 'Premium', quantities: [['Ivory', 30]] },
      { product: 'GVT-6012-STAT', packaging: 'Wooden crate', grade: 'Premium', quantities: [['Light Grey', 20]] },
    ],
    remarks: ['Quoted with crating charges', 'Architect asking for 5% — need approval'],
    outcome: { kind: 'open', stage: 'Negotiating' },
  },
  {
    day: 160, party: 'patel', owner: 'office', source: 'whatsapp', partyWise: true, followUpInDays: -1,
    lines: [
      { product: 'CW-3060-METR', packaging: 'Carton', grade: 'Standard', quantities: [['Charcoal', 40], ['Grey', 40]] },
    ],
    remarks: ['Quotation sent on WhatsApp'],
    outcome: { kind: 'open', stage: 'Quoted' },
  },
  {
    day: 162, party: 'royal', owner: 'management', source: 'referral', priority: 'Medium', followUpInDays: 2,
    siteLocation: 'Clinic interior, Rajkot',
    lines: [
      { product: 'GVT-6060-SUGA', packaging: 'Pallet', grade: 'Premium', quantities: [['Beige', 25]] },
      { product: 'CW-3060-FLOR', packaging: null, quantities: [['Ivory', 20]] },
    ],
    remarks: ['Rate list shared, waiting for wall tile selection'],
    outcome: { kind: 'open', stage: 'Quoted' },
  },
  {
    day: 164, party: 'laxmi', owner: 'management', source: 'call', followUpInDays: 0,
    lines: [{ product: 'CF-3030-TERR', packaging: 'Carton', grade: 'Commercial', quantities: [['Terracotta', 60], ['Brown', 40]] }],
    remarks: ['Wants freight included — checking with transporter'],
    outcome: { kind: 'open', stage: 'Negotiating' },
  },
  {
    day: 165, party: 'krishna', owner: 'office', source: 'walk_in', followUpInDays: 5,
    lines: [
      { product: 'CW-3045-SUBW', packaging: 'Carton', grade: 'Commercial', quantities: [['Sky Blue', 15], ['White', 15]] },
    ],
    outcome: { kind: 'open', stage: 'Quoted' },
  },
  {
    day: 166, party: 'greenvalley', owner: 'admin', source: 'call', priority: 'Low', followUpInDays: 10,
    siteLocation: 'Green Valley Phase 3',
    notes: 'Early enquiry for phase 3 — budget stage.',
    lines: [
      { product: 'PK-4040-COBB', packaging: null, quantities: [['Grey', 200]] },
      { product: 'EL-3060-SAND', packaging: null, quantities: [['Ivory', 100]] },
    ],
    outcome: { kind: 'open', stage: 'New' },
  },
  {
    day: 167, party: 'omsai', owner: 'office', source: 'whatsapp', partyWise: true, followUpInDays: 1,
    lines: [{ product: 'GVT-6060-ONYX', packaging: 'Pallet', grade: 'Premium', quantities: [['Beige', 40]] }],
    outcome: { kind: 'open', stage: 'New' },
  },
  {
    day: 168, party: 'nakoda', owner: 'management', source: 'referral', priority: 'Medium', followUpInDays: 3,
    lines: [
      { product: 'DC-6060-GALA', packaging: 'Pallet', grade: 'Standard', quantities: [['Black', 60]] },
      { product: 'DC-6060-NANO', packaging: 'Pallet', grade: 'Standard', quantities: [['Ivory', 60]] },
    ],
    remarks: ['Asked for a combined rate for both'],
    outcome: { kind: 'open', stage: 'New' },
  },
  {
    day: 169, party: 'anand', owner: 'office', source: 'call', followUpInDays: 7,
    lines: [{ product: 'EL-3060-BRIC', packaging: 'Carton', grade: 'Standard', quantities: [['Charcoal', 30]] }],
    outcome: { kind: 'open', stage: 'New' },
  },
];

/**
 * What goes to the Recycle Bin at the end, so that screen is not empty: a
 * party that closed down, the discontinued product, and one of the lost
 * leads. Chosen so nothing above depends on them still being live — the party
 * has no leads, the product has no stock and no line, and a lost lead has no
 * order.
 */
export const SAMPLE_DELETIONS = {
  party: 'hariom',
  product: 'CW-2030-PLNW',
  /** Index into `SAMPLE_LEADS` — the first lost lead. */
  leadIndex: 2,
} as const;

// --- Deterministic randomness ---------------------------------------------

/**
 * A tiny seeded generator (mulberry32) so two runs on two machines produce
 * the same jitter in times — a test can then assert exact counts, and a
 * screenshot in the docs matches what a reader sees.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
