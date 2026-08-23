/**
 * The permission catalogue (docs/ROLES_AND_USERS.md §5).
 *
 * One frozen list, imported by every layer that checks a permission: the Office
 * Panel's server process, the Master's mutation path, and the renderer that
 * draws the permission grid. A key can therefore never mean one thing on one
 * side and something else on the other.
 *
 * Three kinds of entry live here:
 *   module actions   `leads.edit`           "may this role do X to Y"
 *   capabilities     `lead.convert`         fine-grained, grouped, not a matrix cell
 *   field actions    `field.saleRate.view`  "may this role *see* X"
 *
 * The field kind matters: a role without `field.saleRate.view` must receive
 * records with `rate` **absent**, not nulled. A null says "this line has no
 * rate", which is a different and wrong statement — and one a client will
 * happily total to zero.
 *
 * The grid is rendered from `MODULE_ACTIONS` and `CAPABILITIES` rather than from
 * a list typed into the UI, so a new capability reaches the screen with one
 * translation entry and no UI change.
 */

// --- Tiers -----------------------------------------------------------------

export const ROLE_TIERS = ['office', 'management', 'admin'] as const;

export type RoleTier = (typeof ROLE_TIERS)[number];

export function isRoleTier(value: unknown): value is RoleTier {
  return (ROLE_TIERS as readonly unknown[]).includes(value);
}

/** Ordering, so "at or below my own tier" is a comparison rather than a table. */
export function tierRank(tier: RoleTier): number {
  return ROLE_TIERS.indexOf(tier);
}

// --- Modules and their actions --------------------------------------------

export const MODULES = [
  'leads',
  'orders',
  'parties',
  'products',
  'inventory',
  'reports',
  'roles',
] as const;

export type PermissionModule = (typeof MODULES)[number];

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'bulk'] as const;

export type PermissionAction = (typeof ACTIONS)[number];

/**
 * Which actions each module actually declares.
 *
 * A module/action pair missing from here renders as "not applicable" in the
 * grid, which is a different statement from "your tier may not hold it". Orders
 * declare no `create` because an order only ever comes from converting a lead;
 * inventory declares no `create`/`delete` because stock arrives and leaves
 * through movements, never by creating or removing a row.
 */
export const MODULE_ACTIONS: Record<PermissionModule, readonly PermissionAction[]> = {
  leads: ['view', 'create', 'edit', 'delete', 'export', 'bulk'],
  orders: ['view', 'edit', 'delete', 'export', 'bulk'],
  parties: ['view', 'create', 'edit', 'delete', 'export', 'bulk'],
  products: ['view', 'create', 'edit', 'delete', 'export', 'bulk'],
  inventory: ['view', 'edit', 'export'],
  reports: ['view', 'export'],
  roles: ['view', 'create', 'edit', 'delete'],
};

// --- Capabilities ----------------------------------------------------------

export const CAPABILITY_GROUPS = ['workflow', 'pricing', 'stock', 'admin'] as const;

export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

interface CapabilityDefinition {
  key: string;
  group: CapabilityGroup;
  /** Translation token; the renderer never hard-codes the English. */
  labelToken: string;
}

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  { key: 'lead.convert', group: 'workflow', labelToken: 'permission.lead.convert' },
  { key: 'orders.dispatch', group: 'workflow', labelToken: 'permission.orders.dispatch' },
  {
    key: 'record.reassignOwner',
    group: 'workflow',
    labelToken: 'permission.record.reassignOwner',
  },

  { key: 'field.saleRate.view', group: 'pricing', labelToken: 'permission.field.saleRate.view' },
  { key: 'field.saleRate.edit', group: 'pricing', labelToken: 'permission.field.saleRate.edit' },

  { key: 'stock.adjust', group: 'stock', labelToken: 'permission.stock.adjust' },

  { key: 'users.manage', group: 'admin', labelToken: 'permission.users.manage' },
  { key: 'roles.assign', group: 'admin', labelToken: 'permission.roles.assign' },
  { key: 'panels.manage', group: 'admin', labelToken: 'permission.panels.manage' },
  { key: 'settings.manage', group: 'admin', labelToken: 'permission.settings.manage' },
  { key: 'fields.manage', group: 'admin', labelToken: 'permission.fields.manage' },
  {
    key: 'sync.resolveConflicts',
    group: 'admin',
    labelToken: 'permission.sync.resolveConflicts',
  },
] as const;

// --- The frozen key list ---------------------------------------------------

function moduleKeys(): string[] {
  return MODULES.flatMap((module) =>
    MODULE_ACTIONS[module].map((action) => `${module}.${action}`),
  );
}

/**
 * Every permission key in the product, module actions first then capabilities.
 *
 * Derived rather than hand-listed, so the grid and the catalogue cannot drift:
 * adding an action to `MODULE_ACTIONS` adds the key here, and a role holding a
 * key absent from here fails validation on write.
 */
export const PERMISSIONS: readonly string[] = [
  ...moduleKeys(),
  ...CAPABILITIES.map((capability) => capability.key),
];

export type Permission = string;

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** Permissions that gate a *field* rather than an action. */
export const FIELD_PERMISSIONS = ['field.saleRate.view', 'field.saleRate.edit'] as const;

// --- The tier ceiling ------------------------------------------------------

/**
 * The **lowest** tier that may hold each key. A key absent from here is
 * available to every tier.
 *
 * The ceiling is enforced on save and again at sign-in. Checking it twice is
 * not redundant: a role row that arrived over sync from a tampered replica
 * carrying `users.manage` on an office tier is stripped at sign-in and never
 * enters the session.
 */
const MINIMUM_TIER: Record<string, RoleTier> = {
  // Administration is the company's own governance.
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

  // Destructive or wholesale operations want a supervisor, not a lead desk.
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

/** The lowest tier permitted to hold a key. */
export function minimumTierFor(permission: Permission): RoleTier {
  return MINIMUM_TIER[permission] ?? 'office';
}

export function isPermittedForTier(permission: Permission, tier: RoleTier): boolean {
  return tierRank(tier) >= tierRank(minimumTierFor(permission));
}

/** Every key a tier is allowed to hold. */
export function allowedForTier(tier: RoleTier): Permission[] {
  return PERMISSIONS.filter((permission) => isPermittedForTier(permission, tier));
}

/**
 * The keys a role would lose by moving to a lower tier.
 *
 * Computed in one place because the UI previews it before the change and the
 * service re-derives it on save — and the service must never trust the client's
 * arithmetic.
 */
export function keysAboveTier(permissions: readonly Permission[], tier: RoleTier): Permission[] {
  return [...permissions].filter((permission) => !isPermittedForTier(permission, tier)).sort();
}

/**
 * What a role may actually exercise: what it holds, intersected with what its
 * tier allows. Sorted and de-duplicated, so two identical sets are identical
 * bytes and a no-op edit produces no mutation.
 */
export function effectivePermissions(
  permissions: readonly Permission[],
  tier: RoleTier,
): Permission[] {
  return [...new Set(permissions)]
    .filter((permission) => isPermission(permission) && isPermittedForTier(permission, tier))
    .sort();
}

// --- Seeds and templates ---------------------------------------------------

/**
 * The Administrator role's grant: every key in the catalogue, enumerated.
 *
 * There is no wildcard, deliberately. A wildcard would silently add every
 * permission the product ever gains to a role somebody approved before those
 * permissions existed.
 */
export function allPermissions(): Permission[] {
  return [...PERMISSIONS].sort();
}

/**
 * Starting points offered when creating a role — **templates, not seeded rows**
 * (docs/ROLES_AND_USERS.md §13). Only Administrator is created with a company,
 * because a seeded role nobody reviewed is a permission set nobody approved.
 */
export const ROLE_TEMPLATES: ReadonlyArray<{
  nameToken: string;
  tier: RoleTier;
  permissions: readonly Permission[];
}> = [
  {
    nameToken: 'roleTemplate.sales',
    tier: 'management',
    permissions: [
      'leads.view',
      'leads.create',
      'leads.edit',
      'leads.export',
      'orders.view',
      'orders.edit',
      'orders.export',
      'parties.view',
      'parties.create',
      'parties.edit',
      'products.view',
      'inventory.view',
      'reports.view',
      'reports.export',
      'lead.convert',
      'field.saleRate.view',
    ],
  },
  {
    nameToken: 'roleTemplate.dispatch',
    tier: 'office',
    permissions: [
      'orders.view',
      'orders.edit',
      'products.view',
      'inventory.view',
      'inventory.edit',
      'orders.dispatch',
      'stock.adjust',
    ],
  },
];

// --- Resolved sets ---------------------------------------------------------

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

// --- The catalogue served to the UI ---------------------------------------

export interface PermissionCatalogue {
  tiers: readonly RoleTier[];
  actions: readonly PermissionAction[];
  modules: ReadonlyArray<{
    key: PermissionModule;
    labelToken: string;
    /** Only the actions this module declares; the rest are not applicable. */
    actions: readonly PermissionAction[];
  }>;
  capabilities: ReadonlyArray<{ key: string; group: CapabilityGroup; labelToken: string }>;
  groups: ReadonlyArray<{ key: CapabilityGroup; labelToken: string }>;
  /** Per key, the lowest tier that may hold it — this drives the blocked cells. */
  minimumTier: Record<string, RoleTier>;
}

/**
 * One response the renderer caches for the session. Built here rather than in a
 * service so the shape is part of the shared contract.
 */
export function buildPermissionCatalogue(): PermissionCatalogue {
  return {
    tiers: ROLE_TIERS,
    actions: ACTIONS,
    modules: MODULES.map((module) => ({
      key: module,
      labelToken: `module.${module}`,
      actions: MODULE_ACTIONS[module],
    })),
    capabilities: CAPABILITIES.map((capability) => ({ ...capability })),
    groups: CAPABILITY_GROUPS.map((group) => ({
      key: group,
      labelToken: `capabilityGroup.${group}`,
    })),
    minimumTier: Object.fromEntries(
      PERMISSIONS.map((permission) => [permission, minimumTierFor(permission)]),
    ),
  };
}
