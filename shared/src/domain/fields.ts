/**
 * The Fields module's wire vocabulary (`docs/backend-modules/04-API-CONTRACT.md`
 * §5.1) — the served descriptor the Fields screen renders from, so minting a
 * fifth managed set later is a constant edit plus a seeding migration, never a
 * route change.
 */

import { CUSTOM_FIELD_ENTITIES, type CustomFieldEntity } from './entities.js';
import type { MessageKey } from '../i18n/keys.js';

/**
 * The four managed option-list sets. Inlined literals, never referenced from a
 * migration (`03-DATABASE.md` §2: a migration is a fixed historical fact, not
 * a view of today's code).
 */
export const FIELD_LIST_KEYS = [
  'lead.sourcePlatform',
  'stock.colour',
  'product.productType',
  'product.brand',
  'product.shade',
  'product.surfaceTexture',
  'product.originPlant',
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
  /** True for `'stock.colour'` only — the other three have no colour to render. */
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
  // The variant palette: what the product form suggests for a variant's
  // colour text, and where the swatch beside it takes its hex from.
  {
    listKey: 'stock.colour',
    labelToken: 'fieldSet.stock.colour',
    hasHex: true,
    usedBy: ['products', 'leads', 'orders'],
  },
  {
    listKey: 'product.productType',
    labelToken: 'fieldSet.product.productType',
    hasHex: false,
    usedBy: ['products'],
  },
  // The four ceramic vocabularies. Lists rather than columns with a CHECK,
  // because these are sets staff extend — a new brand or a new surface arrives
  // with a new supplier, and that must not need a migration. Deliberately not
  // seeded: `unlisted` already surfaces the values present in the data, so the
  // company's own catalogue fills the list the first time somebody looks.
  {
    listKey: 'product.brand',
    labelToken: 'fieldSet.product.brand',
    hasHex: false,
    usedBy: ['products'],
  },
  {
    listKey: 'product.shade',
    labelToken: 'fieldSet.product.shade',
    hasHex: false,
    usedBy: ['products'],
  },
  {
    listKey: 'product.surfaceTexture',
    labelToken: 'fieldSet.product.surfaceTexture',
    hasHex: false,
    usedBy: ['products'],
  },
  {
    listKey: 'product.originPlant',
    labelToken: 'fieldSet.product.originPlant',
    hasHex: false,
    usedBy: ['products'],
  },
  {
    listKey: 'line.packaging',
    labelToken: 'fieldSet.line.packaging',
    hasHex: false,
    usedBy: ['leads', 'orders'],
  },
  // Also unseeded, and for the same reason as packaging: a grade is a word the
  // company already uses on its own dockets. The new-lead card offers this list
  // when it has rows and falls back to free text when it does not, so a shop
  // that has never filled it in can still type one.
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
