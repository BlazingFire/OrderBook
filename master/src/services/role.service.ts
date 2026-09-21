/**
 * Roles (docs/ROLES_AND_USERS.md §5–§8).
 *
 * Every write is one transaction: the row, its version bump, and the audit
 * entry. If the audit append fails the change rolls back with it, so the
 * projection and the trail can never disagree about what happened.
 */

import type { PermissionCatalogue, Role, RoleInput, RoleTier } from '@orderbook/shared';
import { buildPermissionCatalogue, isRoleTier, keysAboveTier } from '@orderbook/shared';

import {
  fieldDiff,
  assertAdministrativeCapabilityRetained,
  assertAdminTier,
  assertNameAvailable,
  assertPermissionsWithinTier,
  assertRoleUnused,
  assertSystemRoleEditable,
  assertTierWithinActor,
  assertVersionMatches,
} from '../domain/access.js';
import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { suggestRestoredName } from '../domain/recycle-bin.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as accessGuard from '../repositories/access-guard.repository.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as roleRepo from '../repositories/role.repository.js';
import { publishChange } from './change-bus.js';

/** Fields the offline merge can arbitrate over, in wire-format names. */
const ROLE_FIELDS = ['name', 'tier', 'permissions'] as const;

/** The catalogue the grid renders from. */
export async function permissionCatalogue(): Promise<PermissionCatalogue> {
  return buildPermissionCatalogue();
}

export async function listRoles(actor: ActorContext): Promise<Role[]> {
  requirePermission(actor, 'roles.view');
  return roleRepo.listRoles(actor.tenantId);
}

export async function listDeletedRoles(actor: ActorContext): Promise<Role[]> {
  requirePermission(actor, 'roles.view');
  return roleRepo.listDeletedRoles(actor.tenantId);
}

export async function getRole(id: string, actor: ActorContext): Promise<Role> {
  requirePermission(actor, 'roles.view');

  const role = await roleRepo.findRoleById(actor.tenantId, id);
  if (!role) throw new NotFoundError('Role');
  return role;
}

export async function createRole(input: RoleInput, actor: ActorContext): Promise<Role> {
  requirePermission(actor, 'roles.create');
  assertAdminTier(actor, 'roles.create');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.role.nameRequired');

  const tier = assertTier(input.tier);
  assertTierWithinActor(actor, tier);
  assertPermissionsWithinTier(input.permissions ?? [], tier);
  assertNameAvailable(
    await roleRepo.isNameTaken(actor.tenantId, name, null),
    'role',
    name,
  );

  const id = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    const roleId = await roleRepo.insertRole(
      {
        tenantId: actor.tenantId,
        name,
        tier,
        permissions: [...(input.permissions ?? [])].sort(),
        createdBy: actorUserId(actor),
        hlc,
        fieldHlc: Object.fromEntries(ROLE_FIELDS.map((field) => [field, hlc])),
      },
      trx,
    );

    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'role',
      entityId: roleId,
      action: 'created',
      actorType: actor.actorType,
      actorId: actor.actorId,
      // The whole array, not a count: an auditor asks "what could this role do
      // on 14 March", and a chain of diffs makes that a replay, not a lookup.
      details: { name, tier, permissions: [...(input.permissions ?? [])].sort() },
    }, actor, trx);

    return roleId;
  });

  const role = await roleRepo.findRoleById(actor.tenantId, id);
  if (!role) throw new Error('Role disappeared immediately after insert');

  publishChange({ entity: 'role', action: 'created', id: role.id, payload: role });
  return role;
}

export async function updateRole(
  id: string,
  input: RoleInput,
  actor: ActorContext,
): Promise<Role> {
  requirePermission(actor, 'roles.edit');
  assertAdminTier(actor, 'roles.edit');

  const existing = await roleRepo.findRoleById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Role');

  // The diff is computed before the check so a stale save can be told *what*
  // differs, which is the whole point of offering Reload versus Overwrite —
  // "somebody else saved first" with no detail leaves Cancel as the only exit.
  assertVersionMatches(
    existing.sync.version,
    input.expectedVersion,
    fieldDiff(
      { name: existing.name, tier: existing.tier, permissions: [...existing.permissions].sort() },
      {
        name: input.name?.trim(),
        tier: input.tier,
        permissions: [...(input.permissions ?? [])].sort(),
      },
    ),
  );

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.role.nameRequired');

  const tier = assertTier(input.tier);
  assertSystemRoleEditable(existing, { tier });
  assertTierWithinActor(actor, tier);

  // Re-derived here rather than trusted from the client: the UI previews which
  // keys a tier drop removes, but the service must not take its arithmetic.
  const droppedByTier = keysAboveTier(existing.permissions, tier);
  assertPermissionsWithinTier(input.permissions ?? [], tier);
  assertNameAvailable(await roleRepo.isNameTaken(actor.tenantId, name, id), 'role', name);

  const permissions = [...(input.permissions ?? [])].sort();

  await db().transaction(async (trx) => {
    // G4. Taken before anything is read or written, because two administrators
    // editing two different admin-tier roles touch disjoint rows and would
    // otherwise never see each other.
    await accessGuard.lockTenantAccessGuards(actor.tenantId, trx);
    const adminsBefore = await accessGuard.readAdministrativeCapability(actor.tenantId, trx);

    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc };
    for (const field of ROLE_FIELDS) fieldHlc[field] = hlc;

    await roleRepo.updateRoleColumns(
      actor.tenantId,
      id,
      { name, tier, permissions: JSON.stringify(permissions), updated_by: actorUserId(actor) },
      { hlc, fieldHlc },
      trx,
    );

    // Applied first, asserted second: this edit can remove the company's last
    // administrator without touching a single user row — by dropping the role's
    // tier, or by stripping `users.manage` from the only role that had it.
    // Throwing here rolls the edit back.
    assertAdministrativeCapabilityRetained(
      adminsBefore,
      await accessGuard.readAdministrativeCapability(actor.tenantId, trx),
    );

    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'role',
      entityId: id,
      action: 'updated',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: {
        name: { from: existing.name, to: name },
        tier: { from: existing.tier, to: tier },
        permissions: { from: existing.permissions, to: permissions },
        ...(droppedByTier.length > 0 ? { droppedByTierCeiling: droppedByTier } : {}),
      },
    }, actor, trx);
  });

  const role = await roleRepo.findRoleById(actor.tenantId, id);
  if (!role) throw new NotFoundError('Role');

  publishChange({ entity: 'role', action: 'updated', id, payload: role });
  return role;
}

export async function deleteRole(id: string, actor: ActorContext): Promise<Role> {
  requirePermission(actor, 'roles.delete');
  assertAdminTier(actor, 'roles.delete');

  const existing = await roleRepo.findRoleById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Role');

  assertSystemRoleEditable(existing, { deleting: true });

  await db().transaction(async (trx) => {
    await accessGuard.lockTenantAccessGuards(actor.tenantId, trx);
    const adminsBefore = await accessGuard.readAdministrativeCapability(actor.tenantId, trx);

    // G5, inside the transaction and under the lock. Evaluated on the pool
    // beforehand it proved nothing: `users.role_id` carries no SQL foreign key
    // by design (§4.1), so nothing stops a user being reassigned onto this role
    // between the check and the delete — and the database would not object.
    assertRoleUnused(await roleRepo.isRoleInUse(actor.tenantId, id, trx), existing.name);

    await roleRepo.softDeleteRole(actor.tenantId, id, actorUserId(actor), trx);

    // G4. G5 already refused a role anybody holds, so this is belt to that
    // brace — but it costs one indexed read and covers the case where the two
    // guards disagree about what "holds" means.
    assertAdministrativeCapabilityRetained(
      adminsBefore,
      await accessGuard.readAdministrativeCapability(actor.tenantId, trx),
    );

    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'role',
      entityId: id,
      action: 'deleted',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: existing.name },
    }, actor, trx);
  });

  const role = await roleRepo.findRoleById(actor.tenantId, id, { includeDeleted: true });
  if (!role) throw new NotFoundError('Role');

  publishChange({ entity: 'role', action: 'deleted', id, payload: role });
  return role;
}

/**
 * Restore a soft-deleted role.
 *
 * Every user still pointing at it reattaches automatically, which only works
 * because `users.role_id` is not a SQL foreign key (§4.1).
 */
export async function restoreRole(
  id: string,
  actor: ActorContext,
  renameTo?: string,
): Promise<Role> {
  requirePermission(actor, 'roles.delete');
  assertAdminTier(actor, 'roles.delete');

  const existing = await roleRepo.findRoleById(actor.tenantId, id, { includeDeleted: true });
  if (!existing) throw new NotFoundError('Role');
  if (!existing.deletedAt) return existing;

  const desiredName = renameTo ?? existing.name;
  if (await roleRepo.isNameTaken(actor.tenantId, desiredName, id)) {
    const suggestion = await suggestRestoredName(existing.name, (candidate) =>
      roleRepo.isNameTaken(actor.tenantId, candidate, id),
    );
    throw new ConflictError(
      'error.conflict.restoreCollision',
      { field: 'name' },
      { field: 'name', value: desiredName, suggestion },
    );
  }

  await db().transaction(async (trx) => {
    await roleRepo.restoreRole(actor.tenantId, id, trx, renameTo);

    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'role',
      entityId: id,
      action: 'restored',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: existing.name, ...(renameTo ? { renamedTo: renameTo } : {}) },
    }, actor, trx);
  });

  const role = await roleRepo.findRoleById(actor.tenantId, id);
  if (!role) throw new NotFoundError('Role');

  publishChange({ entity: 'role', action: 'restored', id, payload: role });
  return role;
}

function assertTier(value: unknown): RoleTier {
  if (!isRoleTier(value)) throw new ValidationError('validation.role.tierInvalid');
  return value;
}
