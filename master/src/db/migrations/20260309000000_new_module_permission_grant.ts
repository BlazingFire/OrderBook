/**
 * Grant this batch's new permission keys to administrator-tier roles.
 * Stage 7 of `docs/backend-modules/` — **the last migration by definition**,
 * because it can only run once every module that mints a key has landed.
 *
 * Union, not replace, so this converges on a fresh install (where `20260303`'s
 * live `allPermissions()` import already granted them) and on an installation
 * migrated before these keys existed (where it did not). Both end in the same
 * place, which is the point of a union.
 *
 * **Administrator tier only.** Handing every existing role a new capability is
 * exactly the act the no-wildcard rule in `shared/src/domain/permissions.ts`
 * exists to prevent — "a permission the product gains, added to a role
 * somebody approved before it existed". Non-admin roles receive these keys
 * from an administrator who ticks them in the grid, deliberately.
 *
 * No tenant filter and no `deleted_at` filter: every administrator role in the
 * database, including soft-deleted ones, which can be restored later and would
 * otherwise come back missing every key.
 *
 * The key list is **inlined and frozen as of 2026-08-25**, never imported from
 * `@orderbook/shared`. That import is the `20260301` defect: editing the live
 * catalogue would retroactively change what this migration had already done on
 * every installation that ran it.
 */

import type { Knex } from 'knex';

const NEW_KEYS = [
  'documents.create',
  'documents.delete',
  'documents.edit',
  'documents.render',
  'documents.view',
  'fields.view',
  'logs.export',
  'logs.verifyChain',
  'logs.view',
  'recycleBin.view',
  'recycleBin.viewAll',
] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  const roles = await knex('roles')
    .where('tier', 'admin')
    .select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // The no-op test is "already holds every new key", **never** a length
    // comparison. `permissions` is a JSONB array and nothing in the database
    // forbids a duplicate — a row that arrived over sync from an older replica
    // can hold `['leads.view', 'leads.view', …]`. A union deduplicates, so
    // `merged.length === stored.length` can be true for a row that is missing
    // every key this migration exists to grant; that row would be skipped, the
    // migration would report success, and the symptom would surface weeks
    // later as an administrator who cannot open the Logs screen.
    //
    // `20260304` is not a counterexample: it *filters*, and a filter cannot
    // lengthen an array, so a length test is correct there. The test has to
    // match the operation.
    if (NEW_KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...NEW_KEYS])].sort();

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(): Promise<void> {
  // Deliberately empty. Revoking is not the inverse of granting: by the time a
  // rollback runs, an administrator may have granted these keys to other roles
  // through the grid, and this migration cannot tell its own grant from
  // theirs. Leaving them costs nothing — `effectivePermissions` filters out a
  // key whose module no longer exists on every resolution.
}
