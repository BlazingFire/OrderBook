/**
 * The Fields module's wire vocabulary (`docs/backend-modules/04-API-CONTRACT.md`
 * §5.1) — the served descriptor the Fields screen renders from, so minting a
 * fifth managed set later is a constant edit plus a seeding migration, never a
 * route change.
 */

import { CUSTOM_FIELD_ENTITIES, type CustomFieldEntity } from './entities.js';
import type { MessageKey } from '../i18n/keys.js';

/**
 * The five managed option-list sets. Inlined literals, never referenced from a
 * migration (`03-DATABASE.md` §2: a migration is a fixed historical fact, not
 * a view of today's code).
 */
export const FIELD_LIST_KEYS = [
  'lead.sourcePlatform',
  'stock.colour',
  'product.brand',
  'line.packaging',
  'line.grade',
] as const;

export type FieldListKey = (typeof FIELD_LIST_KEYS)[number];

export function isFieldListKey(value: unknown): value is FieldListKey {
  return (FIELD_LIST_KEYS as readonly unknown[]).includes(value);
}

export interface FieldSetDefinition {
  listKey: FieldListKey;
  labelToken: MessageKey;
  /** True for `'stock.colour'` only — the others have no colour to render. */
  hasHex: boolean;
  /** Tables that reference this set, as tokens the client labels. */
  usedBy: string[];
}

const FIELD_SETS: readonly FieldSetDefinition[] = [
  {
    listKey: 'lead.sourcePlatform',
    labelToken: 'fieldSet.lead.sourcePlatform',
    hasHex: false,
    usedBy: ['leads'],
  },
  // The company's colour list: what the product form suggests for a variant's
  // colour text, where the swatch beside it takes its hex from, and the list a
  // lead line picks from on a multi-colour product.
  {
    listKey: 'stock.colour',
    labelToken: 'fieldSet.stock.colour',
    hasHex: true,
    usedBy: ['products', 'leads', 'orders'],
  },
  /*
   * The brands a category (the owner's Product) is sold under
   * (`docs/catalogue/CATALOGUE_MODEL.md` §1). An option list rather than a
   * table because a brand needs nothing a list does not already carry — add,
   * relabel, remove to the Recycle Bin, the activity log and sync. The value
   * is the brand name and is what `product_categories.brand` holds.
   *
   * The key is reused: the 2026-09-21 trim deleted a `product.brand` list of
   * the same name along with the old `products.brand` column. Brand now lives
   * on the category, and the catalogue loader fills the list.
   */
  {
    listKey: 'product.brand',
    labelToken: 'fieldSet.product.brand',
    hasHex: false,
    usedBy: ['products'],
  },
  {
    listKey: 'line.packaging',
    labelToken: 'fieldSet.line.packaging',
    hasHex: false,
    usedBy: ['leads', 'orders'],
  },
  /*
   * The grades a line may be sold as. Restored on 2026-09-22 after the product
   * trim removed it the day before: the owner asked for Grade back as a
   * *pick* on the lead's product card, which means the values have to be
   * somewhere a person can maintain them, and this screen is that somewhere.
   *
   * It ships with nothing in it, like `line.packaging` — the grades a
   * particular company sells by are not ours to guess.
   */
  {
    listKey: 'line.grade',
    labelToken: 'fieldSet.line.grade',
    hasHex: false,
    usedBy: ['leads', 'orders'],
  },
] as const;

export interface FieldCatalogue {
  sets: FieldSetDefinition[];
  customFieldEntities: CustomFieldEntity[];
}

/** Modelled on `buildPermissionCatalogue()` — one response the renderer caches for the session. */
export function buildFieldCatalogue(): FieldCatalogue {
  return {
    sets: FIELD_SETS.map((set) => ({ ...set })),
    customFieldEntities: [...CUSTOM_FIELD_ENTITIES],
  };
}

export interface FieldUsage {
  value: string;
  total: number;
  bySource: Record<string, number>;
}

export interface FieldUsageBreakdown {
  listKey: FieldListKey;
  sources: string[];
  values: FieldUsage[];
  /** Values seen in the data with no `option_lists` row yet. */
  unlisted: FieldUsage[];
}
