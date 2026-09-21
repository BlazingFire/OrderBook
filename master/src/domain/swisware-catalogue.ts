/**
 * The Swisware master catalogue (Smruti Ceramics, 2026 edition), written down
 * as the product master's category → model → variant tree.
 *
 * Pure data: no database, no clock. `catalogue-seed.service.ts` replays it
 * through the ordinary catalogue service, so what lands in the database is
 * exactly what an administrator typing it in would have produced.
 *
 * Three rules govern the transcription, and they are the rules the owner's
 * brief laid down rather than choices made here:
 *
 *  · **A model is grouped only where the catalogue names it.** "DAMRU VITROSA"
 *    41…100 are variants of the DAMRU basin because the page says so; the
 *    designer one-piece toilets 1111…1199 are separate single-code products
 *    because no model name appears, and grouping them by how the pictures
 *    look is exactly what §24 of the brief forbids.
 *  · **Codes are the catalogue's codes.** Where the catalogue prints no code
 *    (the plain basins, the sets, the urinals, the pans, the accessories) the
 *    product gets a transparent slug of its name — `HEXA-URINAL`,
 *    `DAMRU-WHITE` — for the administrator to replace with the real one.
 *  · **No weights.** The catalogue carries none, and inventing one from a
 *    picture would put a number on a dispatch note that nobody measured.
 *    Every variant lands with `weightKg: null` and is flagged until entered.
 *
 * Labels: `Vitrosa <code>` for a coded pattern variant, the catalogue's own
 * colour caption for a colour variant (`Vitrosa Magenta`, `Rustic Coffee
 * Brown`), `White` for the plain member of a model, and a numeric suffix when
 * a caption repeats within one model.
 *
 * `multiColour` follows the catalogue's own headings: the water closets, the
 * pedestal sets, the urinals and the pans are printed under "ALL COLOURS
 * AVAILABLE IN ALL ITEMS", so a lead line on them may name a colour; the
 * one-piece and table-top ranges only say "also available in Ivory".
 */

export interface CatalogueVariant {
  code: string;
  /** Null for a product that has no colour or pattern variants. */
  label: string | null;
}

export interface CatalogueModel {
  name: string;
  size?: string;
  /** Overrides the category's rule for one model. */
  multiColour?: boolean;
  variants: readonly CatalogueVariant[];
}

export interface CatalogueCategory {
  name: string;
  /**
   * "ALL COLOURS AVAILABLE IN ALL ITEMS" printed over the section: every
   * model is made in any colour of the colour range, so a lead line may name
   * one. Off where the catalogue only says "also available in Ivory".
   */
  multiColour?: boolean;
  models: readonly CatalogueModel[];
}

export interface CatalogueColour {
  value: string;
  hex: string;
}

/** The colour range page, plus the captions the product pages use. */
export const SWISWARE_COLOURS: readonly CatalogueColour[] = [
  { value: 'White', hex: '#F4F4F0' },
  { value: 'Ivory', hex: '#F5EAC8' },
  { value: 'Light Blue', hex: '#A9D6EA' },
  { value: 'Mint Green', hex: '#BFE3A6' },
  { value: 'Pink', hex: '#F3B6C8' },
  { value: 'Grey', hex: '#B9BDC1' },
  { value: 'Red Brown', hex: '#B5651D' },
  { value: 'Coffee Brown', hex: '#5C2E14' },
  { value: 'Magenta', hex: '#C96B87' },
  { value: 'Alpine Blue', hex: '#6C8EC9' },
  { value: 'Oasis Green', hex: '#1F6B3A' },
  { value: 'Royal Black', hex: '#1E2124' },
  { value: 'Burgundy', hex: '#7A2E3A' },
  { value: 'Pacific Blue', hex: '#26355F' },
  { value: 'Orange', hex: '#E8821A' },
  { value: 'Blood Red', hex: '#D42A1E' },
  { value: 'Black', hex: '#26282B' },
  { value: 'Red', hex: '#C8271C' },
  { value: 'Wooden', hex: '#8B5A2B' },
];

/** `HEXA URINAL` → `HEXA-URINAL`; `E.W.C - S TRAP` → `EWC-S-TRAP`; `20" O.P` → `20-OP`. */
export function catalogueSlug(name: string): string {
  return name
    .toUpperCase()
    .replace(/[."'()]/g, '')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A product the catalogue prints with a code and no variants. */
function coded(code: string, name: string, extra: { size?: string } = {}): CatalogueModel {
  return { name, ...extra, variants: [{ code, label: null }] };
}

/** A product the catalogue prints without a code: the slug is the code until replaced. */
function plain(name: string, extra: { size?: string; codePrefix?: string } = {}): CatalogueModel {
  const { codePrefix, ...rest } = extra;
  const slug = catalogueSlug(name);
  return { name, ...rest, variants: [{ code: codePrefix ? `${codePrefix}-${slug}` : slug, label: null }] };
}

/** `Vitrosa 41` for each printed pattern code. */
function vitrosa(codes: readonly (string | number)[]): CatalogueVariant[] {
  return codes.map((code) => ({ code: String(code), label: `Vitrosa ${code}` }));
}

/** Colour-captioned variants with slug codes; a repeated caption gets a suffix. */
function captioned(model: string, prefix: string, captions: readonly string[]): CatalogueVariant[] {
  const seen = new Map<string, number>();
  return captions.map((caption) => {
    const count = (seen.get(caption) ?? 0) + 1;
    seen.set(caption, count);
    const label = count === 1 ? `${prefix} ${caption}` : `${prefix} ${caption} (${count})`;
    return { code: `${catalogueSlug(model)}-${catalogueSlug(label)}`, label };
  });
}

function white(model: string): CatalogueVariant {
  return { code: `${catalogueSlug(model)}-WHITE`, label: 'White' };
}

/** A named model whose plain white member has no printed code. */
function model(
  name: string,
  variants: readonly CatalogueVariant[],
  extra: { size?: string } = {},
): CatalogueModel {
  return { name, ...extra, variants: [white(name), ...variants] };
}

const ONE_PIECE_TOILET: CatalogueCategory = {
  name: 'ONE PIECE TOILET',
  models: [
    coded('102', '102', { size: '9" · L-27 B-15 H-26' }),
    coded('111', '111', { size: '9" · L-27 B-14 H-25' }),
    coded('103', '103', { size: '9" · L-27 B-14 H-27' }),
    coded('105', '105', { size: '9" · L-26 B-14 H-27' }),
    coded('107', '107', { size: '9" · L-26 B-14 H-30' }),
    coded('108', '108', { size: '9" · L-25 B-14 H-27' }),
    coded('109', '109', { size: '9" · L-26 B-14 H-29' }),
    coded('110', '110', { size: '9" · L-25 B-14 H-27' }),
    coded('112', '112', { size: '9" · L-26 B-14 H-28' }),
    coded('113', '113', { size: '9" · L-25 B-14 H-28' }),
    coded('115', '115', { size: '9" · L-26 B-14 H-29' }),
    coded('116', '116', { size: '9" · L-26 B-14 H-29' }),
    coded('118', '118', { size: '9" · L-26 B-14 H-30' }),
    coded('204', '204', { size: '4" · L-27 B-14 H-27' }),
    coded('SYPHONIC', 'SYPHONIC', { size: '9" · L-26 B-14 H-30' }),
    ...[
      1111, 1113, 1115, 1123, 1127, 1133, 1141, 1143, 1144, 1151, 1152, 1153, 1155, 1156, 1171,
      1181, 1183, 1184, 1185, 1190, 1191, 1192, 1193, 1194, 1195, 1196, 1197, 1198, 1199, 1158,
      1159, 1160, 1161, 1162, 1163, 1164, 1165, 1166, 1167, 1168, 1169,
    ].map((code) => coded(String(code), String(code))),
  ],
};

const ONE_PIECE_BASIN: CatalogueCategory = {
  name: 'ONE PIECE BASIN',
  models: [
    model(
      'DAMRU',
      vitrosa([
        41, 42, 46, 47, 48, 49, 50, 51, 53, 55, 57, 58, 59, 60, 61, 64, 65, 66, 67, 69, 70, 72, 76,
        81, 82, 83, 84, 85, 87, 88, 89, 91, 92, 95, 97, 100,
      ]),
      { size: 'L-16 H-31' },
    ),
    model('NOVA', vitrosa([150, 151, 152, 153, 157, 158, 161]), { size: 'L-15 H-31' }),
    model('DAMRU PLUS', vitrosa([29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]), {
      size: 'L-16 H-32',
    }),
    plain('RUBY', { size: 'L-16 H-33' }),
    model('ROYAL', vitrosa([350, 351, 352, 353, 354]), { size: 'L-16 H-34' }),
    model('RAINBOW', vitrosa([570, 571, 572, 575, 577, 580, 581, 582, 583, 585]), {
      size: 'L-18 B-14 H-31',
    }),
    model('DIAMOND', vitrosa([271, 272, 275, 276, 277, 278, 282, 283, 285]), { size: 'L-18 H-32' }),
    model('VOLVO', vitrosa([330, 331, 332, 334, 335]), { size: 'L-18 H-31' }),
    model('CROWNIE', vitrosa([171, 172, 173, 174, 175, 179, 180]), { size: 'L-16 H-33' }),
    model('SAPPHIRE', vitrosa([367, 369, 371, 372, 373, 376, 378, 379]), {
      size: 'L-16 B-14 H-32',
    }),
    model('EAGLE', vitrosa([381, 382, 384, 385, 386, 387]), { size: 'L-17 B-13 H-32' }),
    model('LAVA', vitrosa([192, 193, 194, 195]), { size: 'L-19 B-15 H-32' }),
    model('SCORPIO', vitrosa([551, 555, 556, 557]), { size: 'L-18 H-32' }),
    {
      name: 'WUDU BASIN',
      variants: [
        { code: 'WUDU-BASIN-WHITE', label: 'White' },
        { code: 'WUDU-BASIN-BLACK', label: 'Black' },
      ],
    },
  ],
};

const WATER_CLOSET: CatalogueCategory = {
  multiColour: true,
  name: 'WATER CLOSET',
  models: [
    plain('E.W.C - ECO CONCEALED'),
    plain('E.W.C - ECO CONCEALED SLIM'),
    plain('E.W.C - MODERN'),
    plain('E.W.C - CONCEALED'),
    plain('E.W.C - S TRAP'),
    plain('E.W.C - P TRAP'),
    plain('ANGLO INDIAN - S TRAP'),
    plain('ANGLO INDIAN - P TRAP'),
    {
      name: 'ECO CONCEALED DESIGNER',
      variants: ['E-01', 'E-02', 'E-03', 'E-06', 'E-07', 'E-08', 'E-09'].map((code) => ({
        code,
        label: `Design ${code}`,
      })),
    },
  ],
};

const UNDER_COUNTER_BASIN: CatalogueCategory = {
  name: 'UNDER COUNTER BASIN',
  models: [
    plain('UNDER COUNTER 18x18', { size: '18x18' }),
    plain('UNDER COUNTER 22x16', { size: '22x16' }),
  ],
};

const LAB_SINK: CatalogueCategory = {
  name: 'LAB SINK',
  models: [
    plain('LAB SINK 24x18x10', { size: '24x18x10' }),
    plain('LAB SINK 20x16x7', { size: '20x16x7' }),
    plain('LAB SINK 18x12x6', { size: '18x12x6' }),
  ],
};

const WASH_BASIN: CatalogueCategory = {
  name: 'WASH BASIN',
  models: [
    plain('12x9', { size: '12x9', codePrefix: 'WB' }),
    plain('13x9 SQUARE', { size: '13x9', codePrefix: 'WB' }),
    plain('14x11 ROUND', { size: '14x11', codePrefix: 'WB' }),
    plain('16x16 CORNER', { size: '16x16', codePrefix: 'WB' }),
    plain('17x11', { size: '17x11', codePrefix: 'WB' }),
    // The one wash basin the catalogue shows in colours: 18x12 in Vitrosa and Rustic.
    {
      name: '18x12',
      size: '18x12',
      variants: [
        { code: 'WB-18X12', label: 'White' },
        ...captioned('WB-18x12', 'Vitrosa', ['Black', 'Mint Green', 'Magenta']),
        ...captioned('WB-18x12', 'Rustic', ['Black', 'Coffee Brown', 'Alpine Blue']),
      ],
    },
    plain('18x12 SQUARE', { size: '18x12', codePrefix: 'WB' }),
    plain('18x13', { size: '18x13', codePrefix: 'WB' }),
    plain('16x12', { size: '16x12', codePrefix: 'WB' }),
    plain('18x14', { size: '18x14', codePrefix: 'WB' }),
    plain('18x14 GOLDEN', { size: '18x14', codePrefix: 'WB' }),
    plain('18x14 POLO', { size: '18x14', codePrefix: 'WB' }),
    plain('18x14 SILVER', { size: '18x14', codePrefix: 'WB' }),
    plain('18x16 MICRA', { size: '18x16', codePrefix: 'WB' }),
    plain('20x16', { size: '20x16', codePrefix: 'WB' }),
    plain('22x16', { size: '22x16', codePrefix: 'WB' }),
  ],
};

const TABLE_TOP_WASH_BASIN: CatalogueCategory = {
  name: 'TABLE TOP WASH BASIN',
  models: [
    coded('7501', '7501', { size: '23x14' }),
    coded('7505', '7505', { size: '17x11' }),
    coded('7507', '7507', { size: '17x13' }),
    coded('7601', '7601', { size: '16x12' }),
    coded('7702', '7702', { size: '20x13' }),
    coded('7704', '7704', { size: '20x16' }),
    coded('7706', '7706', { size: '17x17' }),
    coded('7708', '7708', { size: '19x15' }),
    coded('7801', '7801', { size: '22x17' }),
    coded('7803', '7803', { size: '18x14' }),
    coded('7805', '7805', { size: '18x14' }),
    coded('7807', '7807', { size: '16x16' }),
    coded('7901', '7901', { size: '28x14' }),
    coded('7902', '7902', { size: '23x14' }),
    coded('7903', '7903', { size: '25x15' }),
    plain('14x14 NEW CORNER', { size: '14x14', codePrefix: 'TT' }),
    ...[
      7511, 7512, 7513, 7662, 7663, 7664, 7665, 7667, 7668, 7641, 7643, 7644, 7646, 7647, 7721, 7722,
      7726, 7741, 7742, 7743, 7744, 7745, 7781, 7782, 7783, 7784, 7785, 7786, 7788, 7851, 7852, 7853,
      7854, 7855, 7857, 7858, 7859, 7514, 7516, 7517, 7525, 7760, 7761, 7762, 7767, 7768, 7769, 7840,
      7842, 7843, 7844, 7845, 7847, 7848, 7914, 7915, 7916, 7917, 7918, 7920, 7953, 7941, 7943, 7945,
      7946, 7931, 7933, 7934, 7935,
    ].map((code) => coded(String(code), String(code))),
    {
      name: 'TABLE TOP HYDROGRAPHIC',
      variants: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].map((letter) => ({
        code: `TT-HYDRO-${letter}`,
        label: `Hydrographic ${letter}`,
      })),
    },
  ],
};

/** A pedestal set with its printed size; the colour and pattern pages hang off the same model. */
function set(name: string, size: string, variants: readonly CatalogueVariant[] = []): CatalogueModel {
  return model(name, variants, { size });
}

const PLAIN_SET: CatalogueCategory = {
  multiColour: true,
  name: 'PLAIN SET',
  models: [
    set('GOLDEN SET', '18x14'),
    set('POLO SET', '18x14'),
    set('SILVER SET', '18x14', captioned('SILVER SET', 'Vitrosa', ['Black', 'Magenta', 'Red Brown', 'Mint Green', 'Punch Black', 'Wooden'])),
    set('18x14 SET', '18x14', [
      ...captioned('18x14 SET', 'Vitrosa', ['Red Brown', 'Black']),
      ...captioned('18x14 SET', 'Rustic', ['Black', 'Coffee Brown']),
    ]),
    set('MICRA SET', '18x16', captioned('MICRA SET', 'Vitrosa', ['Magenta', 'Alpine Blue', 'Mint Green', 'Black'])),
    set('20x16 SET', '20x16'),
    set('REPOSE SET', '22x16'),
    set('FABIA SET', '20x17'),
    set('SOFIYA SET', '22x17', [
      ...captioned('SOFIYA SET', 'Vitrosa', ['Magenta', 'Mint Green', 'Alpine Blue', 'Black', 'Red', 'Red Brown', 'Orange', 'Black', 'Magenta']),
      ...captioned('SOFIYA SET', 'Rustic', ['Coffee Brown']),
    ]),
    set('STERLING SET', '22x17'),
    set('AMAZON SET', '22x17', vitrosa([
      5501, 5502, 5503, 5504, 5505, 5506, 5507, 5508, 5509, 5511, 5512, 5513, 5514, 5515, 5516, 5517,
      5518, 5521, 5522, 5523, 5524, 5525, 5526, 5527,
    ])),
    set('SUPREME SET', '23x17'),
    set('SERENA SET', '23x17', [
      ...vitrosa([
        605, 1001, 1016, 1019, 1036, 1037, 1050, 1051, 1052, 1061, 1062, 1063, 1064, 1065, 1066, 1067,
        1068, 2001, 2002, 2003, 2006, 2501, 2502, 2503, 2504, 2505, 2506, 2507, 2508, 2509, 2510, 2511,
        2512, 2513, 2514, 2515, 2516, 2517, 4001, 4002, 4005, 4011, 4012, 4016, 4017, 4018, 4019, 4020,
        4021, 4022, 4031, 4032, 4033, 4034,
      ]),
      ...captioned('SERENA SET', 'Rustic', ['Alpine Blue', 'Coffee Brown', 'Black']),
    ]),
    set('CRETA SET', '23x17'),
    set('CRYSTA SET', '24x18'),
    set('LAURET SET', '24x18', captioned('LAURET SET', 'Vitrosa', ['Magenta', 'Mint Green', 'Red Brown', 'Black', 'Alpine Blue', 'Wooden'])),
    set('LEXO SET', '24x18'),
    set('EURO SET', '24x19', vitrosa([6501, 6502, 6503, 6504, 6505, 6506, 6507, 6508, 6509, 6510, 6511, 6512, 6513, 6514])),
    set('DIAMOND SET', '23x20', captioned('DIAMOND SET', 'Vitrosa', ['Magenta', 'Orange', 'Red', 'Black', 'Alpine Blue'])),
    set('INNOVA SET', '23x18'),
    set('BIG STERLING SET', '25x21', [
      ...vitrosa([
        3001, 3002, 5001, 5002, 5003, 5004, 5005, 5011, 5012, 5014, 6001, 6002, 6003, 6004, 6005, 6006,
        6007, 6008, 6010, 6011, 6012, 6015, 6016,
      ]),
      ...captioned('BIG STERLING SET', 'Vitrosa', ['Wooden']),
      ...captioned('BIG STERLING SET', 'Rustic', ['Magenta', 'Alpine Blue', 'Red Brown']),
    ]),
    set('DOLPHIN SET', '18x20'),
    {
      name: 'SET HYDROGRAPHIC',
      variants: ['B', 'C', 'G', 'H', 'I', 'L'].map((letter) => ({
        code: `SET-HYDRO-${letter}`,
        label: `Hydrographic ${letter}`,
      })),
    },
  ],
};

const URINAL: CatalogueCategory = {
  multiColour: true,
  name: 'URINAL',
  models: [
    plain('HEXA URINAL'),
    plain('HALF STALL URINAL'),
    plain('GENTS WALL URINAL'),
    plain('NANO URINAL'),
    plain('NEW CORNER URINAL'),
    plain('LADIES URINAL'),
    plain('URINAL PARTITION'),
    plain('URINAL CHANNEL'),
    plain('BIG P-TRAP'),
    plain('S-TRAP'),
    plain('P-TRAP'),
  ],
};

const ORISSA_PAN: CatalogueCategory = {
  multiColour: true,
  name: 'ORISSA PAN',
  models: [
    plain('20" O.P', { size: '20"' }),
    plain('20" O.P CROSS', { size: '20"' }),
    plain('M.D PAN'),
    plain('EASTERN PAN'),
    plain('ACUPRESSURE PAN'),
    plain('CITY PAN'),
    plain('21" (Stand) O.P', { size: '21"' }),
    plain('23" O.P', { size: '23"' }),
    plain('23" (Stand) O.P', { size: '23"' }),
  ],
};

const ACCESSORIES: CatalogueCategory = {
  name: 'ACCESSORIES',
  models: [
    plain('EWC SEAT COVER'),
    coded('710', '710 SOFT CLOSE SEAT COVER'),
    coded('735', '735 SOFT CLOSE SEAT COVER'),
    coded('740', '740 SOFT CLOSE SEAT COVER'),
    coded('743', '743 SOFT CLOSE SEAT COVER'),
    coded('784', '784 SOFT CLOSE SEAT COVER'),
    plain('GASKET'),
    plain('SINGLE FLUSH TANK CISTERN'),
    plain('DUAL FLUSH TANK CISTERN'),
    plain('8" FITTING'),
    plain('10" FITTING'),
    plain('WASTE PIPE'),
    plain('WASTE COUPLING'),
    plain('HEALTH FAUCET'),
    plain('SINK OVERFLOW HOLE COVER'),
  ],
};

const MERCHANDISE: CatalogueCategory = {
  name: 'MERCHANDISE',
  models: ['CUP', 'CAP', 'PEN', 'WATCH', 'BAG', 'NOTE PAD', 'CATALOGUE'].map((name) =>
    plain(name, { codePrefix: 'MERCH' }),
  ),
};

/** Every category in catalogue order. */
export const SWISWARE_CATALOGUE: readonly CatalogueCategory[] = [
  ONE_PIECE_TOILET,
  ONE_PIECE_BASIN,
  WATER_CLOSET,
  UNDER_COUNTER_BASIN,
  LAB_SINK,
  WASH_BASIN,
  TABLE_TOP_WASH_BASIN,
  PLAIN_SET,
  URINAL,
  ORISSA_PAN,
  ACCESSORIES,
  MERCHANDISE,
];

/** How many models and variants the catalogue holds — for the seed's report and its tests. */
export function catalogueTotals(): { categories: number; products: number; variants: number } {
  let products = 0;
  let variants = 0;
  for (const category of SWISWARE_CATALOGUE) {
    products += category.models.length;
    for (const entry of category.models) variants += entry.variants.length;
  }
  return { categories: SWISWARE_CATALOGUE.length, products, variants };
}
