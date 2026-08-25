/**
 * The Fields catalogue (`docs/backend-modules/04-API-CONTRACT.md` §5.1) —
 * modelled on `buildPermissionCatalogue()` in `permissions.ts` so the Fields
 * screen renders from a served descriptor rather than a list typed into the
 * renderer, which is the drift the permission-catalogue restructure exists
 * to prevent.
 *
 * Four option-list keys exist once `20260306000000` has run. Only
 * `stock.colour` carries a hex — a source platform, a product type and a
 * packaging kind have no colour to render, so their rows leave `hex` `NULL`
 * permanently and the screen offers no swatch for them. Pipeline stages are
 * a fifth, differently-shaped set (`storage: 'pipeline_stages'`) because
 * they do not share a code path with the four string sets: they are ordered
 * by a deferrable sequence constraint, not a plain `sequence` column, and
 * carry no `option_lists` row at all.
 */

import type { CustomFieldEntity } from './entities.js';
import type { MessageKey } from '../i18n/keys.js';

export const FIELD_LIST_KEYS = [
  'lead.sourcePlatform',
  'stock.colour',
  'product.productType',
  'line.packaging',
] as const;

export type FieldListKey = (typeof FIELD_LIST_KEYS)[number];

export function isFieldListKey(value: unknown): value is FieldListKey {
  return (FIELD_LIST_KEYS as readonly unknown[]).includes(value);
}

export interface FieldSetDefinition {
  listKey: FieldListKey;
  /** `'fieldSet.stock.colour'` — the renderer never hard-codes the English. */
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
    usedBy: ['lead'],
  },
  {
    listKey: 'stock.colour',
    labelToken: 'fieldSet.stock.colour',
    hasHex: true,
    usedBy: ['inventory', 'lineItem', 'stockMovement', 'stockReservation', 'product'],
  },
  {
    listKey: 'product.productType',
    labelToken: 'fieldSet.product.productType',
    hasHex: false,
    usedBy: ['product', 'lineItem', 'partyProductVariant'],
  },
  {
    listKey: 'line.packaging',
    labelToken: 'fieldSet.line.packaging',
    hasHex: false,
    usedBy: ['lineItem', 'partyProductVariant'],
  },
];

export interface FieldCatalogue {
  sets: FieldSetDefinition[];
  customFieldEntities: CustomFieldEntity[];
}

/** Modelled on `buildPermissionCatalogue()` — a served descriptor, not a hard-coded list. */
export function buildFieldCatalogue(): FieldCatalogue {
  return {
    sets: FIELD_SETS.map((set) => ({ ...set })),
    customFieldEntities: ['lead', 'order', 'party', 'product'],
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
