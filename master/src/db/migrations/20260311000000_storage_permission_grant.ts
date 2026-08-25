/**
 * Grants `storage.manage` to every role that already holds `settings.manage`.
 *
 * Permissions are stored per role as a JSONB array (`20260301000000`'s Phase A),
 * not derived from the live `CAPABILITIES` catalogue at read time, so adding a
 * new capability key to `shared/src/domain/permissions.ts` does not reach any
 * role already on disk — including the seeded Administrator role. This mirrors
 * `20260304000000_role_tier_ceiling_repair.ts`'s approach of inlining the rule
 * rather than importing the live catalogue, for the same reason: a migration
 * is a fixed historical fact, and importing `permissions.ts` here would make
 * this migration's behaviour change retroactively whenever that file does.
 *
 * `settings.manage` is the existing admin-only capability nearest in spirit to
 * storage/backup — anyone trusted to change connection and appearance settings
 * is trusted to export and restore this installation's data.
 */

import type { Knex } from 'knex';

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  const roles = await knex<RoleRow>('roles').select('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    if (!stored.includes('settings.manage') || stored.includes('storage.manage')) continue;

    const next = [...stored, 'storage.manage'].sort();
    await knex('roles').where({ id: role.id, tenant_id: role.tenant_id }).update({ permissions: JSON.stringify(next) });
  }
}

export async function down(knex: Knex): Promise<void> {
  const roles = await knex<RoleRow>('roles').select('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    if (!stored.includes('storage.manage')) continue;

    const next = stored.filter((permission) => permission !== 'storage.manage').sort();
    await knex('roles').where({ id: role.id, tenant_id: role.tenant_id }).update({ permissions: JSON.stringify(next) });
  }
}
