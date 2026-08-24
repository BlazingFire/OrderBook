/**
 * Re-filter every stored role through its own tier ceiling.
 *
 * `20260303` remapped the old coarse permission keys forward — `parties.manage`
 * became `parties.create` + `parties.edit` + `parties.delete`, and
 * `inventory.manage` became `inventory.edit` + `stock.adjust` — without
 * re-checking the result against the tier ceiling. Several of the expanded keys
 * sit above `office`, so the seeded Office role came out holding
 * `parties.delete`, which its own tier may not hold.
 *
 * The visible symptom is worse than a stray permission. The role editor renders
 * an above-tier key as checked-but-disabled, so it cannot be unticked; it is
 * resubmitted on save; and `assertPermissionsWithinTier` then rejects the whole
 * save. Both shipped non-admin roles were therefore impossible to edit through
 * the product at all, with an error message about a key the administrator never
 * chose and could not remove.
 *
 * Enforcement was never affected: `permissionSetForRole` intersects with the
 * ceiling on every resolution, so nobody could ever *use* the extra key. This
 * repairs the stored rows so what is on disk matches what is enforced.
 *
 * **The tier map below is inlined deliberately.** Importing it from
 * `@orderbook/shared` would make this migration's behaviour change whenever the
 * catalogue changes — which is exactly the defect `20260301` shipped, where
 * editing the live catalogue retroactively altered what an already-applied
 * migration had done. A migration is a fixed historical fact.
 */

import type { Knex } from 'knex';

const TIER_RANK: Record<string, number> = { office: 1, management: 2, admin: 3 };

/** The lowest tier that may hold each key, frozen as of 2026-08-24. */
const MINIMUM_TIER: Record<string, string> = {
  'users.manage': 'admin',
  'roles.assign': 'admin',
  'panels.manage': 'admin',
  'settings.manage': 'admin',
  'fields.manage': 'admin',
  'sync.resolveConflicts': 'admin',
  'roles.view': 'admin',
  'roles.create': 'admin',
  'roles.edit': 'admin',
  'roles.delete': 'admin',
  'leads.delete': 'management',
  'orders.delete': 'management',
  'parties.delete': 'management',
  'products.delete': 'management',
  'leads.bulk': 'management',
  'orders.bulk': 'management',
  'parties.bulk': 'management',
  'products.bulk': 'management',
  'record.reassignOwner': 'management',
  'field.saleRate.edit': 'management',
};

function permittedForTier(permission: string, tier: string): boolean {
  const required = MINIMUM_TIER[permission] ?? 'office';
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[required] ?? 0);
}

interface RoleRow {
  id: string;
  tenant_id: string;
  tier: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  const roles = await knex<RoleRow>('roles').select('id', 'tenant_id', 'tier', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const kept = stored.filter((permission) => permittedForTier(permission, role.tier)).sort();

    // Only rewrite rows that actually change. A no-op update would bump nothing
    // useful and would churn `updated_at` across every installation.
    if (kept.length === stored.length) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(kept) });
  }
}

export async function down(): Promise<void> {
  // Deliberately empty. The keys removed here were never usable — the runtime
  // intersects with the ceiling on every resolution — so there is no state worth
  // restoring, and re-granting an above-tier permission on a rollback would be a
  // privilege escalation dressed up as a migration.
}
