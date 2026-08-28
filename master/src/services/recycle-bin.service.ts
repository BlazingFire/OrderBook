/**
 * The Recycle Bin: list, counts, and restore. Owns no table of its own — a
 * restore delegates to the entity's own service (`catalogService.restoreParty`,
 * `roleService.restoreRole`, …), each of which already knows how to check a
 * collision, run its transaction and record its own activity entry. This
 * service's job is `recycleBin.view`, the three-layer visibility narrowing,
 * and turning one restore call into the uniform `BinRestoreResult` every
 * entity type answers with.
 */

import type {
  BinCounts,
  BinEntry,
  BinRestoreResult,
  CursorPage,
  RecycleBinQuery,
  RestoreInput,
} from '@orderbook/shared';
import { hasPermission, RECYCLE_BIN_ENTITIES, RESTORE_PERMISSION } from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { clampCursorLimit } from '../domain/cursor.js';
import { decodeBinCursor, encodeBinCursor, visibleBinScopes } from '../domain/recycle-bin.js';
import { ValidationError } from '../lib/errors.js';
import * as recycleBinRepo from '../repositories/recycle-bin.repository.js';
import * as catalogService from './catalog.service.js';
import * as documentService from './document.service.js';
import * as fieldsService from './fields.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';
import * as roleService from './role.service.js';
import * as userService from './user.service.js';

/**
 * Everybody who has deleted something still in the Bin, for the filter.
 *
 * A facet computed over the whole Bin rather than over the page in front of
 * you. The screen used to build these options from the pages it had already
 * fetched, so the filter could only offer people whose deletions you had
 * already scrolled past.
 *
 * Not a pick kind: `listUsers` requires `users.manage` while this filter is
 * gated on `recycleBin.viewAll`, so routing it through a picker would 403
 * exactly the people who have a working filter today.
 */
export async function binDeleters(
  actor: ActorContext,
): Promise<Array<{ id: string; name: string }>> {
  requirePermission(actor, 'recycleBin.view');

  // Somebody who can only see their own deletions needs no filter over other
  // people, and must not be told who those people are.
  if (!actorCan(actor, 'recycleBin.viewAll')) return [];

  const held = new Set(actor.permissions?.permissions ?? []);
  const visible = visibleBinScopes(
    undefined,
    (type) => RESTORE_PERMISSION[type],
    held,
    RECYCLE_BIN_ENTITIES,
  );

  const ids = await recycleBinRepo.distinctDeleters(actor.tenantId, {
    types: visible,
    scope: resolvePartyScope(actor),
  });

  const names = await recycleBinRepo.deletedByNames(actor.tenantId, ids);

  return ids
    .map((id) => ({ id, name: names.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listBin(
  query: RecycleBinQuery,
  actor: ActorContext,
): Promise<CursorPage<BinEntry>> {
  requirePermission(actor, 'recycleBin.view');

  const held = new Set(actor.permissions?.permissions ?? []);
  const visible = visibleBinScopes(
    query.types,
    (type) => RESTORE_PERMISSION[type],
    held,
    RECYCLE_BIN_ENTITIES,
  );

  const scopedTo = scopeToOwnDeletions(actor, query.deletedBy);
  if (scopedTo === 'nobody' || visible.length === 0) {
    return { items: [], nextCursor: null, prevCursor: null, limit: clampCursorLimit(query.limit) };
  }

  const limit = clampCursorLimit(query.limit);
  const after = query.cursor ? decodeBinCursor(query.cursor) : undefined;

  const { entries, hasMore } = await recycleBinRepo.listBinEntries(actor.tenantId, {
    types: visible,
    search: query.search,
    deletedBy: scopedTo === 'anyone' ? undefined : scopedTo,
    after,
    limit,
    // The Bin already scopes to the caller's own deletions unless they hold
    // `recycleBin.viewAll`; this narrows the lead/order/party branches again by
    // party, so a `viewAll` holder still cannot read back somebody else's book
    // through the one screen that lists deleted records from every table.
    scope: resolvePartyScope(actor),
  });

  const names = await recycleBinRepo.deletedByNames(
    actor.tenantId,
    entries.map((entry) => entry.deletedBy).filter((id): id is string => id !== null),
  );

  const items: BinEntry[] = entries.map((entry) => ({
    entityType: entry.entityType,
    id: entry.id,
    label: entry.label,
    sublabel: entry.sublabel,
    deletedAt: entry.deletedAt,
    deletedBy: entry.deletedBy,
    deletedByName: entry.deletedBy ? (names.get(entry.deletedBy) ?? null) : null,
    version: entry.version,
    cursor: encodeBinCursor({
      deletedAt: entry.deletedAtCursorText,
      entityType: entry.entityType,
      id: entry.id,
    }),
  }));

  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.cursor ?? null) : null,
    // One-directional feed — the Bin never offers a way back to newer.
    prevCursor: null,
    limit,
  };
}

export async function binCounts(actor: ActorContext): Promise<BinCounts> {
  requirePermission(actor, 'recycleBin.view');

  const held = new Set(actor.permissions?.permissions ?? []);
  const visible = visibleBinScopes(undefined, (type) => RESTORE_PERMISSION[type], held, RECYCLE_BIN_ENTITIES);

  const scopedTo = scopeToOwnDeletions(actor, undefined);
  if (scopedTo === 'nobody' || visible.length === 0) return {};

  return recycleBinRepo.binCounts(
    actor.tenantId,
    visible,
    scopedTo === 'anyone' ? undefined : scopedTo,
    resolvePartyScope(actor),
  );
}

/**
 * `'anyone'` when the actor holds `recycleBin.viewAll` (no scoping at all, or
 * scoped to the caller's own `deletedBy` filter); a user id when narrowed to
 * one person's own deletions; `'nobody'` when the actor has no `userId` at
 * all and does not hold `viewAll` — an unattended panel cannot even see its
 * own null-attributed deletions, because nothing proves they were its.
 */
function scopeToOwnDeletions(actor: ActorContext, requested: string | undefined): string | 'anyone' | 'nobody' {
  if (hasPermission(actor.permissions, 'recycleBin.viewAll')) return requested ?? 'anyone';
  return actor.userId ?? 'nobody';
}

export async function restoreEntity(input: RestoreInput, actor: ActorContext): Promise<BinRestoreResult> {
  switch (input.entityType) {
    case 'party': {
      return catalogService.restoreParty(input.id, actor, input.renameTo);
    }
    case 'product': {
      return catalogService.restoreProduct(input.id, actor, input.renameTo);
    }
    case 'lead': {
      return leadService.restoreLead(input.id, actor);
    }
    case 'order': {
      return orderService.restoreOrder(input.id, actor);
    }
    case 'role': {
      const role = await roleService.restoreRole(input.id, actor, input.renameTo);
      return { entityType: 'role', id: role.id, renamedTo: input.renameTo, alsoRestored: [] };
    }
    case 'user': {
      const user = await userService.restoreUser(input.id, actor, input.renameTo);
      return { entityType: 'user', id: user.id, renamedTo: input.renameTo, alsoRestored: [] };
    }
    case 'option_list_item': {
      const item = await fieldsService.restoreValue(input.id, actor);
      return { entityType: 'option_list_item', id: item.id, alsoRestored: [] };
    }
    case 'custom_field_definition': {
      const definition = await fieldsService.restoreDefinition(input.id, actor);
      return { entityType: 'custom_field_definition', id: definition.id, alsoRestored: [] };
    }
    case 'document_template': {
      const template = await documentService.restoreTemplate(input.id, actor);
      return { entityType: 'document_template', id: template.id, alsoRestored: [] };
    }
    default: {
      // Unreachable if the route validated `entityType` first
      // (`isRecycleBinEntityType`, checked in `recycle-bin.routes.ts`) —
      // kept as a last-resort refusal rather than an assertion, since a
      // socket command reaches this function with no route in front of it.
      throw new ValidationError('validation.recycleBin.unknownEntityType', {}, {
        field: 'entityType',
        allowed: RECYCLE_BIN_ENTITIES,
      });
    }
  }
}
