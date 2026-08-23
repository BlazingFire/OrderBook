/**
 * The permission catalogue (docs/LEAD_GENERATION_FLOW.md §1).
 *
 * Permissions are plain string keys held by a role, checked in two places: the
 * Office Panel's server process before a mutation is queued, and the Master's
 * mutation path before it is applied. Both import this list, so a key can never
 * mean one thing on one side and something else on the other.
 *
 * Two kinds live here:
 *   module actions  "may this role do X"      — a missing one is a 403
 *   field actions   "may this role see X"     — a missing one omits the key
 *
 * The field kind matters: a role without `field.saleRate.view` must receive
 * records with `rate` **absent**, not nulled. A null says "this line has no
 * rate", which is a different and wrong statement.
 */

export const PERMISSIONS = [
  // Leads
  'leads.view',
  'leads.create',
  'leads.edit',
  'leads.delete',
  'lead.convert',

  // Orders
  'orders.view',
  'orders.edit',
  'orders.dispatch',

  // Reference data
  'parties.view',
  'parties.manage',
  'products.view',
  'products.manage',
  'inventory.view',
  'inventory.manage',

  // Cross-cutting record capabilities
  'record.reassignOwner',

  // Administration
  'settings.manage',
  'users.manage',
  'panels.manage',
  'sync.resolveConflicts',

  // Field-level visibility
  'field.saleRate.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return (PERMISSIONS as readonly unknown[]).includes(value);
}

/** Permissions that gate a *field* rather than an action. */
export const FIELD_PERMISSIONS = ['field.saleRate.view'] as const satisfies readonly Permission[];

export const ROLE_TIERS = ['admin', 'management', 'office'] as const;

export type RoleTier = (typeof ROLE_TIERS)[number];

export function isRoleTier(value: unknown): value is RoleTier {
  return (ROLE_TIERS as readonly unknown[]).includes(value);
}

/**
 * What each seeded tier starts with. These are seeds, not hard-coded law — a
 * tenant's admin can edit any role's grants afterwards, which is why the
 * permission check reads `role_permissions` rather than the tier name.
 */
export const DEFAULT_TIER_PERMISSIONS: Record<RoleTier, readonly Permission[]> = {
  admin: PERMISSIONS,

  management: [
    'leads.view',
    'leads.create',
    'leads.edit',
    'leads.delete',
    'lead.convert',
    'orders.view',
    'orders.edit',
    'orders.dispatch',
    'parties.view',
    'parties.manage',
    'products.view',
    'products.manage',
    'inventory.view',
    'inventory.manage',
    'record.reassignOwner',
    'sync.resolveConflicts',
    'field.saleRate.view',
  ],

  // The day-to-day lead desk: everything needed to raise and progress a lead,
  // but not to reassign someone else's record or manage the catalogue.
  office: [
    'leads.view',
    'leads.create',
    'leads.edit',
    'lead.convert',
    'orders.view',
    'parties.view',
    'parties.manage',
    'products.view',
    'inventory.view',
    'field.saleRate.view',
  ],
};

/** A resolved permission set, as attached to a signed-in caller. */
export interface PermissionSet {
  readonly roleId: string | null;
  readonly roleName: string;
  readonly tier: RoleTier;
  readonly permissions: readonly Permission[];
}

export function hasPermission(set: PermissionSet | null, permission: Permission): boolean {
  return set !== null && set.permissions.includes(permission);
}

/**
 * Strip field-gated keys from an outgoing record. Deletes rather than nulls, per
 * the rule above — and returns a copy so a cached row is never mutated in place.
 */
export function maskFields<T extends Record<string, unknown>>(
  record: T,
  set: PermissionSet | null,
  gated: ReadonlyArray<{ key: keyof T & string; permission: Permission }>,
): Partial<T> {
  const masked: Partial<T> = { ...record };

  for (const { key, permission } of gated) {
    if (!hasPermission(set, permission)) delete masked[key];
  }

  return masked;
}
