/**
 * Every Recycle Bin invariant that is pure enough to live outside a
 * repository — the upward-only restore graph, the deterministic rename
 * offered on a name collision, and the composite Bin cursor.
 *
 * `PARENT_LINKS` answers "may this row come back" and is a completely
 * different question from the four DELETE routes' per-entity 409 policy
 * (`06-WORKFLOWS.md` §5.2), which answers "may this row be removed at all".
 * The two must never be implemented as one graph — they run in opposite
 * directions over different data.
 */

import type { BinBlocker, RecordId, RecycleBinEntityType } from '@orderbook/shared';
import { isRecycleBinEntityType } from '@orderbook/shared';

import { ConflictError, ValidationError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from './cursor.js';

/**
 * The upward-only graph a restore must not violate: restoring a lead whose
 * party is still in the Bin would produce a row pointing at a tombstone.
 * Upward only — restoring a party does not resurrect every lead ever raised
 * against it, which is a cascade nobody asked for and nobody could undo.
 */
export const PARENT_LINKS: Partial<Record<RecycleBinEntityType, RecycleBinEntityType[]>> = {
  lead: ['party'],
  order: ['party', 'lead'],
  user: ['role'],
};

/** One parent's live/deleted status, already resolved by the caller (a domain function does no I/O). */
export interface ParentStatus {
  entityType: RecycleBinEntityType;
  id: RecordId;
  label: string;
  /** True when the parent is NOT soft-deleted — i.e. safe to restore onto. */
  isLive: boolean;
}

/**
 * Throws `ConflictError` naming every still-deleted parent, or returns
 * quietly when every named parent is live (including when the entity type
 * has no parents at all, in which case `parents` is empty).
 */
export function assertParentsLive(parents: readonly ParentStatus[]): void {
  const blocking = parents.filter((parent) => !parent.isLive);
  if (blocking.length === 0) return;

  const blockedBy: BinBlocker[] = blocking.map((parent) => ({
    entityType: parent.entityType,
    id: parent.id,
    label: parent.label,
    reason: 'parent_deleted',
  }));

  throw new ConflictError('error.conflict.parentDeleted', {}, { blockedBy });
}

/**
 * Deterministic escalation so the UI's offer and the server's acceptance can
 * never disagree: `Sharma Tiles` → `Sharma Tiles (restored)` → `Sharma Tiles
 * (restored 2)` → … `isTaken` does the actual lookup (a database read in
 * production, a plain `Set.has` in the pure test suite) — the escalation
 * *algorithm* itself touches nothing but its own arguments, which is what
 * keeps the sequence testable without a database: the test passes a
 * synchronous-resolving predicate and never awaits a real query.
 */
export async function suggestRestoredName(
  name: string,
  isTaken: (candidate: string) => boolean | Promise<boolean>,
): Promise<string> {
  const first = `${name} (restored)`;
  if (!(await isTaken(first))) return first;

  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${name} (restored ${attempt})`;
    if (!(await isTaken(candidate))) return candidate;
  }

  // Exhausting a thousand escalations means something upstream is
  // pathological (a test double always returning true, say) — surfacing an
  // error is more honest than looping forever.
  throw new Error(`Could not find an available name for "${name}" after 1000 attempts`);
}

/**
 * Narrows a requested type list to the ones the actor may see — the
 * "filter, do not refuse" pattern from `search.service.ts`: an actor with no
 * matching delete key gets an empty page, never a 403.
 */
export function visibleBinScopes(
  requested: readonly RecycleBinEntityType[] | undefined,
  restorePermissionOf: (entityType: RecycleBinEntityType) => string,
  heldPermissions: ReadonlySet<string>,
  allEntities: readonly RecycleBinEntityType[],
): RecycleBinEntityType[] {
  const candidates =
    requested && requested.length > 0 ? requested.filter(isRecycleBinEntityType) : allEntities;

  return candidates.filter((type) => heldPermissions.has(restorePermissionOf(type)));
}

// --- The Bin's composite cursor: (deletedAt, entityType, id) ---------------

export interface BinCursorPayload {
  /** SQL-rendered microsecond text — never re-formatted through a JS Date. */
  deletedAt: string;
  entityType: RecycleBinEntityType;
  id: string;
}

export function encodeBinCursor(payload: BinCursorPayload): string {
  return encodeCursor(payload as unknown as Record<string, unknown>);
}

export function decodeBinCursor(cursor: string): BinCursorPayload {
  const decoded = decodeCursor<Record<string, unknown>>(cursor);

  if (
    typeof decoded.deletedAt !== 'string' ||
    typeof decoded.id !== 'string' ||
    !isRecycleBinEntityType(decoded.entityType)
  ) {
    throw new ValidationError('validation.cursor.malformed', {}, { cursor });
  }

  return { deletedAt: decoded.deletedAt, entityType: decoded.entityType, id: decoded.id };
}
