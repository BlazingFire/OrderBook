/**
 * Party Access — who may see and manage each party.
 *
 * Until now every user holding `parties.view` saw every party in the company,
 * and the same for the leads and orders hanging off one. This table is what
 * makes a party assignable to particular people, at one of two levels.
 *
 * **A party with no row here is open to everyone.** That is the rule the whole
 * feature turns on, and it is why this migration backfills nothing: an
 * installation that runs it looks exactly as it did the minute before, and only
 * the parties an administrator actually assigns become restricted. The
 * alternative — assignment mandatory, unassigned means invisible — would empty
 * every staff member's screens on the day of the upgrade.
 *
 * `user_id` deliberately carries **no foreign key**, matching `users.role_id`
 * (`20260303000000_roles_and_users.ts`): users are soft-deleted and restorable,
 * and a restored person must come back holding the parties they were assigned
 * rather than having had those rows cascaded away. The service validates that
 * the user exists and is live at the moment a grant is written.
 *
 * There is no denormalised "is restricted" flag on `parties`. Whether a party
 * is restricted is `EXISTS (SELECT 1 FROM party_access …)`, which the party
 * index answers directly; a cached boolean would be a second source of truth
 * for the rule above, and this data set is small.
 */

import type { Knex } from 'knex';

/**
 * Granted to administrator-tier roles only, and **inlined and frozen** rather
 * than imported from `@orderbook/shared` — that import is the `20260301`
 * defect, where editing the live catalogue retroactively changed what an
 * already-applied migration had done. Every other role receives these keys from
 * an administrator ticking them in the permission grid, deliberately.
 */
const NEW_KEYS = ['party.accessAll', 'party.assign'] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE party_access (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID NOT NULL REFERENCES tenants(id),
      party_id     TEXT NOT NULL REFERENCES parties(id),
      user_id      TEXT NOT NULL,
      access_level TEXT NOT NULL CHECK (access_level IN ('view', 'manage')),
      granted_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // One grant per (party, person): a second one would make "what may this
  // person do here" ambiguous rather than additive.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_party_access_unique
      ON party_access(tenant_id, party_id, user_id)
  `);

  // Both directions are hot: "which parties may this person see" runs on every
  // list for a scoped caller, and "is this party restricted, and to whom" runs
  // per row on the Party Access screen.
  await knex.raw(`CREATE INDEX idx_party_access_user ON party_access(tenant_id, user_id)`);
  await knex.raw(`CREATE INDEX idx_party_access_party ON party_access(tenant_id, party_id)`);

  const roles = await knex('roles')
    .where('tier', 'admin')
    .select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // "Already holds every new key", never a length comparison — `permissions`
    // is a JSONB array that can legitimately contain duplicates from an older
    // replica, so a union can leave the length unchanged while still having
    // added something. See `20260309000000_new_module_permission_grant.ts`.
    if (NEW_KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...NEW_KEYS])].sort();

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS party_access`);
  // The permission grant is deliberately not revoked: by the time a rollback
  // runs an administrator may have granted these keys onward through the grid,
  // and this migration cannot tell its own grant from theirs. A key whose
  // capability no longer exists is filtered out by `effectivePermissions` on
  // every resolution, so leaving it costs nothing.
}
