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
  assertAdminTier,
  assertNameAvailable,
  assertPermissionsWithinTier,
  assertRoleUnused,
  assertSystemRoleEditable,
  assertTierWithinActor,
  assertVersionMatches,
} from '../domain/access.js';
import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as roleRepo from '../repositories/role.repository.js';
import { publishChange } from './change-bus.js';

/** Fields the offline merge can arbitrate over, in wire-format names. */
const ROLE_FIELDS = ['name', 'tier', 'permissions'] as const;

export function permissionCatalogue(): PermissionCatalogue {
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
  if (!name) throw new ValidationError('Give the role a name');

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
    });

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

  assertVersionMatches(existing.sync.version, input.expectedVersion);

  const name = input.name?.trim();
  if (!name) throw new ValidationError('Give the role a name');

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
    });
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
  assertRoleUnused(await roleRepo.isRoleInUse(actor.tenantId, id), existing.name);

  await db().transaction(async (trx) => {
    await roleRepo.softDeleteRole(actor.tenantId, id, actorUserId(actor), trx);

    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'role',
      entityId: id,
      action: 'deleted',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: existing.name },
    });
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
export async function restoreRole(id: string, actor: ActorContext): Promise<Role> {
  requirePermission(actor, 'roles.delete');
  assertAdminTier(actor, 'roles.delete');

  const existing = await roleRepo.findRoleById(actor.tenantId, id, { includeDeleted: true });
  if (!existing) throw new NotFoundError('Role');
  if (!existing.deletedAt) return existing;

  assertNameAvailable(
    await roleRepo.isNameTaken(actor.tenantId, existing.name, id),
    'role',
    existing.name,
  );

  await db().transaction(async (trx) => {
    await roleRepo.restoreRole(actor.tenantId, id, trx);

    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'role',
      entityId: id,
      action: 'restored',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: existing.name },
    });
  });

  const role = await roleRepo.findRoleById(actor.tenantId, id);
  if (!role) throw new NotFoundError('Role');

  publishChange({ entity: 'role', action: 'updated', id, payload: role });
  return role;
}

function assertTier(value: unknown): RoleTier {
  if (!isRoleTier(value)) throw new ValidationError('Choose a valid tier');
  return value;
}
