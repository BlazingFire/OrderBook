/**
 * Which wire field is which database column — stated once.
 *
 * This table used to exist in five hand-maintained copies: `COLUMN_MAP` in the
 * sync service, a `COLUMN_TO_FIELD` in the lead service, another in the user
 * service, and a `columnsFrom()` in each of the product and party repositories.
 * They drifted, and two of the drifts were bugs: the sync map claimed a `notes`
 * column on `products` that has never existed, and the order service stamped
 * per-field clocks under snake_case names that the merge reads by wire field,
 * so those clocks were written where nothing looks for them.
 *
 * ## The contract
 *
 * **`undefined` means "not asserted". `null` means "clear it".**
 *
 * That distinction is the whole point of this module. `columnPatch()` emits a
 * column only for a key the caller actually set, so a form that knows about
 * eight fields can no longer blank the twelve it has never heard of.
 *
 * Before this, `columnsFrom()` listed every column with `?? null` and the
 * result was spread straight into `.update()` — making every update a full
 * record replace. The only product form in the app edited a subset of the
 * columns, so saving it nulled every column it did not show (`custom_fields`
 * among them). Parties had the same shape and the same bug.
 *
 * The offline path already worked this way — `office/src/http/app.ts` builds
 * its mutation `fields` from `Object.keys(payload)` — so a partial patch is
 * also the only reading that gives one record a single meaning of "edit"
 * across both paths.
 *
 * Anything consuming this contract over the wire (the sync merge, and later a
 * REST client) must be documented as **absent means untouched**.
 */

/** Columns holding JSON, which therefore need serialising on the way in. */
export const JSON_COLUMNS = new Set(['custom_fields']);

export const PARTY_COLUMNS = {
  name: 'name',
  phone: 'phone',
  altPhone: 'alt_phone',
  email: 'email',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  gstNumber: 'gst_number',
  notes: 'notes',
  customFields: 'custom_fields',
} as const satisfies Record<string, string>;

/**
 * `categoryName` and `categoryCode` are deliberately absent: they are
 * conveniences the repository resolves to an id (a name creating the category
 * if it is new), never columns. `variants` is absent too — a child table,
 * replaced as a set by the repository, never merged field by field.
 */
export const PRODUCT_COLUMNS = {
  name: 'name',
  alias: 'alias',
  categoryId: 'category_id',
  hasVariants: 'has_variants',
  size: 'size',
  multiColour: 'multi_colour',
  sortOrder: 'sort_order',
  customFields: 'custom_fields',
} as const satisfies Record<string, string>;

export const LEAD_COLUMNS = {
  partyId: 'party_id',
  ownerId: 'owner_id',
  stageId: 'stage_id',
  sourcePlatform: 'source_platform',
  followUpDate: 'follow_up_date',
  partyWiseMode: 'party_wise_mode',
  notes: 'notes',
  customFields: 'custom_fields',
} as const satisfies Record<string, string>;

export const ORDER_COLUMNS = {
  dispatchAddressLabel: 'dispatch_address_label',
  expectedDispatchDate: 'expected_dispatch_date',
  totalWeightKgOverride: 'total_weight_kg_override',
  vehicleNumber: 'vehicle_number',
  notes: 'notes',
  customFields: 'custom_fields',
} as const satisfies Record<string, string>;

/**
 * Users have no merge path. This exists only so the duplicate in the user
 * service can be deleted, and is deliberately absent from `MERGEABLE_COLUMNS`.
 */
export const USER_COLUMNS = {
  displayName: 'display_name',
  username: 'username',
  roleId: 'role_id',
  isActive: 'is_active',
  passwordHash: 'password_hash',
} as const satisfies Record<string, string>;

/**
 * Products as the offline merge may write them — everything except the
 * category.
 *
 * A merge writes columns with no service in front of it, so it cannot run the
 * repository's `resolveCategoryId`, which accepts a name and creates the
 * category if it is new. Worse, `products_category_fk` turns a stale id from a
 * panel that has been offline since before a category was renamed into a hard
 * Postgres error — and a mutation that throws is recorded as permanently
 * rejected and replayed as that rejection for ever, so the panel's work is
 * destroyed rather than bounced. Assigning a category stays online-only.
 */
export const MERGEABLE_PRODUCT_COLUMNS = (() => {
  const { categoryId: _categoryId, ...rest } = PRODUCT_COLUMNS;
  return rest;
})();

export const MERGEABLE_COLUMNS = {
  lead: LEAD_COLUMNS,
  order: ORDER_COLUMNS,
  party: PARTY_COLUMNS,
  product: MERGEABLE_PRODUCT_COLUMNS,
} as const satisfies Record<string, Record<string, string>>;

export type MergeableEntity = keyof typeof MERGEABLE_COLUMNS;

/**
 * Build a column patch from only the keys the caller set.
 *
 * Generic in the map so that passing `PARTY_COLUMNS` alongside a `ProductInput`
 * is a compile error rather than a silently empty patch.
 */
export function columnPatch<M extends Record<string, string>>(
  input: Partial<Record<keyof M, unknown>>,
  columns: M,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const [field, column] of Object.entries(columns)) {
    const value = input[field as keyof M];
    if (value === undefined) continue;
    // A `null` reaches an ordinary column as NULL — that is how a caller clears
    // a field. The two JSON columns are both `NOT NULL DEFAULT '{}'`, so a null
    // there becomes an empty object rather than a constraint violation, which
    // is what all three call sites this replaced already did.
    patch[column] = JSON_COLUMNS.has(column) ? JSON.stringify(value ?? {}) : value;
  }

  return patch;
}

/**
 * Column → wire field, for the paths that read a column name back out of the
 * database (restoring a conflicted value, stamping an order's clocks).
 *
 * A linear scan: these maps have tens of entries and this runs once per
 * restored field.
 */
export function fieldFor<M extends Record<string, string>>(columns: M, column: string): string {
  const hit = Object.entries(columns).find(([, name]) => name === column);
  return hit ? hit[0] : column;
}
