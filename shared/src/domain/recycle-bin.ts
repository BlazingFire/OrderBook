/**
 * The Recycle Bin's wire vocabulary — shared because both panels render it
 * and the Master filters by it (`docs/backend-modules/04-API-CONTRACT.md` §4.1).
 *
 * `RECYCLE_BIN_ENTITIES` grows across build stages rather than shipping
 * frozen at nine: six here (Stage 2 — the six tables `20260305` gives
 * `deleted_at`), two more at Stage 3 (Fields), one more at Stage 6 (PDF
 * Designer). Each addition is one tuple entry, one `RESTORE_PERMISSION`
 * entry, one `UNION ALL` arm in the repository, and a normal `shared`
 * rebuild — never a route change.
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
  // Stage 6 (PDF Designer) — the ninth and last. `document_export` is
  // deliberately NOT a tenth: a document that was sent to a customer is a
  // record of what was sent, not something to put back in a bin.
  'document_template',
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
  document_template: 'documents.delete',
};

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
  /** Not every blocker is a Bin entity — a line item or a stock row can block a delete without ever being restorable itself. */
  entityType: RecycleBinEntityType | 'line_item' | 'inventory_stock';
  id: RecordId;
  label: string;
  reason: 'parent_deleted' | 'live_reference' | 'stock_on_hand' | 'converted' | 'dispatched';
}

export interface BinRestoreResult {
  entityType: RecycleBinEntityType;
  id: RecordId;
  renamedTo?: string;
  alsoRestored: BinEntry[];
}

/** Absent key, not zero, for a branch the caller may not see — never a confident 0. */
export type BinCounts = Partial<Record<RecycleBinEntityType, number>>;
