/**
 * The sample dataset `sample-data.service.ts` seeds — a small sanitaryware
 * trade, written down rather than generated, so that what a person sees on a
 * demo Master reads like a business and not like `Product 17`.
 *
 * The product master itself is the SWISWARE catalogue file
 * (`master/assets/catalogue/swisware-plus-2026.md`), loaded first by
 * `catalogue-seed.service.ts`. This file only says which of its sub products
 * the demo trades in, with which illustrative weights, and what happened to
 * them.
 *
 * Pure data and pure rules only: no database, no clock. Every date is a day
 * offset from the start of the seeded window (`SAMPLE_WINDOW_DAYS` days before
 * "today"), and every reference between records is by a human key the seed
 * resolves — a sub-product *key* (`SAMPLE_SUB_PRODUCTS`), a party *key* —
 * never an id or a generated code, because both are minted at seed time.
 *
 * Weights are **illustrative demo figures**, not catalogue data — the
 * catalogue prints none, and the seed only sets them on the variants the demo
 * quotes, so the "weight missing" flag is also on show.
 */

import type { FieldListKey } from '@orderbook/shared';

/** How far back the generated history starts. */
export const SAMPLE_WINDOW_DAYS = 170;

/**
 * The phone number the seed checks before it writes anything. It belongs to
 * the first party below: if a party carries it, this dataset has been seeded
 * here before.
 */
export const SAMPLE_MARKER_PARTY_KEY = 'ganesh';

export type SampleUser = 'admin' | 'management' | 'office';

// --- Option lists ----------------------------------------------------------

export interface SampleOptionValue {
  value: string;
  hex?: string;
}

/**
 * Every managed list gets values, so each picker on the Fields screen has
 * rows. `stock.colour` — the colour list — and `product.brand` are seeded by
 * the catalogue loader from the catalogue file itself, so both are empty here.
 */
export const SAMPLE_OPTION_VALUES: Record<FieldListKey, readonly SampleOptionValue[]> = {
  // `lead.sourcePlatform` is seeded by the tenancy migration; nothing to add.
  'lead.sourcePlatform': [],
  'stock.colour': [],
  'product.brand': [],
  'line.packaging': [
    { value: 'Carton' },
    { value: 'Thermocol box' },
    { value: 'Wooden crate' },
    { value: 'Loose' },
  ],
  /*
   * Demo values only. The live list ships empty — a company's grade ladder is
   * its own, and Settings → Fields is where it puts one (see
   * `shared/src/domain/fields.ts`). This file is the sample-data seed nobody
   * runs on a real installation.
   */
  'line.grade': [{ value: 'A' }, { value: 'B' }, { value: 'C' }],
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

// --- The models the demo trades in ------------------------------------------

/**
 * Where each sample key lives in the catalogue: the product's code and the
 * sub product's printed name, the pair that is stable across loads — the
 * `CODE-0001…` variant codes are generated, and a printed name alone repeats
 * across products (`MAGENTA`, `BLACK`). The keys are the demo's own names,
 * kept from before catalogue v2 so the history below reads unchanged.
 */
/* prettier-ignore */
export const SAMPLE_SUB_PRODUCTS: Readonly<Record<string, { product: string; subProduct: string }>> = {
  '102': { product: 'OPT', subProduct: '102 (9")' },
  '107': { product: 'OPT', subProduct: '107 (9")' },
  '1181': { product: 'OPT', subProduct: '1181' },
  '1184': { product: 'OPT', subProduct: '1184' },
  'DAMRU-WHITE': { product: 'OPB', subProduct: 'DAMRU' },
  'NOVA-WHITE': { product: 'OPB', subProduct: 'NOVA' },
  '41': { product: 'DMV', subProduct: '41' },
  '42': { product: 'DMV', subProduct: '42' },
  '46': { product: 'DMV', subProduct: '46' },
  '150': { product: 'NVV', subProduct: '150' },
  'WB-18X12': { product: 'WB', subProduct: '18x12' },
  'WB-20X16': { product: 'WB', subProduct: '20x16' },
  'WB-18X12-VITROSA-BLACK': { product: 'V1812', subProduct: 'BLACK' },
  'WB-18X12-RUSTIC-COFFEE-BROWN': { product: 'R1812', subProduct: 'COFFEE BROWN' },
  'SOFIYA-SET-WHITE': { product: 'PS', subProduct: 'SOFIYA SET (22X17)' },
  'BIG-STERLING-SET-WHITE': { product: 'PS', subProduct: 'BIG STERLING SET (25X21)' },
  'SOFIYA-SET-VITROSA-MAGENTA': { product: 'SFD', subProduct: 'MAGENTA' },
  'SOFIYA-SET-VITROSA-MINT-GREEN': { product: 'SFD', subProduct: 'MINT GREEN' },
  '3001': { product: 'BSD', subProduct: '3001' },
  'BIG-STERLING-SET-RUSTIC-MAGENTA': { product: 'RS', subProduct: 'BIG STERLING SET MAGENTA' },
  'EWC-S-TRAP': { product: 'WC', subProduct: 'E.W.C - S TRAP' },
  '20-OP': { product: 'OP', subProduct: '20" O.P' },
  'HEXA-URINAL': { product: 'UR', subProduct: 'HEXA URINAL' },
  '7501': { product: 'TTW', subProduct: '7501' },
  '7721': { product: 'TTV', subProduct: '7721' },
  'DUAL-FLUSH-TANK-CISTERN': { product: 'ACC', subProduct: 'DUAL FLUSH TANK CISTERN' },
  'MERCH-CATALOGUE': { product: 'MER', subProduct: 'CATALOGUE' },
};

/**
 * One line of the range the demo weighs and quotes — one or more sub
 * products sold together under a name. The sub products themselves come from
 * the catalogue; this only adds what a business enters into the product
 * master.
 */
export interface SampleProduct {
  /** The range's name, for the photo caption. */
  model: string;
  alias?: string;
  /**
   * Illustrative weight in kilograms per sample key (`SAMPLE_SUB_PRODUCTS`),
   * each its own sub product. The rest of the catalogue keeps
   * `weightKg: null` — the demo shows the "weight missing" flag as well as
   * the totals.
   */
  weights: Readonly<Record<string, number>>;
  /** Which swatch `tile-swatch.ts` draws for the photo. */
  pattern: 'marble' | 'wood' | 'stone' | 'plain';
  launchYear: number;
}

/* prettier-ignore */
export const SAMPLE_PRODUCTS: readonly SampleProduct[] = [
  { model: '102', alias: 'OPT 102', weights: { '102': 32.5 }, pattern: 'plain', launchYear: 2023 },
  { model: '107', alias: 'OPT 107', weights: { '107': 33 }, pattern: 'plain', launchYear: 2024 },
  { model: '1181', alias: 'Triangle red', weights: { '1181': 33.5 }, pattern: 'stone', launchYear: 2025 },
  { model: '1184', alias: 'Triangle blue', weights: { '1184': 33.5 }, pattern: 'stone', launchYear: 2025 },
  { model: 'DAMRU', weights: { 'DAMRU-WHITE': 18, '41': 18.5, '42': 18.5, '46': 18.5 }, pattern: 'marble', launchYear: 2022 },
  { model: 'NOVA', weights: { 'NOVA-WHITE': 17, '150': 17.5 }, pattern: 'wood', launchYear: 2023 },
  { model: '18x12', alias: 'WB 18x12', weights: { 'WB-18X12': 7.5, 'WB-18X12-VITROSA-BLACK': 7.5, 'WB-18X12-RUSTIC-COFFEE-BROWN': 7.5 }, pattern: 'plain', launchYear: 2021 },
  { model: '20x16', alias: 'WB 20x16', weights: { 'WB-20X16': 9.5 }, pattern: 'plain', launchYear: 2021 },
  { model: 'SOFIYA SET', alias: 'Sofiya', weights: { 'SOFIYA-SET-WHITE': 21, 'SOFIYA-SET-VITROSA-MAGENTA': 21, 'SOFIYA-SET-VITROSA-MINT-GREEN': 21 }, pattern: 'plain', launchYear: 2022 },
  { model: 'BIG STERLING SET', alias: 'Big Sterling', weights: { 'BIG-STERLING-SET-WHITE': 26, '3001': 27, 'BIG-STERLING-SET-RUSTIC-MAGENTA': 27 }, pattern: 'marble', launchYear: 2022 },
  { model: 'E.W.C - S TRAP', alias: 'EWC S', weights: { 'EWC-S-TRAP': 22 }, pattern: 'plain', launchYear: 2020 },
  { model: '20" O.P', alias: 'Orissa 20', weights: { '20-OP': 11 }, pattern: 'plain', launchYear: 2019 },
  { model: 'HEXA URINAL', weights: { 'HEXA-URINAL': 8 }, pattern: 'plain', launchYear: 2020 },
  { model: '7501', alias: 'Table top 7501', weights: { '7501': 10 }, pattern: 'plain', launchYear: 2024 },
  { model: '7721', alias: 'Vitrosa 7721', weights: { '7721': 10.5 }, pattern: 'marble', launchYear: 2025 },
  { model: 'DUAL FLUSH TANK CISTERN', alias: 'Dual flush cistern', weights: { 'DUAL-FLUSH-TANK-CISTERN': 3.2 }, pattern: 'plain', launchYear: 2021 },
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
    notes: 'Largest dealer in Rajkot. Moves one-piece toilets and Damru basins. Collects from the Gondal Road godown.',
    dealerType: 'Dealer', creditDays: 30,
  },
  {
    key: 'patel', name: 'Patel Ceramic Traders', phone: '99090 45678', email: 'patelceramic@example.com',
    addressLine1: 'Shop 4, Navrangpura Market', city: 'Ahmedabad', state: 'Gujarat', pincode: '380009',
    gstNumber: '24AAFCP5678G1ZK', notes: 'Weekly orders for wash basins and sets. Ask for Kirtibhai.',
    dealerType: 'Dealer', creditDays: 15,
  },
  {
    key: 'omsai', name: 'Om Sai Marble & Sanitary', phone: '98980 22334', addressLine1: 'Ring Road, Opp. Silk City Mall',
    city: 'Surat', state: 'Gujarat', pincode: '395002', gstNumber: '24AAGCO9012H1Z3',
    notes: 'Stocks mainly Vitrosa basins. Wants a sample piece before every new pattern.', dealerType: 'Dealer', creditDays: 21,
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
    gstNumber: '27AAACM7890K1ZP', notes: 'Handled by management only. Large project orders.',
    dealerType: 'Builder', creditDays: 60,
  },
  {
    key: 'anand', name: 'Anand Sanitary Depot', phone: '98220 66778', addressLine1: '45, Market Yard Road',
    city: 'Pune', state: 'Maharashtra', pincode: '411037', gstNumber: '27AABCA2345L1Z6',
    dealerType: 'Dealer', creditDays: 30,
  },
  {
    key: 'jaiambe', name: 'Jai Ambe Traders', phone: '94140 77889', addressLine1: 'Sanganer Road',
    addressLine2: 'Near Tonk Phatak', city: 'Jaipur', state: 'Rajasthan', pincode: '302015',
    gstNumber: '08AADCJ6789M1ZR', notes: 'Wants plain white only — no patterns.', dealerType: 'Dealer', creditDays: 30,
  },
  {
    key: 'nakoda', name: 'Nakoda Ceramics', phone: '94600 88990', addressLine1: 'Sukhadia Circle',
    city: 'Udaipur', state: 'Rajasthan', pincode: '313001', gstNumber: '08AAECN0123N1ZT',
    dealerType: 'Dealer', creditDays: 21,
  },
  {
    key: 'vishwa', name: 'Vishwakarma Builders', phone: '98930 99001', email: 'site@vishwakarma.example.com',
    addressLine1: 'Plot 8, Scheme 78', city: 'Indore', state: 'Madhya Pradesh', pincode: '452010',
    gstNumber: '23AAFCV4567P1ZV', notes: 'Township project — toilets and wash basins for every flat.',
    dealerType: 'Builder', creditDays: 45,
  },
  {
    key: 'krishna', name: 'Krishna Sanitary', phone: '99250 10112', addressLine1: 'Sector 21, GH Road',
    city: 'Gandhinagar', state: 'Gujarat', pincode: '382021', gstNumber: '24AAKCK8901Q1ZX',
    dealerType: 'Retail', creditDays: 0,
  },
  {
    key: 'metro', name: 'Metro Bath Studio', phone: '98670 21223', email: 'hello@metrobathstudio.example.com',
    addressLine1: 'Linking Road, Bandra West', city: 'Mumbai', state: 'Maharashtra', pincode: '400050',
    gstNumber: '27AAMCM2345R1ZZ', notes: 'Architect-led studio. Designer toilets and table-top basins.',
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
    key: 'hariom', name: 'Hari Om Sanitary Mart', phone: '98790 76778', addressLine1: 'Bedi Gate',
    city: 'Jamnagar', state: 'Gujarat', pincode: '361001', gstNumber: '24AAHCH8901V1ZH',
    notes: 'Closed down — kept for history.', dealerType: 'Dealer', creditDays: 0,
  },
];

/** Party-wise records: a dealer's own name and packaging for a model. */
export interface SamplePartyVariant {
  party: string;
  /** A sample key (`SAMPLE_SUB_PRODUCTS`) — the record is per sub product. */
  code: string;
  alias?: string;
  packaging?: string;
}

export const SAMPLE_PARTY_VARIANTS: readonly SamplePartyVariant[] = [
  { party: 'ganesh', code: '102', alias: 'OPT 102', packaging: 'Carton' },
  { party: 'ganesh', code: 'DAMRU-WHITE', alias: 'Damru', packaging: 'Thermocol box' },
  { party: 'ganesh', code: 'BIG-STERLING-SET-WHITE', alias: 'Big Sterling', packaging: 'Carton' },
  { party: 'patel', code: 'WB-18X12', alias: 'WB 18x12', packaging: 'Carton' },
  { party: 'patel', code: 'SOFIYA-SET-WHITE', packaging: 'Carton' },
  { party: 'omsai', code: 'NOVA-WHITE', alias: 'Nova', packaging: 'Thermocol box' },
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

/**
 * Opening stock per sample key, as pieces received from the factory in the
 * first days of the window. Every weighed variant above gets stock; codes not
 * listed here get `DEFAULT_OPENING_PIECES`, and a few are deliberately thin
 * so the low-stock count on the dashboard is not zero.
 */
export const DEFAULT_OPENING_PIECES = 40;
export const DEFAULT_REORDER_LEVEL = 10;
export const DEFAULT_MIN_STOCK_LEVEL = 5;
export const DEFAULT_MAX_STOCK_LEVEL = 120;

export const SAMPLE_OPENING_STOCK: Readonly<Record<string, number>> = {
  '102': 90,
  '107': 60,
  '1181': 8,
  '1184': 3,
  'DAMRU-WHITE': 75,
  '41': 6,
  '42': 24,
  'NOVA-WHITE': 50,
  'WB-18X12': 160,
  'WB-18X12-RUSTIC-COFFEE-BROWN': 4,
  'WB-20X16': 70,
  'SOFIYA-SET-WHITE': 55,
  'BIG-STERLING-SET-WHITE': 30,
  'EWC-S-TRAP': 120,
  '20-OP': 200,
  'HEXA-URINAL': 45,
  'DUAL-FLUSH-TANK-CISTERN': 80,
};

/** A physical count that disagreed with the ledger, at a point in the window. */
export interface SampleStockCount {
  day: number;
  code: string;
  countedPieces: number;
  note: string;
}

export const SAMPLE_STOCK_COUNTS: readonly SampleStockCount[] = [
  { day: 58, code: '102', countedPieces: 128, note: 'Monthly count — 2 pieces chipped in godown' },
  { day: 101, code: 'WB-18X12', countedPieces: 118, note: 'Found 4 extra pieces behind rack 3' },
  { day: 147, code: '20-OP', countedPieces: 146, note: 'Quarterly count' },
];

/** Stock that arrived later in the window, so the ledger is not one opening entry per row. */
export interface SampleStockArrival {
  day: number;
  code: string;
  pieces: number;
  note: string;
}

export const SAMPLE_STOCK_ARRIVALS: readonly SampleStockArrival[] = [
  { day: 44, code: '102', pieces: 60, note: 'Truck GJ-03-AX-4521 from Thangadh' },
  { day: 71, code: 'DAMRU-WHITE', pieces: 40, note: 'Fresh kiln lot' },
  { day: 96, code: 'SOFIYA-SET-WHITE', pieces: 40, note: 'Restock for wedding season' },
  { day: 118, code: '41', pieces: 30, note: 'Truck GJ-03-BT-9910' },
  { day: 139, code: '1184', pieces: 12, note: 'Designer lot — handle with care' },
  { day: 160, code: 'EWC-S-TRAP', pieces: 80, note: 'Restock' },
];

// --- Leads, orders and their histories -------------------------------------

/** One sub product on a lead, by its sample key (`SAMPLE_SUB_PRODUCTS`). */
export interface SampleLine {
  code: string;
  quantity: number;
  /** `null` leaves packaging unset — a half-built lead that cannot convert yet. */
  packaging: string | null;
  /** A colour from the colour list — only on a multicolour sub product (Water Closet, Orissa Pan). */
  colour?: string;
  notes?: string;
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
      { code: '102', quantity: 20, packaging: 'Carton' },
      { code: 'DAMRU-WHITE', quantity: 15, packaging: 'Thermocol box' },
      { code: '41', quantity: 6, packaging: 'Thermocol box' },
    ],
    remarks: ['Catalogue shared on WhatsApp', 'Confirmed with the party, godown address noted'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 9, note: 'Dispatched by Shreeji Roadlines' },
      dispatchAddress: 'Godown — Gondal Road, Rajkot', transport: 'Transporter', vehicle: 'GJ-03-AX-4521',
    },
  },
  {
    day: 15, party: 'balaji', owner: 'admin', source: 'referral', priority: 'High',
    siteLocation: 'Sun Residency, Alkapuri, Vadodara',
    lines: [
      { code: 'EWC-S-TRAP', quantity: 48, packaging: 'Carton', colour: 'Ivory' },
      { code: 'WB-18X12', quantity: 48, packaging: 'Carton' },
    ],
    remarks: ['Quoted for tower A — 48 flats', 'Site engineer approved the EWC sample'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 14, note: 'Two trucks, unloaded at site' },
      dispatchAddress: 'Site — Sun Residency, Alkapuri', transport: 'Transporter', vehicle: 'GJ-06-BB-2210',
    },
  },
  {
    day: 19, party: 'jaiambe', owner: 'office', source: 'whatsapp',
    lines: [{ code: '107', quantity: 10, packaging: 'Carton' }],
    remarks: ['Asked for ivory — told white only in this lot'],
    outcome: { kind: 'lost', remark: 'Went with a cheaper local supplier' },
  },
  {
    day: 24, party: 'omsai', owner: 'management', source: 'walk_in', partyWise: true, priority: 'Medium',
    lines: [
      { code: 'NOVA-WHITE', quantity: 12, packaging: 'Thermocol box' },
      { code: '150', quantity: 4, packaging: 'Thermocol box' },
    ],
    remarks: ['Sample piece given from showroom stock'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 11, note: 'Delivered to Ring Road shop' },
      dispatchAddress: 'Shop — Ring Road, Surat', transport: 'Own vehicle', vehicle: 'GJ-03-CC-7781',
    },
  },
  {
    day: 31, party: 'nakoda', owner: 'office', source: 'website',
    lines: [{ code: '7501', quantity: 6, packaging: 'Thermocol box' }],
    outcome: { kind: 'lost', remark: 'Budget cut — will revisit next season' },
  },
  {
    day: 36, party: 'vishwa', owner: 'admin', source: 'call', priority: 'High',
    siteLocation: 'Vishwakarma Township, Scheme 78, Indore',
    notes: 'Township phase 1 — every flat gets an EWC and a wash basin.',
    lines: [
      { code: 'EWC-S-TRAP', quantity: 120, packaging: 'Carton' },
      { code: 'WB-18X12', quantity: 120, packaging: 'Carton' },
      { code: '20-OP', quantity: 40, packaging: 'Loose', colour: 'Ivory' },
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
      { code: 'SOFIYA-SET-WHITE', quantity: 12, packaging: 'Carton' },
      { code: 'SOFIYA-SET-VITROSA-MAGENTA', quantity: 4, packaging: 'Carton' },
      { code: 'HEXA-URINAL', quantity: 10, packaging: 'Carton' },
    ],
    remarks: ['Referred by Shree Ganesh Tiles'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 8, note: 'Pune transport — 2 days transit' },
      dispatchAddress: 'Depot — Market Yard Road, Pune', transport: 'Transporter', vehicle: 'MH-12-KL-9087',
    },
  },
  {
    day: 49, party: 'krishna', owner: 'office', source: 'walk_in',
    lines: [{ code: '20-OP', quantity: 10, packaging: 'Loose' }],
    outcome: { kind: 'lost', remark: 'Customer did not return after quotation' },
  },
  {
    day: 55, party: 'metro', owner: 'admin', source: 'website', priority: 'High',
    siteLocation: 'Penthouse project, Bandra West',
    lines: [
      { code: '1181', quantity: 2, packaging: 'Wooden crate' },
      { code: '7721', quantity: 3, packaging: 'Wooden crate' },
    ],
    remarks: ['Architect wants the red triangle design — confirmed same lot', 'Confirmed on call, crating agreed'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 12, note: 'Crated, dispatched with insurance' },
      dispatchAddress: 'Site — Bandra West, Mumbai', transport: 'Transporter', vehicle: 'MH-02-DE-4410',
    },
  },
  {
    day: 63, party: 'ganesh', owner: 'management', source: 'call', partyWise: true,
    lines: [
      { code: 'DAMRU-WHITE', quantity: 10, packaging: 'Thermocol box' },
      { code: '42', quantity: 6, packaging: 'Thermocol box' },
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
    notes: 'Full sanitaryware for tower B. Phase-wise delivery.',
    lines: [
      { code: '102', quantity: 60, packaging: 'Carton' },
      { code: 'WB-20X16', quantity: 60, packaging: 'Carton' },
      { code: 'DUAL-FLUSH-TANK-CISTERN', quantity: 60, packaging: 'Carton' },
    ],
    remarks: ['Agreed to split dispatch into two phases', 'Work order signed'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 21, note: 'Phase 1 of 2 dispatched' },
      dispatchAddress: 'Site — Bopal, Ahmedabad', transport: 'Transporter', vehicle: 'GJ-01-JT-6612',
    },
  },
  {
    day: 78, party: 'laxmi', owner: 'management', source: 'whatsapp',
    lines: [
      { code: 'WB-18X12-VITROSA-BLACK', quantity: 8, packaging: 'Carton' },
      { code: 'WB-18X12-RUSTIC-COFFEE-BROWN', quantity: 8, packaging: 'Carton' },
    ],
    outcome: { kind: 'lost', remark: 'Project postponed indefinitely' },
  },
  {
    day: 85, party: 'greenvalley', owner: 'admin', source: 'call', priority: 'Medium',
    siteLocation: 'Green Valley Phase 2, Gangapur Road, Nashik',
    lines: [
      { code: 'EWC-S-TRAP', quantity: 40, packaging: 'Carton' },
      { code: '20-OP', quantity: 30, packaging: 'Loose' },
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
      { code: 'WB-18X12', quantity: 30, packaging: 'Carton' },
      { code: 'SOFIYA-SET-WHITE', quantity: 10, packaging: 'Carton' },
      { code: 'SOFIYA-SET-VITROSA-MINT-GREEN', quantity: 4, packaging: 'Carton' },
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
      { code: '1184', quantity: 2, packaging: 'Wooden crate' },
      { code: '46', quantity: 2, packaging: 'Thermocol box' },
    ],
    remarks: ['Interior designer picked the blue triangle for the guest bath'],
    outcome: {
      kind: 'won', order: { kind: 'cancelled', remark: 'Client changed to an imported range' },
      dispatchAddress: 'Site — Kalawad Road, Rajkot',
    },
  },
  {
    day: 106, party: 'mehta', owner: 'management', source: 'call', priority: 'High',
    siteLocation: 'Andheri commercial tower',
    lines: [
      { code: 'HEXA-URINAL', quantity: 24, packaging: 'Carton' },
      { code: 'WB-20X16', quantity: 30, packaging: 'Carton' },
      { code: 'EWC-S-TRAP', quantity: 36, packaging: 'Carton' },
    ],
    remarks: ['Washrooms on all six floors', 'Purchase order no. MC/2026/118'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 10, note: 'Loaded at Thangadh' },
      dispatchAddress: 'Site — Andheri East, Mumbai', transport: 'Transporter', vehicle: 'MH-04-GH-2288',
    },
  },
  {
    day: 113, party: 'omsai', owner: 'office', source: 'call', partyWise: true,
    lines: [{ code: 'NOVA-WHITE', quantity: 8, packaging: 'Thermocol box' }],
    outcome: { kind: 'lost', remark: 'Comparing with another Thangadh unit — lost on terms' },
  },
  {
    day: 120, party: 'balaji', owner: 'admin', source: 'referral', priority: 'Medium',
    siteLocation: 'Sun Residency — tower B',
    lines: [
      { code: 'EWC-S-TRAP', quantity: 40, packaging: 'Carton' },
      { code: 'WB-18X12', quantity: 40, packaging: 'Carton' },
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
      { code: '107', quantity: 12, packaging: 'Carton' },
      { code: 'BIG-STERLING-SET-WHITE', quantity: 6, packaging: 'Carton' },
    ],
    remarks: ['Plain white — exactly what they asked for last time'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 7, note: 'Jaipur transport, 3 days transit' },
      dispatchAddress: 'Shop — Sanganer Road, Jaipur', transport: 'Transporter', vehicle: 'RJ-14-GC-5566',
    },
  },
  {
    day: 134, party: 'nakoda', owner: 'office', source: 'website',
    lines: [{ code: '7501', quantity: 8, packaging: 'Thermocol box' }],
    remarks: ['Wants to see the table top in daylight — photos sent'],
    outcome: { kind: 'won', order: { kind: 'inProgress' }, dispatchAddress: 'Shop — Sukhadia Circle, Udaipur', transport: 'Transporter' },
  },
  // --- Recent history: orders in progress and the live pipeline ---
  {
    day: 141, party: 'sunrise', owner: 'admin', source: 'referral', priority: 'High',
    siteLocation: 'Sunrise Heights, Bopal — Tower B (phase 2)',
    lines: [
      { code: '102', quantity: 40, packaging: 'Carton' },
      { code: 'DAMRU-WHITE', quantity: 12, packaging: 'Thermocol box' },
    ],
    remarks: ['Phase 2 — lobby washrooms get Damru basins', 'Confirmed against the same work order'],
    outcome: {
      kind: 'won', order: { kind: 'dispatched', afterDays: 9, note: 'Phase 2 dispatched' },
      dispatchAddress: 'Site — Bopal, Ahmedabad', transport: 'Transporter', vehicle: 'GJ-01-JT-6612',
    },
  },
  {
    day: 148, party: 'anand', owner: 'management', source: 'call',
    lines: [{ code: 'BIG-STERLING-SET-RUSTIC-MAGENTA', quantity: 4, packaging: 'Carton' }],
    remarks: ['For a café washroom — needs by month end'],
    outcome: {
      kind: 'won', order: { kind: 'inProgress' },
      dispatchAddress: 'Depot — Market Yard Road, Pune', transport: 'Transporter',
    },
  },
  {
    day: 152, party: 'ganesh', owner: 'management', source: 'call', partyWise: true, priority: 'Medium',
    lines: [
      { code: '102', quantity: 24, packaging: 'Carton' },
      { code: 'BIG-STERLING-SET-WHITE', quantity: 6, packaging: 'Carton' },
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
      { code: 'EWC-S-TRAP', quantity: 100, packaging: 'Carton' },
      { code: '20-OP', quantity: 60, packaging: 'Loose' },
      { code: 'DUAL-FLUSH-TANK-CISTERN', quantity: 100, packaging: 'Carton' },
    ],
    remarks: ['Phase 2 — PO awaited', 'PO received, loading next week'],
    outcome: {
      kind: 'won', order: { kind: 'inProgress' },
      dispatchAddress: 'Site — Scheme 78, Indore', transport: 'Transporter',
    },
  },
  {
    day: 158, party: 'metro', owner: 'admin', source: 'website', priority: 'High', followUpInDays: -3,
    siteLocation: 'Villa project, Alibaug',
    lines: [
      { code: '1184', quantity: 3, packaging: 'Wooden crate' },
      { code: '7721', quantity: 4, packaging: 'Wooden crate' },
    ],
    remarks: ['Quoted with wooden crating', 'Architect asking for a matt finish — need approval'],
    outcome: { kind: 'open', stage: 'Negotiating' },
  },
  {
    day: 160, party: 'patel', owner: 'office', source: 'whatsapp', partyWise: true, followUpInDays: -1,
    lines: [
      { code: 'WB-18X12', quantity: 40, packaging: 'Carton' },
      { code: 'WB-18X12-VITROSA-BLACK', quantity: 6, packaging: 'Carton' },
    ],
    remarks: ['Quotation sent on WhatsApp'],
    outcome: { kind: 'open', stage: 'Quoted' },
  },
  {
    day: 162, party: 'royal', owner: 'management', source: 'referral', priority: 'Medium', followUpInDays: 2,
    siteLocation: 'Clinic interior, Rajkot',
    lines: [
      { code: '7501', quantity: 3, packaging: 'Thermocol box' },
      { code: 'HEXA-URINAL', quantity: 4, packaging: null },
    ],
    remarks: ['Catalogue shared, waiting for the urinal selection'],
    outcome: { kind: 'open', stage: 'Quoted' },
  },
  {
    day: 164, party: 'laxmi', owner: 'management', source: 'call', followUpInDays: 0,
    lines: [
      { code: '20-OP', quantity: 40, packaging: 'Loose', colour: 'Ivory' },
      { code: 'EWC-S-TRAP', quantity: 20, packaging: 'Carton' },
    ],
    remarks: ['Wants delivery to site — checking with transporter'],
    outcome: { kind: 'open', stage: 'Negotiating' },
  },
  {
    day: 165, party: 'krishna', owner: 'office', source: 'walk_in', followUpInDays: 5,
    lines: [
      { code: 'WB-18X12', quantity: 6, packaging: 'Carton' },
      { code: 'DUAL-FLUSH-TANK-CISTERN', quantity: 6, packaging: 'Carton' },
    ],
    outcome: { kind: 'open', stage: 'Quoted' },
  },
  {
    day: 166, party: 'greenvalley', owner: 'admin', source: 'call', priority: 'Low', followUpInDays: 10,
    siteLocation: 'Green Valley Phase 3',
    notes: 'Early enquiry for phase 3 — budget stage.',
    lines: [
      { code: 'EWC-S-TRAP', quantity: 80, packaging: null },
      { code: 'WB-18X12', quantity: 80, packaging: null },
    ],
    outcome: { kind: 'open', stage: 'New' },
  },
  {
    day: 167, party: 'omsai', owner: 'office', source: 'whatsapp', partyWise: true, followUpInDays: 1,
    lines: [{ code: '150', quantity: 5, packaging: 'Thermocol box' }],
    outcome: { kind: 'open', stage: 'New' },
  },
  {
    day: 168, party: 'nakoda', owner: 'management', source: 'referral', priority: 'Medium', followUpInDays: 3,
    lines: [
      { code: '107', quantity: 10, packaging: 'Carton' },
      { code: 'NOVA-WHITE', quantity: 6, packaging: 'Thermocol box' },
    ],
    remarks: ['Asked for a combined quote for both'],
    outcome: { kind: 'open', stage: 'New' },
  },
  {
    day: 169, party: 'anand', owner: 'office', source: 'call', followUpInDays: 7,
    lines: [{ code: 'HEXA-URINAL', quantity: 8, packaging: 'Carton' }],
    outcome: { kind: 'open', stage: 'New' },
  },
];

/**
 * What goes to the Recycle Bin at the end, so that screen is not empty: a
 * party that closed down, one catalogue product the demo never stocks or
 * quotes, and one of the lost leads. Chosen so nothing above depends on them
 * still being live — the party has no leads, the product has no stock and no
 * line, and a lost lead has no order.
 */
export const SAMPLE_DELETIONS = {
  party: 'hariom',
  /** The sample key of the sub product to bin. */
  productCode: 'MERCH-CATALOGUE',
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
