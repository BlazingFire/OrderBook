/** Thin wrapper over the Master's local HTTP API. */

import { DEVELOPER_RESET_CONFIRMATION, DEVELOPER_TOKEN_HEADER } from '@orderbook/shared';
import { publishSessionEnded, t } from '@orderbook/ui';
import type {
  Locale,
  PickKind,
  ActivityLogEntry,
  DesktopBridge,
  ActivityLogFacets,
  ActivityLogQuery,
  BackupManifest,
  BackupRestorePreview,
  BinCounts,
  BinEntry,
  BinRestoreResult,
  ChainVerification,
  ChainVerifyInput,
  ChangeOwnPasswordInput,
  CursorPage,
  CustomFieldDefinition,
  CustomFieldDefinitionInput,
  CustomFieldDefinitionUpdateInput,
  CustomFieldReorderInput,
  DashboardSummary,
  DeveloperStatus,
  DeveloperUnlock,
  ResetAllResult,
  SeedDummyUsersResult,
  LoadCatalogueResult,
  SeedSampleDataResult,
  ApiKey,
  ApiKeyInput,
  Connector,
  ConnectorFieldMapInput,
  ConnectorInput,
  ConnectorProfile,
  ConnectorResourceInput,
  ConnectorRun,
  ConnectorTestResult,
  DispatchesReport,
  FieldCatalogue,
  FieldUsageBreakdown,
  InventoryStockLevel,
  StockListQuery,
  LeadOutcomesReport,
  Lead,
  MasterIdentity,
  MessageKey,
  MessageParams,
  OfficePanel,
  OfficePanelDetail,
  OfficePanelUpdateInput,
  OfficePanelWithPresence,
  OptionListItem,
  OptionListItemInput,
  OptionListItemUpdateInput,
  OptionListReorderInput,
  Order,
  Paginated,
  PanelSecretRotation,
  PanelStoragePathInput,
  PanelStoragePathResult,
  Party,
  AssignablePerson,
  PartyAccessInput,
  PartyAccessQuery,
  PartyAccessRow,
  ReleaseManifest,
  UpdateAvailability,
  PartyScopeFilter,
  PartyInput,
  Pipeline,
  PipelineStage,
  PipelineStageInput,
  OneTimeSecret,
  PermissionCatalogue,
  Product,
  ProductCategoryListRow,
  ProductInput,
  RecycleBinQuery,
  ReportKind,
  ReportRangeInput,
  RestoreInput,
  Role,
  SettingKey,
  SettingView,
  RoleInput,
  SearchHit,
  StageReorderInput,
  StockMovement,
  StorageUsage,
  SignedInUser,
  SyncConflict,
  TopPartiesReport,
  User,
  VaultStatus,
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
    /** The stable message key a client renders in the reader's own language. */
    readonly messageKey?: MessageKey,
    readonly params?: MessageParams,
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

  /** Records that must be restored first, from the Recycle Bin's `ConflictError`. */
  get blockedBy(): unknown[] {
    return Array.isArray(this.details.blockedBy) ? this.details.blockedBy : [];
  }

  /** The name `suggestRestoredName` offers when a restore collides with a live record. */
  get suggestion(): string | undefined {
    return typeof this.details.suggestion === 'string' ? this.details.suggestion : undefined;
  }
}

/**
 * How long any one request may take before it counts as silence.
 *
 * The Master is on loopback or one LAN hop, so fifteen seconds is not a
 * latency budget — it is the difference between "the panel is thinking" and a
 * screen that waits forever on a Master whose database is wedged. That was the
 * live failure: `/api/setup/status` reads the database, so a Master with
 * Postgres down accepted the socket and never answered.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * GETs already in flight, so N screens asking the same question ask once.
 *
 * **Refcounted, and that is not an optimisation.** Two screens sharing one
 * promise means the first to unmount would otherwise abort the fetch out from
 * under the second, which — since a cancelled request is swallowed by design —
 * renders as loading forever with no data and no error. The shared controller
 * fires only when the last waiter has gone.
 *
 * POSTs never dedup: two identical writes are two writes.
 */
const inFlight = new Map<
  string,
  { promise: Promise<unknown>; controller: AbortController; waiters: number }
>();

function release(key: string): void {
  const entry = inFlight.get(key);
  if (!entry) return;

  entry.waiters -= 1;
  if (entry.waiters > 0) return;

  entry.controller.abort();
  inFlight.delete(key);
}

async function send<T>(
  path: string,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal,
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
    const detail = body as {
      error?: string;
      message?: string;
      details?: Record<string, unknown>;
      messageKey?: MessageKey;
      params?: MessageParams;
    } | null;

    /*
     * A 401 is not an ordinary failure — the session this window is rendering
     * as signed in no longer exists. Announced once, here, because every caller
     * routes through this function: the alternative was eleven screens each
     * showing a generic error toast while the shell went on believing it was
     * signed in. Still thrown afterwards, so the caller's own error path runs
     * exactly as before.
     */
    if (response.status === 401) {
      publishSessionEnded(detail?.messageKey ?? 'signIn.notice.sessionEnded');
    }

    throw new ApiError(
      detail?.message ?? t('error.requestFailed'),
      detail?.error ?? 'internal_error',
      detail?.details ?? {},
      detail?.messageKey,
      detail?.params,
    );
  }
  return body as T;
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  /** Silence and a refusal are different facts; a caller may retry only one. */
  const asFailure = (error: unknown): never => {
    if (error instanceof ApiError) throw error;
    if (timeout.aborted) throw new ApiError(t('error.requestTimedOut'), 'timeout');
    if (init?.signal?.aborted) throw new ApiError(t('error.requestCancelled'), 'aborted');
    /*
     * Neither silence nor a cancel: the request never reached the server,
     * which is not running — or not yet. This was reported as 'aborted',
     * "Request cancelled", and a boot that failed so put that on the splash as
     * a message meant for a reader, in place of "could not reach the server".
     * It gets the code an unstructured 500 gets: neither says more.
     */
    throw new ApiError(t('error.requestFailed'), 'internal_error');
  };

  if (method !== 'GET' || init?.signal) {
    // A caller with its own signal opts out of sharing: it wants a fetch it
    // alone can cancel, and joining a shared one would make its abort somebody
    // else's problem.
    const own = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return send<T>(path, init, own).catch(asFailure);
  }

  /*
   * The dedupe key is the path *plus* whatever headers the caller set. A GET
   * carrying `x-developer-token` is a different question from the same GET
   * without one, and sharing the two would answer "still locked" to the status
   * call made immediately after an unlock.
   */
  const key = init?.headers ? JSON.stringify([path, init.headers]) : path;

  let entry = inFlight.get(key);

  if (!entry) {
    const controller = new AbortController();
    const created = {
      controller,
      waiters: 0,
      promise: send<unknown>(path, init, AbortSignal.any([controller.signal, timeout])),
    };

    // Cleared on settle either way; the `catch` is only to stop an unhandled
    // rejection warning on the shared promise itself.
    void created.promise.catch(() => undefined).finally(() => inFlight.delete(key));

    inFlight.set(key, created);
    entry = created;
  }

  entry.waiters += 1;

  return entry.promise.then(
    (value) => {
      release(key);
      return value as T;
    },
    (error: unknown) => {
      release(key);
      return asFailure(error);
    },
  );
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/**
 * `?search=&limit=&offset=` for a paged list route, omitting whatever is absent.
 *
 * Each service answers an unasked-for limit with its own default and clamps an
 * asked-for one to its own ceiling (`master/src/services/*.service.ts`'s
 * `PAGING`, via `clampPaging`): parties 100 up to 500 — the one list this
 * helper serves today — leads and orders the same, stock 200 up to 1000. So a
 * screen that wants more than one page has to say so, and a screen that reports
 * `rows.length` as the company total is reporting a page size. Both mistakes
 * are easier to avoid with one helper than with template literals per call
 * site.
 */
function pagedQuery(search?: string, limit?: number, offset?: number): string {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** `post`, plus the developer unlock token the route checks instead of a permission. */
const postAsDeveloper = <T>(path: string, token: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    headers: { [DEVELOPER_TOKEN_HEADER]: token },
  });

/** Extracts `ApiError` from a non-JSON (or empty) failure body, for the two `fetch` helpers below. */
async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  const detail = body as {
    error?: string;
    message?: string;
    details?: Record<string, unknown>;
  } | null;
  throw new ApiError(
    detail?.message ?? t('error.requestFailed'),
    detail?.error ?? 'internal_error',
    detail?.details ?? {},
  );
}

/** A binary download, for storage export — the response is the file itself, not JSON. */
async function requestBlob(path: string, body: unknown): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  await throwIfNotOk(response);

  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
  return { blob: await response.blob(), fileName: match?.[1] ?? 'orderbook-backup.obbackup' };
}

/** A multipart upload, for storage restore — the backup file rides as form data, not JSON. */
async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin' });
  await throwIfNotOk(response);
  return (await response.json()) as T;
}

export interface FirstRunCredentials {
  masterUniqueId: string;
  username: string;
  password: string;
  pairingPassword: string;
  lanIps: string[];
  port: number;
}

/**
 * The desktop shell hosting this panel, or `null` in a plain browser tab.
 *
 * Absent is the normal case in development and whenever somebody opens this
 * panel from another machine's browser, so a caller must have a path that does
 * not need it — never a button that silently does nothing.
 */
export function desktopBridge(): DesktopBridge | null {
  return (window as Window & { orderbook?: DesktopBridge }).orderbook ?? null;
}

export const api = {
  setupStatus: () => request<{ setupComplete: boolean }>('/api/setup/status'),
  initialize: (companyName: string) =>
    post<FirstRunCredentials>('/api/setup/initialize', { companyName }),
  identity: () => request<MasterIdentity>('/api/setup/identity'),

  previewRestoreSetup: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return requestForm<BackupRestorePreview>('/api/setup/restore/preview', form);
  },
  restoreSetup: (file: File, passphrase: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('passphrase', passphrase);
    return requestForm<{ manifest: BackupManifest; newPairingPassword: string }>(
      '/api/setup/restore',
      form,
    );
  },

  signIn: (username: string, password: string) =>
    post<{ user: SignedInUser; sessionToken: string }>('/api/auth/sign-in', { username, password }),
  signOut: () => post<void>('/api/auth/sign-out'),
  // Carries the caller's own resolved permissions, so the UI renders from what
  // the trusted process granted rather than guessing from the role name.
  me: () =>
    request<{ user: SignedInUser; sessionToken: string; defaultLocale: Locale }>('/api/auth/me'),

  dashboard: () => request<DashboardSummary>('/api/dashboard'),
  storage: () => request<StorageUsage>('/api/storage'),

  exportStorage: (passphrase: string) =>
    requestBlob('/api/storage/export', { scope: 'whole', passphrase }),
  previewRestoreStorage: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return requestForm<BackupRestorePreview>('/api/storage/restore/preview', form);
  },
  restoreStorage: (file: File, passphrase: string, confirmWipe: boolean) => {
    const form = new FormData();
    form.append('file', file);
    form.append('passphrase', passphrase);
    form.append('confirmWipe', String(confirmWipe));
    return requestForm<{ manifest: BackupManifest; newPairingPassword: string }>(
      '/api/storage/restore',
      form,
    );
  },

  pipelines: () => request<Pipeline[]>('/api/pipelines'),
  optionLists: () => request<OptionListItem[]>('/api/option-lists'),

  // --- App update ----------------------------------------------------------

  updateStatus: () =>
    request<{ running: string; master: UpdateAvailability; office: UpdateAvailability }>(
      '/api/updates/status',
    ),
  /** Verifies the setup file and returns its path; the shell runs it. */
  prepareMasterUpdate: () =>
    post<{ path: string; manifest: ReleaseManifest }>('/api/updates/master/install', {}),

  // --- Party Access --------------------------------------------------------

  partyAccess: (query: PartyAccessQuery = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.userId) params.set('userId', query.userId);
    if (query.restriction) params.set('restriction', query.restriction);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.offset) params.set('offset', String(query.offset));
    const search = params.toString();
    return request<Paginated<PartyAccessRow>>(`/api/party-access${search ? `?${search}` : ''}`);
  },
  partyAccessPeople: () => request<AssignablePerson[]>('/api/party-access/people'),
  partyAccessFor: (partyId: string) => request<PartyAccessRow>(`/api/party-access/${partyId}`),
  savePartyAccess: (partyId: string, input: PartyAccessInput) =>
    request<PartyAccessRow>(`/api/party-access/${partyId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  partyAccessExportUrl: () => '/api/party-access/export.csv',

  // --- Fields (management surface — the three reads above stay ungated) ----

  fieldsCatalogue: () => request<FieldCatalogue>('/api/fields/catalogue'),
  fieldValues: (
    listKey: string,
    options: { includeDeleted?: boolean; includeUnlisted?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ listKey });
    if (options.includeDeleted) params.set('includeDeleted', 'true');
    if (options.includeUnlisted) params.set('includeUnlisted', 'true');
    return request<{ items: OptionListItem[]; unlisted?: string[] }>(
      `/api/fields/values?${params}`,
    );
  },
  fieldUsage: (listKey: string) =>
    request<FieldUsageBreakdown>(`/api/fields/usage?listKey=${encodeURIComponent(listKey)}`),
  createFieldValue: (input: OptionListItemInput) =>
    post<OptionListItem>('/api/fields/values', input),
  updateFieldValue: (id: string, input: OptionListItemUpdateInput) =>
    request<OptionListItem>(`/api/fields/values/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteFieldValue: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/fields/values/${id}`, { method: 'DELETE' }),
  reorderFieldValues: (input: OptionListReorderInput) =>
    post<OptionListItem[]>('/api/fields/values/reorder', input),

  fieldDefinitions: (options: { entity?: string; includeDeleted?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.entity) params.set('entity', options.entity);
    if (options.includeDeleted) params.set('includeDeleted', 'true');
    const query = params.toString();
    return request<CustomFieldDefinition[]>(`/api/fields/definitions${query ? `?${query}` : ''}`);
  },
  createFieldDefinition: (input: CustomFieldDefinitionInput) =>
    post<CustomFieldDefinition>('/api/fields/definitions', input),
  updateFieldDefinition: (id: string, input: CustomFieldDefinitionUpdateInput) =>
    request<CustomFieldDefinition>(`/api/fields/definitions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteFieldDefinition: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/fields/definitions/${id}`, {
      method: 'DELETE',
    }),
  reorderFieldDefinitions: (input: CustomFieldReorderInput) =>
    post<CustomFieldDefinition[]>('/api/fields/definitions/reorder', input),

  fieldStages: () => request<Pipeline[]>('/api/fields/stages'),
  updateFieldStage: (id: string, input: PipelineStageInput) =>
    request<PipelineStage>(`/api/fields/stages/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  reorderFieldStages: (input: StageReorderInput) =>
    post<PipelineStage[]>('/api/fields/stages/reorder', input),
  archiveFieldStage: (id: string) => post<PipelineStage>(`/api/fields/stages/${id}/archive`),
  restoreFieldStage: (id: string) => post<PipelineStage>(`/api/fields/stages/${id}/restore`),

  search: (term: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(term)}`),

  panels: () => request<{ panels: OfficePanelWithPresence[] }>('/api/panels'),
  openPairingWindow: () => post<{ closesAt: number }>('/api/panels/pairing-window/open'),
  closePairingWindow: () => post<void>('/api/panels/pairing-window/close'),
  revokePanel: (id: string) => post<void>(`/api/panels/${id}/revoke`),
  renamePanel: (id: string, name: string) =>
    request<void>(`/api/panels/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  // --- One panel, administered (docs/UI_REDESIGN.md — Office Panels) --------

  panel: (id: string) => request<OfficePanelDetail>(`/api/panels/${id}`),
  /** Omitted fields are left alone; `notes: null` clears the note. */
  updatePanel: (id: string, input: OfficePanelUpdateInput) =>
    request<OfficePanel>(`/api/panels/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  /** Pulls a fresh account of the panel's machine instead of the last timed one. */
  refreshPanel: (id: string) => post<OfficePanelDetail>(`/api/panels/${id}/refresh`),
  /** The plaintext secret is in this response and nowhere else — there is no second chance. */
  rotatePanelSecret: (id: string) => post<PanelSecretRotation>(`/api/panels/${id}/rotate-secret`),
  setPanelStoragePath: (id: string, input: PanelStoragePathInput) =>
    post<PanelStoragePathResult>(`/api/panels/${id}/storage-path`, input),
  disconnectPanel: (id: string) => post<{ disconnected: boolean }>(`/api/panels/${id}/disconnect`),
  panelActivity: (id: string, limit = 50) =>
    request<{ entries: ActivityLogEntry[] }>(`/api/panels/${id}/activity?limit=${limit}`),

  parties: (search?: string, limit?: number, offset?: number) =>
    request<Paginated<Party>>(`/api/parties${pagedQuery(search, limit, offset)}`),
  createParty: (input: PartyInput) => post<Party>('/api/parties', input),
  /**
   * `baseFieldHlc` is what the form last saw for each field. Sent so the
   * Master's merge can tell an ordinary sequential edit from a real clash
   * against whatever an Office panel changed in the meantime — the same
   * envelope the Office's own `updateParty` sends.
   */
  updateParty: (id: string, input: PartyInput & { baseFieldHlc?: Record<string, string> }) =>
    request<Party>(`/api/parties/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  createProduct: (input: ProductInput) => post<Product>('/api/products', input),

  // Categories — the owner's Products (`docs/catalogue/CATALOGUE_MODEL.md` §5).
  // Read-only here: products are catalogued on the Office Panel, so the
  // Master's `/api/categories` writes have no screen of their own.
  categories: (query: { search?: string; brand?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.brand) params.set('brand', query.brand);
    const qs = params.toString();
    return request<ProductCategoryListRow[]>(`/api/categories${qs ? `?${qs}` : ''}`);
  },

  stock: (options: Omit<StockListQuery, 'offset' | 'scope'> = {}) => {
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.lowOnly) params.set('lowOnly', 'true');
    if (options.brand) params.set('brand', options.brand);
    if (options.categoryId) params.set('categoryId', options.categoryId);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<InventoryStockLevel[]>(`/api/stock${query ? `?${query}` : ''}`);
  },
  /** The ledger, newest first; scoped to one product or one variant when asked. */
  stockMovements: (scope: { productId?: string; variantId?: string } = {}) => {
    const params = new URLSearchParams();
    if (scope.productId) params.set('productId', scope.productId);
    if (scope.variantId) params.set('variantId', scope.variantId);
    const query = params.toString();
    return request<StockMovement[]>(`/api/stock/movements${query ? `?${query}` : ''}`);
  },
  stockInbound: (input: { variantId: string; quantityBoxes: number; note?: string }) =>
    post<InventoryStockLevel>('/api/stock/inbound', input),
  stockAdjust: (input: { variantId: string; quantityBoxes: number; note?: string }) =>
    post<InventoryStockLevel>('/api/stock/adjust', input),
  /**
   * The stock band for one variant.
   *
   * Every level is optional and **absent means untouched** — which is what
   * lets the reorder, min and max cells on one row each save without wiping
   * the others.
   */
  setReorderLevel: (input: {
    variantId: string;
    reorderLevel?: number | null;
    minStockLevel?: number | null;
    maxStockLevel?: number | null;
  }) => post<InventoryStockLevel>('/api/stock/reorder-level', input),

  leads: (
    options: { stageIds?: string[]; includeConverted?: boolean; scope?: PartyScopeFilter } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.stageIds?.length) params.set('stageIds', options.stageIds.join(','));
    if (options.includeConverted) params.set('includeConverted', 'true');
    if (options.scope === 'assigned') params.set('scope', 'assigned');
    const query = params.toString();
    return request<Paginated<Lead>>(`/api/leads${query ? `?${query}` : ''}`);
  },
  lead: (id: string) => request<Lead>(`/api/leads/${id}`),
  setLeadStage: (id: string, stageId: string, remark?: string | null) =>
    post<Lead>(`/api/leads/${id}/stage`, { stageId, remark }),
  addLeadRemark: (id: string, message: string) =>
    post<Lead>(`/api/leads/${id}/remarks`, { message }),
  convertLead: (
    id: string,
    input: { dispatchAddressLabel?: string | null; expectedDispatchDate?: string | null } = {},
  ) => post<Order>(`/api/leads/${id}/convert`, input),

  orders: (options: { stageIds?: string[]; scope?: PartyScopeFilter } = {}) => {
    const params = new URLSearchParams();
    if (options.stageIds?.length) params.set('stageIds', options.stageIds.join(','));
    if (options.scope === 'assigned') params.set('scope', 'assigned');
    const query = params.toString();
    return request<Paginated<Order>>(`/api/orders${query ? `?${query}` : ''}`);
  },
  order: (id: string) => request<Order>(`/api/orders/${id}`),
  updateOrder: (id: string, input: Record<string, unknown>) =>
    request<Order>(`/api/orders/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  setOrderStage: (id: string, stageId: string, remark?: string | null) =>
    post<Order>(`/api/orders/${id}/stage`, { stageId, remark }),
  dispatchOrder: (id: string, note?: string | null) =>
    post<Order>(`/api/orders/${id}/dispatch`, { note }),

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
  /** Omit `password` to have the Master generate one. On an installation that
   *  has not switched the password vault on, this is still the only way an
   *  administrator can tell somebody what their password is: what is stored is
   *  a scrypt hash and nothing reads it back. */
  resetPassword: (id: string, password?: string) =>
    post<OneTimeSecret>(`/api/access/users/${id}/reset-password`, password ? { password } : {}),
  /** Refused unless `security.passwordRevealEnabled` is on, the caller holds
   *  `users.viewPassword`, and they re-type their own password. POST so it
   *  never lands in a URL or a proxy log. */
  revealPassword: (id: string, confirmPassword: string) =>
    post<OneTimeSecret>(`/api/access/users/${id}/reveal-password`, { confirmPassword }),
  changeOwnPassword: (input: ChangeOwnPasswordInput) =>
    post<void>('/api/access/me/password', input),

  /** Sent as-is; the Master squares and resizes it. Your own always; somebody
   *  else's needs `users.manage`. */
  uploadAvatar: (userId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return requestForm<User>(`/api/access/users/${userId}/avatar`, form);
  },
  removeAvatar: (userId: string) =>
    request<User>(`/api/access/users/${userId}/avatar`, { method: 'DELETE' }),

  // --- Settings (docs/overhaul/workstream-F.md §2) -------------------------

  /** Every declared key, with the company's value or a note that it is the
   *  default. A secret comes back as `configured`, never as its value. */
  settings: () => request<SettingView[]>('/api/settings'),
  /** Returns the whole list again, so the screen never re-reads to find out
   *  what its own write did. */
  saveSetting: (key: SettingKey, value: unknown) =>
    request<SettingView[]>(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  /** How many people's passwords are actually recoverable, out of how many
   *  there are. The gap is everyone who has not signed in online since the
   *  feature was switched on. */
  vaultStatus: () => request<VaultStatus>('/api/settings/vault-status'),

  /** One page of a searchable dropdown — see `/api/pick/:kind`. */
  pick: <T>(
    kind: PickKind,
    query: {
      term: string;
      categoryId?: string;
      include?: string[];
      limit?: number;
      signal?: AbortSignal;
    },
  ) => {
    const params = new URLSearchParams({ q: query.term });
    if (query.categoryId) params.set('categoryId', query.categoryId);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.include?.length) params.set('include', query.include.join(','));
    return request<{ items: T[]; truncated: boolean }>(
      `/api/pick/${kind}?${params.toString()}`,
      query.signal ? { signal: query.signal } : undefined,
    );
  },

  conflicts: (includeResolved = false) =>
    request<SyncConflict[]>(`/api/conflicts${includeResolved ? '?includeResolved=true' : ''}`),
  resolveConflict: (id: number, action: 'keepWinner' | 'restoreLoser') =>
    post<SyncConflict>(`/api/conflicts/${id}/resolve`, { action }),

  // --- Recycle Bin (docs/backend-modules/04-API-CONTRACT.md §4) -----------

  deleteParty: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/parties/${id}`, { method: 'DELETE' }),
  deleteProduct: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/products/${id}`, { method: 'DELETE' }),
  deleteLead: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/leads/${id}`, { method: 'DELETE' }),
  deleteOrder: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/orders/${id}`, { method: 'DELETE' }),

  recycleBin: (query: RecycleBinQuery = {}) => {
    const params = new URLSearchParams();
    if (query.types?.length) params.set('types', query.types.join(','));
    if (query.search) params.set('search', query.search);
    if (query.deletedBy) params.set('deletedBy', query.deletedBy);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return request<CursorPage<BinEntry>>(`/api/recycle-bin${qs ? `?${qs}` : ''}`);
  },
  recycleBinCounts: () => request<BinCounts>('/api/recycle-bin/counts'),
  /** Everybody who has deleted something still in the Bin — a facet over the
   *  whole Bin, not over the page in front of you. */
  recycleBinDeleters: () =>
    request<Array<{ id: string; name: string }>>('/api/recycle-bin/deleters'),
  restoreFromBin: (input: RestoreInput) =>
    post<BinRestoreResult>('/api/recycle-bin/restore', input),

  // --- Logs (docs/backend-modules/04-API-CONTRACT.md §2) --------------------

  logs: (query: ActivityLogQuery = {}) => {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.direction) params.set('direction', query.direction);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.actorType) params.set('actorType', query.actorType);
    if (query.actorId) params.set('actorId', query.actorId);
    if (query.entityType) params.set('entityType', query.entityType);
    if (query.action) params.set('action', query.action);
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    if (query.q) params.set('q', query.q);
    const qs = params.toString();
    return request<CursorPage<ActivityLogEntry>>(`/api/logs${qs ? `?${qs}` : ''}`);
  },
  logFacets: (range: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    const qs = params.toString();
    return request<ActivityLogFacets>(`/api/logs/facets${qs ? `?${qs}` : ''}`);
  },
  verifyLogChain: (input: ChainVerifyInput = {}) =>
    post<ChainVerification>('/api/logs/verify', input),
  logsExportUrl: (query: ActivityLogQuery = {}) => {
    const params = new URLSearchParams();
    if (query.actorType) params.set('actorType', query.actorType);
    if (query.actorId) params.set('actorId', query.actorId);
    if (query.entityType) params.set('entityType', query.entityType);
    if (query.action) params.set('action', query.action);
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    if (query.q) params.set('q', query.q);
    const qs = params.toString();
    return `/api/logs/export${qs ? `?${qs}` : ''}`;
  },

  // --- Reports (docs/backend-modules/04-API-CONTRACT.md §3) -----------------

  reportRangeQuery: (input: ReportRangeInput = {}) => {
    const params = new URLSearchParams();
    if (input.period) params.set('period', input.period);
    if (input.fromMonth) params.set('fromMonth', input.fromMonth);
    if (input.toMonth) params.set('toMonth', input.toMonth);
    return params;
  },
  dispatchReport: (input: ReportRangeInput = {}) =>
    request<DispatchesReport>(`/api/reports/dispatches?${api.reportRangeQuery(input)}`),
  leadOutcomeReport: (input: ReportRangeInput = {}) =>
    request<LeadOutcomesReport>(`/api/reports/lead-outcomes?${api.reportRangeQuery(input)}`),
  topPartiesReport: (input: ReportRangeInput & { limit?: number } = {}) => {
    const params = api.reportRangeQuery(input);
    if (input.limit) params.set('limit', String(input.limit));
    return request<TopPartiesReport>(`/api/reports/top-parties?${params}`);
  },
  reportExportUrl: (kind: ReportKind, input: ReportRangeInput & { limit?: number } = {}) => {
    const params = api.reportRangeQuery(input);
    if (input.limit) params.set('limit', String(input.limit));
    const qs = params.toString();
    return `/api/reports/${kind}/export${qs ? `?${qs}` : ''}`;
  },

  // --- Integrations (Stage 11) ---------------------------------------------

  apiKeys: () => request<ApiKey[]>('/api/integrations/keys'),
  /** The only call that ever sees a token. It is not stored anywhere else. */
  issueApiKey: (input: ApiKeyInput) =>
    post<{ key: ApiKey; token: string }>('/api/integrations/keys', input),
  revokeApiKey: (id: string) => post<ApiKey>(`/api/integrations/keys/${id}/revoke`),

  connectors: () => request<Connector[]>('/api/integrations/connectors'),
  connectorProfiles: () => request<ConnectorProfile[]>('/api/integrations/connectors/profiles'),
  createConnector: (input: ConnectorInput & { fromProfile?: string }) =>
    post<Connector>('/api/integrations/connectors', input),
  updateConnector: (id: string, input: ConnectorInput) =>
    request<Connector>(`/api/integrations/connectors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteConnector: (id: string) =>
    request<void>(`/api/integrations/connectors/${id}`, { method: 'DELETE' }),
  setConnectorMapping: (
    id: string,
    resources: Array<ConnectorResourceInput & { fieldMaps: ConnectorFieldMapInput[] }>,
  ) =>
    request<Connector>(`/api/integrations/connectors/${id}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({ resources }),
    }),
  testConnector: (id: string, entity: 'party' | 'product') =>
    post<ConnectorTestResult>(`/api/integrations/connectors/${id}/test`, { entity }),
  runConnector: (id: string, mode: 'dry_run' | 'import') =>
    post<ConnectorRun & { runId: number }>(`/api/integrations/connectors/${id}/run`, { mode }),
  connectorRuns: (id: string) => request<ConnectorRun[]>(`/api/integrations/connectors/${id}/runs`),

  // --- Developer mode (`shared/src/domain/developer.ts`) --------------------
  // The unlock token rides in a header, never in the path: these URLs reach
  // the activity log and the shell's console, and a token written down there
  // outlives the fifteen minutes it is supposed to live.
  developer: {
    status: (token: string | null) =>
      request<DeveloperStatus>('/api/developer/status', {
        headers: token ? { [DEVELOPER_TOKEN_HEADER]: token } : undefined,
      }),
    unlock: (password: string) => post<DeveloperUnlock>('/api/developer/unlock', { password }),
    lock: (token: string) => postAsDeveloper<{ ok: true }>('/api/developer/lock', token),
    resetAll: (token: string) =>
      postAsDeveloper<ResetAllResult>('/api/developer/reset-all', token, {
        confirmation: DEVELOPER_RESET_CONFIRMATION,
      }),
    seedDummyUsers: (token: string) =>
      postAsDeveloper<SeedDummyUsersResult>('/api/developer/seed-dummy-users', token),
    seedSampleData: (token: string) =>
      postAsDeveloper<SeedSampleDataResult>('/api/developer/seed-sample-data', token),
    loadSwiswareCatalogue: (token: string) =>
      postAsDeveloper<LoadCatalogueResult>('/api/developer/load-catalogue', token),
  },
};
