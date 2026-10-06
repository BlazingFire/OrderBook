/**
 * The Recycle Bin's wire vocabulary — shared because both panels render it
 * and the Master filters by it (`docs/backend-modules/04-API-CONTRACT.md` §4.1).
 *
 * `RECYCLE_BIN_ENTITIES` grows across build stages rather than shipping
 * frozen: six here (Stage 2 — the six tables `20260305` gives `deleted_at`),
 * two more at Stage 3 (Fields). Each addition is one tuple entry, one
 * `RESTORE_PERMISSION` entry, one `UNION ALL` arm in the repository, and a
 * normal `shared` rebuild — never a route change. (`document_template` was the
 * ninth until the PDF Designer was removed; `20260322` dropped its table.)
 */

import type { RecordId, IsoTimestamp } from './entities.js';

export const RECYCLE_BIN_ENTITIES = [
  // Stage 2 — Recycle Bin ships with these six, the tables 20260305 gives `deleted_at`.
  'lead',
  'order',
  'party',
  'product',
  'role',
  'user',
  // Stage 3 — Fields appends these two, the tables 20260306 gives `deleted_at`.
  // `custom_field_definition`, not `custom_field` — the latter is a distinct
  // `ChangedEntity` member with a different job; confusing the two produces a
  // Bin branch that restores nothing.
  'option_list_item',
  'custom_field_definition',
  // Catalogue v2 (`20260326`) gives categories — the owner's Products — a
  // `deleted_at`: deleting one is refused while it holds a live sub product,
  // and it comes back from here.
  'product_category',
  // The notice board (Oct 2026): a removed notice comes back from here.
  'notice',
] as const;

export type RecycleBinEntityType = (typeof RECYCLE_BIN_ENTITIES)[number];

export function isRecycleBinEntityType(value: unknown): value is RecycleBinEntityType {
  return (RECYCLE_BIN_ENTITIES as readonly unknown[]).includes(value);
}

/**
 * Restore reuses the entity's own DELETE key — no `recycleBin.restore` key is
 * minted, so the Bin can never be a back door onto an entity a caller may not
 * delete.
 */
export const RESTORE_PERMISSION: Record<RecycleBinEntityType, string> = {
  lead: 'leads.delete',
  order: 'orders.delete',
  party: 'parties.delete',
  product: 'products.delete',
  role: 'roles.delete',
  user: 'users.manage',
  option_list_item: 'fields.manage',
  custom_field_definition: 'fields.manage',
  product_category: 'products.delete',
  notice: 'notices.manage',
};

/**
 * 1.4 D3: a second key that also opens a type's restore. A brand, packaging type
 * or grade value is restored with `catalog.lists.manage` as well as `fields.manage`;
 * the Bin then offers such a person those three lists' values and no other option.
 */
export const ALSO_RESTORES_WITH: Partial<Record<RecycleBinEntityType, string>> = {
  option_list_item: 'catalog.lists.manage',
};

/** Whether `has` (a permission test) opens the Bin's restore for this type. */
export function canRestoreBinType(
  type: RecycleBinEntityType,
  has: (permission: string) => boolean,
): boolean {
  const also = ALSO_RESTORES_WITH[type];
  return has(RESTORE_PERMISSION[type]) || (also !== undefined && has(also));
}

export interface BinEntry {
  entityType: RecycleBinEntityType;
  id: RecordId;
  label: string;
  sublabel: string | null;
  deletedAt: IsoTimestamp;
  /** A US… user id, or null for an unattended panel's deletion. */
  deletedBy: RecordId | null;
  deletedByName: string | null;
  /** null for an entity type that carries no version column. */
  version: number | null;
  cursor: string;
}

/**
 * One record standing in the way. Used by BOTH 409 paths, which are
 * different questions in opposite directions: `parent_deleted` blocks a
 * RESTORE (the upward-only `PARENT_LINKS` graph); the rest block a DELETE
 * (the per-entity policy table in `04-API-CONTRACT.md` §4.5).
 */
export interface BinBlocker {
  /** Not every blocker is a Bin entity — a line item can block a delete without ever being restorable itself. */
  entityType: RecycleBinEntityType | 'line_item';
  id: RecordId;
  label: string;
  reason: 'parent_deleted' | 'live_reference' | 'converted' | 'dispatched';
}

export interface BinRestoreResult {
  entityType: RecycleBinEntityType;
  id: RecordId;
  renamedTo?: string;
  alsoRestored: BinEntry[];
}

/** Absent key, not zero, for a branch the caller may not see — never a confident 0. */
export type BinCounts = Partial<Record<RecycleBinEntityType, number>>;
