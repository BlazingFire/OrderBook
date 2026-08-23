/**
 * The role and user guards (docs/ROLES_AND_USERS.md §7, and the software flow's
 * G1–G8).
 *
 * Pure rules: no database, no transport. Each is named after the guard it
 * implements so a stack trace and the specification use the same vocabulary.
 *
 * The one guard that is *not* here is G4 (the last-administrator check), because
 * it cannot be pure — it has to count rows inside the very transaction that is
 * changing them. Running it outside means two concurrent deactivations each see
 * one remaining admin and both succeed, locking the company out of its own
 * software. It lives in `user.service.ts`, inside the transaction, and this
 * comment exists so nobody moves it here for symmetry.
 */

import type { Permission, RoleTier } from '@orderbook/shared';
import { isPermission, keysAboveTier, tierRank } from '@orderbook/shared';

import { ForbiddenError, ValidationError } from '../lib/errors.js';
import type { ActorContext } from './actor.js';

/** G1 — only an administrator may create or restructure roles. */
export function assertAdminTier(actor: ActorContext, permission: Permission): void {
  if (actor.permissions?.tier !== 'admin') throw new ForbiddenError(permission);
}

/**
 * G3 — you cannot mint a role, or a user, above your own tier.
 *
 * Without this an administrator's own ceiling is decorative: a management user
 * who could create an admin-tier role could grant themselves anything.
 */
export function assertTierWithinActor(actor: ActorContext, target: RoleTier): void {
  const actorTier = actor.permissions?.tier;
  if (!actorTier || tierRank(target) > tierRank(actorTier)) {
    throw new ForbiddenError('roles.create');
  }
}

/**
 * G2 — every key must be permitted for the role's tier, and must exist.
 *
 * Rejects the **whole save** rather than quietly dropping the offending keys.
 * Silently dropping means an administrator ticks four boxes, saves, and is shown
 * a role holding two of them with no explanation.
 */
export function assertPermissionsWithinTier(
  permissions: readonly string[],
  tier: RoleTier,
): asserts permissions is Permission[] {
  const unknown = permissions.filter((permission) => !isPermission(permission));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown permission${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }

  const above = keysAboveTier(permissions, tier);
  if (above.length > 0) {
    throw new ValidationError(
      `The ${tier} tier cannot hold: ${above.join(', ')}. Raise the tier or remove them.`,
    );
  }
}

/** G6 — the seeded Administrator role is undeletable and tier-locked. */
export function assertSystemRoleEditable(
  role: { isSystem: boolean; tier: RoleTier; name: string },
  change: { tier?: RoleTier; deleting?: boolean },
): void {
  if (!role.isSystem) return;

  if (change.deleting) {
    throw new ValidationError(`"${role.name}" is a system role and cannot be deleted`);
  }

  if (change.tier && change.tier !== role.tier) {
    throw new ValidationError(`"${role.name}" is a system role and its tier cannot be changed`);
  }
}

/** G5 — a role held by a live user cannot be deleted. Reassign first. */
export function assertRoleUnused(inUse: boolean, roleName: string): void {
  if (inUse) {
    throw new ValidationError(
      `"${roleName}" is still assigned to at least one person. Move them to another role first.`,
    );
  }
}

/** G7 / G8 — names and usernames are unique per company among live rows. */
export function assertNameAvailable(taken: boolean, kind: 'role' | 'user', value: string): void {
  if (!taken) return;

  throw new ValidationError(
    kind === 'role'
      ? `A role named "${value}" already exists`
      : `The username "${value}" is already taken`,
  );
}

/**
 * Optimistic concurrency. A stale save is refused with the stored version so the
 * UI can offer Reload or Overwrite — never auto-overwrite, which loses whatever
 * the other administrator just did without telling anyone.
 */
export function assertVersionMatches(stored: number, expected: number | undefined): void {
  if (expected === undefined) return;

  if (stored !== expected) {
    const error = new ValidationError(
      'Somebody else saved this first. Reload to see their changes.',
    );
    // Surfaces as a 409 rather than a 400: the request was well-formed, it just
    // raced. The UI branches on the code, never on the message.
    Object.assign(error, { statusCode: 409, code: 'conflict', storedVersion: stored });
    throw error;
  }
}
