/**
 * The facts guard G4 needs, read under a lock (docs/ROLES_AND_USERS.md §8).
 *
 * G4 protects against the most expensive bug this module can ship: a company
 * locked out of its own administration, which `setup.service.ts` cannot undo
 * because it refuses to re-bootstrap once `master_config` exists. Recovery then
 * needs direct database access.
 *
 * Two things make the guard actually hold, and both live here rather than in a
 * service:
 *
 * 1. **A serialising lock.** Counting inside the transaction is not enough. The
 *    connection runs at READ COMMITTED and two transactions deactivating two
 *    *different* administrators touch disjoint rows, so neither blocks the other
 *    and both see one remaining admin. Row locks cannot help — the rows that
 *    must not change are the ones nobody is touching. So the guard takes a
 *    per-tenant advisory lock before it reads.
 *
 * 2. **Reading after the write.** Every caller applies its change first and then
 *    asks whether the company still has an administrator. Simulating the change
 *    instead means re-deriving what an edit would do to a permission array, and
 *    getting that arithmetic subtly wrong is exactly how the role-edit path came
 *    to have no guard at all.
 */

import type { TransactionContext } from './transaction.js';

/**
 * Namespace for the two-argument advisory lock form.
 *
 * Deliberately the *two*-argument `pg_advisory_xact_lock(int, int)`, which is a
 * separate lock space from the one-argument `pg_advisory_xact_lock(bigint)` the
 * `activity_log` chain trigger uses. Sharing a key would mean every audited
 * write serialised against every access guard for no reason.
 */
const ACCESS_GUARD_NAMESPACE = 4711;

/**
 * Serialise access-guard checks for one company.
 *
 * Held until the transaction ends. Take it **before** reading anything the guard
 * will decide on, or the read races exactly as it did without any lock.
 */
export async function lockTenantAccessGuards(
  tenantId: string,
  trx: TransactionContext,
): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [ACCESS_GUARD_NAMESPACE, tenantId]);
}

export interface AdministrativeCapability {
  /** Active, live users holding a live admin-tier role. */
  adminCount: number;
  /** Everything that population can do between them. */
  permissions: string[];
}

/**
 * What administrative capability this company still has.
 *
 * Counting administrators is not sufficient on its own: an administrator whose
 * role has had `users.manage` and `roles.edit` stripped is an administrator who
 * cannot appoint anyone or repair a role, which is the same lockout by a longer
 * route. So the union of what the admin population can do is returned alongside
 * the count, and the rule about what that union must contain is a pure function
 * in `domain/access.ts`.
 */
export async function readAdministrativeCapability(
  tenantId: string,
  trx: TransactionContext,
): Promise<AdministrativeCapability> {
  const rows = await trx('users as u')
    .join('roles as r', function join() {
      this.on('r.id', '=', 'u.role_id').andOn('r.tenant_id', '=', 'u.tenant_id');
    })
    .where('u.tenant_id', tenantId)
    .whereNull('u.deleted_at')
    .andWhere('u.is_active', true)
    .whereNull('r.deleted_at')
    .andWhere('r.tier', 'admin')
    .select<Array<{ id: string; permissions: unknown }>>('u.id', 'r.permissions');

  const permissions = new Set<string>();
  for (const row of rows) {
    for (const permission of toStringArray(row.permissions)) permissions.add(permission);
  }

  return { adminCount: rows.length, permissions: [...permissions] };
}

/**
 * `permissions` is JSONB, which the driver parses for us — but a row written
 * before the column existed, or by hand, may be anything. Anything that is not
 * an array of strings contributes nothing rather than throwing, because this
 * runs inside a guard whose failure mode should be "refuse the change", not
 * "crash the request".
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
