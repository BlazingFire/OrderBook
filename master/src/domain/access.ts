/**
 * The role and user guards (docs/ROLES_AND_USERS.md §7, and the software flow's
 * G1–G8).
 *
 * Pure rules: no database, no transport. Each is named after the guard it
 * implements so a stack trace and the specification use the same vocabulary.
 *
 * G4, the last-administrator check, is split: the *reading* cannot be pure —
 * it has to happen inside the transaction that is changing the rows, under a
 * lock, and that part lives in `access-guard.repository.ts`. The *rule* about
 * what it read is pure and lives here, with the others.
 */

import type { Permission, RoleTier } from '@orderbook/shared';
import { isPermission, keysAboveTier, tierRank } from '@orderbook/shared';

import { ConflictError, ForbiddenError, ValidationError } from '../lib/errors.js';
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
    throw new ValidationError(
      unknown.length > 1 ? 'validation.permissions.unknown.other' : 'validation.permissions.unknown.one',
      { keys: unknown.join(', ') },
    );
  }

  const above = keysAboveTier(permissions, tier);
  if (above.length > 0) {
    throw new ValidationError('validation.permissions.aboveTier', { tier, keys: above.join(', ') });
  }
}

/** G6 — the seeded Administrator role is undeletable and tier-locked. */
export function assertSystemRoleEditable(
  role: { isSystem: boolean; tier: RoleTier; name: string },
  change: { tier?: RoleTier; deleting?: boolean },
): void {
  if (!role.isSystem) return;

  if (change.deleting) {
    throw new ValidationError('validation.role.systemUndeletable', { roleName: role.name });
  }

  if (change.tier && change.tier !== role.tier) {
    throw new ValidationError('validation.role.systemTierLocked', { roleName: role.name });
  }
}

/**
 * The capabilities a company must never lose the ability to exercise.
 *
 * `users.manage` appoints people; `roles.edit` repairs a role. Losing either
 * leaves a company that cannot restore its own administration from inside the
 * product — which is the lockout G4 exists to prevent, reached by editing a role
 * rather than by removing a person.
 */
const IRREVOCABLE_CAPABILITIES = ['users.manage', 'roles.edit'] as const;

export interface AdministrativeCapabilityState {
  adminCount: number;
  permissions: readonly string[];
}

/**
 * G4 — this change must not be what removes the company's last administrator.
 *
 * Deliberately a *preservation* rule, comparing the state before the change with
 * the state after it, both read inside the transaction under the same lock (see
 * `access-guard.repository.ts`). Callers apply their change and then assert, so
 * this reads facts rather than predicting what an edit would do.
 *
 * Asserting the absolute state instead — "there must be an administrator" —
 * looks equivalent and is not. A company with no administrators yet is a normal
 * state: a fresh install before first-run setup is exactly that, and so is every
 * test fixture. Refusing a role edit there blames the operator for a condition
 * their change did not cause, and would have made the seeded roles uneditable on
 * a brand-new installation.
 *
 * The message names the specific way the change would have locked the company
 * out, because "at least one active administrator must remain" is baffling to
 * somebody who was editing a permission grid and never touched a person.
 */
export function assertAdministrativeCapabilityRetained(
  before: AdministrativeCapabilityState,
  after: AdministrativeCapabilityState,
): void {
  // Nothing to preserve. This is not a company being rescued from a bad state —
  // it is one that has not been set up yet.
  if (before.adminCount === 0) return;

  if (after.adminCount === 0) {
    throw new ValidationError('validation.role.lastAdminRequired');
  }

  const lost = IRREVOCABLE_CAPABILITIES.filter(
    (capability) =>
      before.permissions.includes(capability) && !after.permissions.includes(capability),
  );

  if (lost.length > 0) {
    throw new ValidationError('validation.role.irrevocableCapabilityLost', {
      capabilities: lost.map(describeCapability).join(' or '),
    });
  }
}

function describeCapability(capability: string): string {
  return capability === 'users.manage' ? 'manage people' : 'edit roles';
}

/** G5 — a role held by a live user cannot be deleted. Reassign first. */
export function assertRoleUnused(inUse: boolean, roleName: string): void {
  if (inUse) {
    throw new ValidationError('validation.role.stillAssigned', { roleName });
  }
}

/**
 * G7 / G8 — names and usernames are unique per company among live rows.
 *
 * `CONFLICT`, not `VALIDATION_FAILED` (`roles-software-flow.md` §13). The
 * distinction is what lets a client tell "rename or discard" apart from a tier
 * ceiling rejection without reading English — and it is the same code the
 * offline path already returns when two panels create a role with one name.
 */
export function assertNameAvailable(taken: boolean, kind: 'role' | 'user', value: string): void {
  if (!taken) return;

  throw new ConflictError(
    kind === 'role' ? 'error.conflict.nameTaken.role' : 'error.conflict.nameTaken.username',
    { value },
    { field: kind === 'role' ? 'name' : 'username', value },
  );
}

/**
 * Optimistic concurrency. A stale save is refused with the stored version and a
 * field-level diff, so the UI can offer Reload or Overwrite — never
 * auto-overwrite, which loses whatever the other administrator just did without
 * telling anyone.
 *
 * `expectedVersion` is **required**. It used to be optional, and the early
 * return meant any caller could disable the guard by omitting the field — which
 * was not hypothetical: every user mutation in the shipped product omitted it,
 * so role reassignment and activate/deactivate were plain last-write-wins while
 * appearing to be protected.
 */
export function assertVersionMatches(
  stored: number,
  expected: number | undefined,
  diff?: Record<string, { stored: unknown; incoming: unknown }>,
): void {
  if (expected === undefined) {
    throw new ValidationError(
      'validation.expectedVersion.required',
      {},
      { field: 'expectedVersion', storedVersion: stored },
    );
  }

  if (stored !== expected) {
    // 409 rather than 400: the request was well-formed, it just raced.
    throw new ConflictError('error.conflict.staleVersion', {}, {
      storedVersion: stored,
      expectedVersion: expected,
      ...(diff && Object.keys(diff).length > 0 ? { diff } : {}),
    });
  }
}

/** The fields where a stale save and the stored row actually disagree. */
export function fieldDiff(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, { stored: unknown; incoming: unknown }> {
  const diff: Record<string, { stored: unknown; incoming: unknown }> = {};

  for (const [field, value] of Object.entries(incoming)) {
    if (value === undefined) continue;

    const current = stored[field];
    if (JSON.stringify(current) === JSON.stringify(value)) continue;

    diff[field] = { stored: current, incoming: value };
  }

  return diff;
}
