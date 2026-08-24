/** Thin wrapper over the Master's local HTTP API. */

import type {
  ChangeOwnPasswordInput,
  CustomFieldDefinition,
  DashboardSummary,
  InventoryStockLevel,
  Lead,
  MasterIdentity,
  OfficePanelWithPresence,
  OptionListItem,
  Order,
  Paginated,
  Party,
  PartyInput,
  PartyProductVariant,
  Pipeline,
  OneTimeSecret,
  PermissionCatalogue,
  Product,
  ProductCategory,
  ProductInput,
  Role,
  RoleInput,
  SearchHit,
  StockMovement,
  StorageUsage,
  SignedInUser,
  SyncConflict,
  User,
  UserInput,
  UserUpdateInput,
} from '@orderbook/shared';

/** A field a stale save disagrees with the server about. */
export interface FieldDifference {
  stored: unknown;
  incoming: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    /** Stable code — branch on this, never on the message. */
    readonly code: string,
    /** Whatever the server attached: permission, storedVersion, diff. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  /** Set on a 403, so a screen can say which permission is missing. */
  get missingPermission(): string | undefined {
    return typeof this.details.permission === 'string' ? this.details.permission : undefined;
  }

  get isConflict(): boolean {
    return this.code === 'conflict';
  }

  get storedVersion(): number | undefined {
    return typeof this.details.storedVersion === 'number' ? this.details.storedVersion : undefined;
  }

  get diff(): Record<string, FieldDifference> {
    return (this.details.diff as Record<string, FieldDifference> | undefined) ?? {};
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // `details` is where the server puts the structured facts. It used to read
    // `body.permission`, which the server never sent at the top level — so
    // `missingPermission` was permanently undefined and every branch on it was
    // dead code.
    const detail = body as
      | { error?: string; message?: string; details?: Record<string, unknown> }
      | null;

    throw new ApiError(
      detail?.message ?? 'Request failed',
      detail?.error ?? 'internal_error',
      detail?.details ?? {},
    );
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export interface FirstRunCredentials {
  masterUniqueId: string;
  username: string;
  password: string;
  pairingPassword: string;
  lanIps: string[];
  port: number;
}

export const api = {
  setupStatus: () => request<{ setupComplete: boolean }>('/api/setup/status'),
  initialize: (companyName: string) => post<FirstRunCredentials>('/api/setup/initialize', { companyName }),
  identity: () => request<MasterIdentity>('/api/setup/identity'),

  signIn: (username: string, password: string) =>
    post<{ user: SignedInUser; sessionToken: string }>('/api/auth/sign-in', { username, password }),
  signOut: () => post<void>('/api/auth/sign-out'),
  // Carries the caller's own resolved permissions, so the UI renders from what
  // the trusted process granted rather than guessing from the role name.
  me: () => request<{ user: SignedInUser; sessionToken: string }>('/api/auth/me'),

  dashboard: () => request<DashboardSummary>('/api/dashboard'),
  storage: () => request<StorageUsage>('/api/storage'),

  pipelines: () => request<Pipeline[]>('/api/pipelines'),
  optionLists: () => request<OptionListItem[]>('/api/option-lists'),
  customFields: () => request<CustomFieldDefinition[]>('/api/custom-fields'),

  search: (term: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(term)}`),

  panels: () => request<{ panels: OfficePanelWithPresence[] }>('/api/panels'),
  openPairingWindow: () => post<{ closesAt: number }>('/api/panels/pairing-window/open'),
  closePairingWindow: () => post<void>('/api/panels/pairing-window/close'),
  revokePanel: (id: string) => post<void>(`/api/panels/${id}/revoke`),
  renamePanel: (id: string, name: string) =>
    request<void>(`/api/panels/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  parties: (search?: string) =>
    request<Paginated<Party>>(`/api/parties${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  createParty: (input: PartyInput) => post<Party>('/api/parties', input),
  partyVariants: (partyId: string) =>
    request<PartyProductVariant[]>(`/api/parties/${partyId}/variants`),

  products: (search?: string) =>
    request<Paginated<Product>>(`/api/products${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  productByCode: (code: string) => request<Product>(`/api/products/by-code/${encodeURIComponent(code)}`),
  createProduct: (input: ProductInput) => post<Product>('/api/products', input),
  categories: () => request<ProductCategory[]>('/api/categories'),

  stock: (options: { search?: string; lowOnly?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.lowOnly) params.set('lowOnly', 'true');
    const query = params.toString();
    return request<InventoryStockLevel[]>(`/api/stock${query ? `?${query}` : ''}`);
  },
  stockColours: (productId: string) => request<string[]>(`/api/stock/colours/${productId}`),
  stockMovements: (productId?: string) =>
    request<StockMovement[]>(`/api/stock/movements${productId ? `?productId=${productId}` : ''}`),
  stockInbound: (input: { productId: string; colour: string; quantityBoxes: number; note?: string }) =>
    post<InventoryStockLevel>('/api/stock/inbound', input),
  stockAdjust: (input: { productId: string; colour: string; quantityBoxes: number; note?: string }) =>
    post<InventoryStockLevel>('/api/stock/adjust', input),
  setReorderLevel: (input: { productId: string; colour: string; reorderLevel: number | null }) =>
    post<InventoryStockLevel>('/api/stock/reorder-level', input),

  // Leads are read-only here: they are raised in the Office Panel, and the
  // Master's API has no create endpoint at all (docs/LEAD_GENERATION_FLOW.md §2).
  leads: (options: { stageIds?: string[]; includeConverted?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.stageIds?.length) params.set('stageIds', options.stageIds.join(','));
    if (options.includeConverted) params.set('includeConverted', 'true');
    const query = params.toString();
    return request<Paginated<Lead>>(`/api/leads${query ? `?${query}` : ''}`);
  },
  lead: (id: string) => request<Lead>(`/api/leads/${id}`),
  setLeadStage: (id: string, stageId: string, remark?: string | null) =>
    post<Lead>(`/api/leads/${id}/stage`, { stageId, remark }),
  addLeadRemark: (id: string, message: string) => post<Lead>(`/api/leads/${id}/remarks`, { message }),
  convertLead: (
    id: string,
    input: { dispatchAddressLabel?: string | null; expectedDispatchDate?: string | null } = {},
  ) => post<Order>(`/api/leads/${id}/convert`, input),

  orders: (options: { stageIds?: string[] } = {}) => {
    const params = new URLSearchParams();
    if (options.stageIds?.length) params.set('stageIds', options.stageIds.join(','));
    const query = params.toString();
    return request<Paginated<Order>>(`/api/orders${query ? `?${query}` : ''}`);
  },
  order: (id: string) => request<Order>(`/api/orders/${id}`),
  updateOrder: (id: string, input: Record<string, unknown>) =>
    request<Order>(`/api/orders/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  setOrderStage: (id: string, stageId: string, remark?: string | null) =>
    post<Order>(`/api/orders/${id}/stage`, { stageId, remark }),
  dispatchOrder: (id: string, note?: string | null) => post<Order>(`/api/orders/${id}/dispatch`, { note }),

  // --- Roles & users -------------------------------------------------------

  permissionCatalogue: () => request<PermissionCatalogue>('/api/access/permission-catalogue'),

  roles: () => request<Role[]>('/api/access/roles'),
  deletedRoles: () => request<Role[]>('/api/access/roles/deleted'),
  role: (id: string) => request<Role>(`/api/access/roles/${id}`),
  createRole: (input: RoleInput) => post<Role>('/api/access/roles', input),
  updateRole: (id: string, input: RoleInput) =>
    request<Role>(`/api/access/roles/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteRole: (id: string) => request<Role>(`/api/access/roles/${id}`, { method: 'DELETE' }),
  restoreRole: (id: string) => post<Role>(`/api/access/roles/${id}/restore`),

  users: () => request<User[]>('/api/access/users'),
  deletedUsers: () => request<User[]>('/api/access/users/deleted'),
  /** The one response in the product that carries a plaintext password, once. */
  createUser: (input: UserInput) =>
    post<{ user: User; secret: OneTimeSecret }>('/api/access/users', input),
  updateUser: (id: string, input: UserUpdateInput) =>
    request<User>(`/api/access/users/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteUser: (id: string) => request<User>(`/api/access/users/${id}`, { method: 'DELETE' }),
  restoreUser: (id: string) => post<User>(`/api/access/users/${id}/restore`),
  resetPassword: (id: string) => post<OneTimeSecret>(`/api/access/users/${id}/reset-password`),
  changeOwnPassword: (input: ChangeOwnPasswordInput) => post<void>('/api/access/me/password', input),

  conflicts: (includeResolved = false) =>
    request<SyncConflict[]>(`/api/conflicts${includeResolved ? '?includeResolved=true' : ''}`),
  resolveConflict: (id: number, action: 'keepWinner' | 'restoreLoser') =>
    post<SyncConflict>(`/api/conflicts/${id}/resolve`, { action }),
};
