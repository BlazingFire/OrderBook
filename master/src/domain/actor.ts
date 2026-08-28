/**
 * Who performed an action, which tenant they acted in, and what they were
 * allowed to do. Every mutating service call carries one, and the activity log
 * records it, so "who did this?" is always answerable.
 *
 * The tenant lives here rather than in each call's arguments deliberately: it
 * comes from the authenticated session, never from a request body, so there is
 * no signature a caller could use to name someone else's tenant.
 */

import type { Permission, PermissionSet } from '@orderbook/shared';
import { hasPermission } from '@orderbook/shared';

import { ForbiddenError } from '../lib/errors.js';

export interface ActorContext {
  tenantId: string;
  actorType: 'user' | 'office_panel' | 'system' | 'api_key' | 'connector';
  actorId: string | null;
  /** The signed-in user, even when the action arrived over a panel's socket. */
  userId: string | null;
  permissions: PermissionSet | null;
  /** Set for panel actors; stamped into HLC timestamps and temporary ids. */
  deviceCode: string | null;
  /**
   * A human name for the audit trail — never a translated value, never a
   * localised label, an identifier like a record id or a device code. `null`
   * when nobody is signed in (a panel acting as itself) or for the system
   * actor. Read by `recordActivity` (`activity-log.repository.ts`); persisted
   * into `activity_log.actor_name` from Stage 4 onward, and harmless before
   * that column exists.
   */
  actorName: string | null;
}

/**
 * The user id to stamp on rows that track authorship. A panel acting with no
 * signed-in user carries none — better an honest null than a borrowed id.
 */
export function actorUserId(actor: ActorContext): string | null {
  return actor.userId ?? (actor.actorType === 'user' ? actor.actorId : null);
}

export function actorCan(actor: ActorContext, permission: Permission): boolean {
  return hasPermission(actor.permissions, permission);
}

/**
 * Enforce a permission, naming the missing one in the error.
 *
 * Naming it is the point: the guide asks for "a 403 naming the missing
 * permission, not a hidden button", so an operator can tell the difference
 * between a broken screen and one they lack access to.
 */
export function requirePermission(actor: ActorContext, permission: Permission): void {
  if (!actorCan(actor, permission)) throw new ForbiddenError(permission);
}

/** A system actor for migrations, seeding, and internal maintenance. */
export function systemActor(tenantId: string): ActorContext {
  return {
    tenantId,
    actorType: 'system',
    actorId: null,
    userId: null,
    permissions: null,
    deviceCode: null,
    actorName: 'System',
  };
}
