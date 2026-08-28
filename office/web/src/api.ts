/**
 * The Office Panel's local API.
 *
 * Note what the write methods return: `QueuedResult`, not the saved record.
 * Every write is queued in this panel's outbox and answered immediately, so the
 * browser learns the record's (temporary) id and moves on — the real record
 * arrives moments later through the event stream. That asymmetry is the whole
 * offline story, and it is deliberately visible in these types rather than
 * hidden behind an optimistic fake.
 */

import type {
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
  CursorPage,
  CustomFieldDefinition,
  CustomFieldDefinitionInput,
  CustomFieldDefinitionUpdateInput,
  CustomFieldReorderInput,
  DashboardSummary,
  DispatchesReport,
  FieldCatalogue,
  FieldUsageBreakdown,
  LeadInput,
  LeadOutcomesReport,
  LeadUpdateInput,
  MessageKey,
  MessageParams,
  MutationResult,
  OptionListItem,
  OptionListItemInput,
  OptionListItemUpdateInput,
  OptionListReorderInput,
  Paginated,
  AssignablePerson,
  PartyAccessInput,
  PartyAccessQuery,
  PartyAccessRow,
  ReleaseManifest,
  UpdateAvailability,
  PartyInput,
  PartyProductVariantInput,
  Pipeline,
  PipelineStage,
  PipelineStageInput,
  Product,
  ProductImageUpdateInput,
  ProductInput,
  RecycleBinQuery,
  DocumentAsset,
  DocumentAssetInput,
  DocumentExport,
  DocumentExportQuery,
  DocumentRenderResult,
  DocumentTemplate,
  DocumentTemplateInput,
  DocumentTemplateQuery,
  PreviewDocumentInput,
  RenderDocumentInput,
  ReportKind,
  ReportRangeInput,
  RestoreInput,
  SearchHit,
  StageReorderInput,
  SyncConflict,
  SyncSnapshot,
  TopPartiesReport,
} from '@orderbook/shared';

/**
 * Mirrors `master/web/src/api.ts`'s `ApiError` — the Office is the primary
 * Hindi consumer, so it needs the same `code`/`details`/`messageKey`/`params`
 * a screen can act on, not a bare `Error` whose only content is an English
 * sentence the Master or this panel's own server happened to compose.
 */
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

  get missingPermission(): string | undefined {
    return typeof this.details.permission === 'string' ? this.details.permission : undefined;
  }

  /**
   * Mirrors `master/web/src/api.ts`'s getter of the same name.
   *
   * Its absence here was the only reason a screen shared by both panels had to
   * spell the same check two different ways — which is exactly the kind of
   * divergence that makes the next edit to one copy miss the other.
   */
  get isConflict(): boolean {
    return this.code === 'conflict';
  }
}

export interface ConnectionInfo {
  hasNetworkLink: boolean;
  interfaces: Array<{ name: string; address: string; broadcastAddress: string }>;
  isPaired: boolean;
  panelName: string;
  state: 'unpaired' | 'connecting' | 'connected' | 'disconnected';
  masterHost: string | null;
  masterPort: number | null;
  companyName: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  /** What the Master reported in its last snapshot; null until one arrives. */
  masterVersion: string | null;
}

export interface DiscoveredMaster {
  masterUniqueId: string;
  companyName: string | null;
  lanIp: string;
  httpPort: number;
  acceptingPairing: boolean;
}

/** The panel's view: the Master's snapshot plus anything still queued here. */
export type LocalView = SyncSnapshot & { pendingCount: number };

/** Who is signed in on this panel. Held by the panel's server, not the browser. */
export interface PanelSession {
  userId: string;
  username: string;
  displayName: string;
  roleId: string | null;
  roleName: string;
  roleTier: string;
  permissions: string[];
  /**
   * True when the Master was unreachable at sign-in, so these permissions are
   * the set cached at the last online sign-in rather than a fresh read.
   */
  offline: boolean;
  signedInAt: string;
}

export interface QueuedResult {
  queued: true;
  /** Temporary id for a create, or the id passed in for an edit. */
  id: string;
  mutationId: string;
  pendingCount: number;
}

export interface SyncState extends ConnectionInfo {
  pendingCount: number;
  rejections: MutationResult[];
}

export interface FlushOutcome {
  pushed: number;
  applied: number;
  merged: number;
  rejected: number;
  rejections: MutationResult[];
  remaining: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body as
      | {
          error?: string;
          message?: string;
          details?: Record<string, unknown>;
          messageKey?: MessageKey;
          params?: MessageParams;
        }
      | null;

    throw new ApiError(
      detail?.message ?? 'Request failed',
      detail?.error ?? 'internal_error',
      detail?.details ?? {},
      detail?.messageKey,
      detail?.params,
    );
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });

const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

/** No JSON `Content-Type` here — the browser sets the multipart boundary itself. */
async function postFile<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body as { error?: string; message?: string; details?: Record<string, unknown> } | null;
    throw new ApiError(detail?.message ?? 'Request failed', detail?.error ?? 'internal_error', detail?.details ?? {});
  }
  return body as T;
}

/** A binary download, for storage export — the response is the file itself, not JSON. */
async function postForBlob(path: string, body: unknown): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { error?: string; message?: string; details?: Record<string, unknown> }
      | null;
    throw new ApiError(detail?.message ?? 'Request failed', detail?.error ?? 'internal_error', detail?.details ?? {});
  }
  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
  return { blob: await response.blob(), fileName: match?.[1] ?? 'orderbook-backup.obbackup' };
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
  connection: () => request<ConnectionInfo>('/api/connection'),
  scan: () => post<{ masters: DiscoveredMaster[] }>('/api/connection/scan'),
  pairAuto: (panelName?: string) =>
    post<{ ok: true; companyName: string | null }>('/api/connection/pair/auto', { panelName }),
  pairManual: (input: {
    host: string;
    port: number;
    pairingPassword: string;
    masterUniqueId?: string;
    panelName?: string;
  }) => post<{ ok: true; companyName: string | null }>('/api/connection/pair/manual', input),

  previewRestoreConnection: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postFile<BackupRestorePreview>('/api/connection/restore/preview', form);
  },
  restoreConnection: (file: File, passphrase: string, confirmWipe: boolean) => {
    const form = new FormData();
    form.append('file', file);
    form.append('passphrase', passphrase);
    form.append('confirmWipe', String(confirmWipe));
    return postFile<{ manifest: BackupManifest }>('/api/connection/restore', form);
  },

  session: () => request<{ session: PanelSession | null }>('/api/session'),
  signIn: (username: string, password: string) =>
    post<{ session: PanelSession }>('/api/auth/sign-in', { username, password }),
  signOut: () => post<{ ok: true }>('/api/auth/sign-out'),

  snapshot: () => request<LocalView>('/api/snapshot'),
  syncState: () => request<SyncState>('/api/sync'),
  flush: () => post<FlushOutcome>('/api/sync/flush'),

  exportStorage: (officeScope: 'settings-only' | 'full-replica', passphrase: string) =>
    postForBlob('/api/storage/export', {
      scope: officeScope === 'full-replica' ? 'whole' : 'selected',
      officeScope,
      passphrase,
    }),
  previewRestoreStorage: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postFile<BackupRestorePreview>('/api/storage/restore/preview', form);
  },
  restoreStorage: (file: File, passphrase: string, confirmWipe: boolean) => {
    const form = new FormData();
    form.append('file', file);
    form.append('passphrase', passphrase);
    form.append('confirmWipe', String(confirmWipe));
    return postFile<{ manifest: BackupManifest }>('/api/storage/restore', form);
  },

  createParty: (input: PartyInput) => post<QueuedResult>('/api/parties', input),
  updateParty: (id: string, input: PartyInput) => put<QueuedResult>(`/api/parties/${id}`, input),

  createProduct: (input: ProductInput) => post<QueuedResult>('/api/products', input),
  updateProduct: (id: string, input: ProductInput) =>
    put<QueuedResult>(`/api/products/${id}`, input),

  upsertVariant: (input: PartyProductVariantInput) =>
    post<QueuedResult>('/api/party-variants', input),

  createLead: (input: LeadInput) => post<QueuedResult>('/api/leads', input),
  updateLead: (id: string, input: LeadUpdateInput) => put<QueuedResult>(`/api/leads/${id}`, input),
  setLeadStage: (id: string, stageId: string, remark?: string | null) =>
    post<QueuedResult>(`/api/leads/${id}/stage`, { stageId, remark }),
  addLeadRemark: (id: string, message: string) =>
    post<QueuedResult>(`/api/leads/${id}/remarks`, { message }),
  convertLead: (
    id: string,
    input: { dispatchAddressLabel?: string | null; expectedDispatchDate?: string | null } = {},
  ) => post<QueuedResult>(`/api/leads/${id}/convert`, input),

  setOrderStage: (id: string, stageId: string, remark?: string | null) =>
    post<QueuedResult>(`/api/orders/${id}/stage`, { stageId, remark }),
  updateOrder: (id: string, input: Record<string, unknown>) =>
    put<QueuedResult>(`/api/orders/${id}`, input),
  dispatchOrder: (id: string, note?: string | null) =>
    post<QueuedResult>(`/api/orders/${id}/dispatch`, { note }),

  // Stock and search need the Master, so these still fail when it is offline —
  // which is correct: a stale stock figure presented as current is worse than
  // an honest "cannot reach the Master right now".
  stockInbound: (input: { productId: string; colour: string; quantityBoxes: number; note?: string }) =>
    post('/api/stock/inbound', input),
  stockAdjust: (input: { productId: string; colour: string; quantityBoxes: number; note?: string }) =>
    post('/api/stock/adjust', input),

  search: (term: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(term)}`),

  conflicts: () => request<SyncConflict[]>('/api/conflicts'),
  resolveConflict: (id: number, action: 'keepWinner' | 'restoreLoser') =>
    post<SyncConflict>(`/api/conflicts/${id}/resolve`, { action }),

  // --- Recycle Bin (docs/backend-modules/04-API-CONTRACT.md §4) -----------
  // Master-online-only, like every delete/restore path — fails hard (503)
  // rather than queueing, so a delete never applies later against data that
  // has since changed underneath it.

  deleteParty: (id: string) => request<{ id: string; deletedAt: string }>(`/api/parties/${id}`, { method: 'DELETE' }),
  deleteProduct: (id: string) => request<{ id: string; deletedAt: string }>(`/api/products/${id}`, { method: 'DELETE' }),
  deleteLead: (id: string) => request<{ id: string; deletedAt: string }>(`/api/leads/${id}`, { method: 'DELETE' }),
  deleteOrder: (id: string) => request<{ id: string; deletedAt: string }>(`/api/orders/${id}`, { method: 'DELETE' }),

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
  restoreFromBin: (input: RestoreInput) => post<BinRestoreResult>('/api/recycle-bin/restore', input),

  // --- App update ----------------------------------------------------------

  updateAvailable: () => request<UpdateAvailability>('/api/updates/available'),
  /** Downloads from the Master and checksums it; the shell runs it. */
  downloadUpdate: () =>
    post<{ path: string; manifest: ReleaseManifest }>('/api/updates/download', {}),

  // --- Party Access --------------------------------------------------------
  // Reachable from both panels, gated on admin tier. Forwarded live and failing
  // 503 offline, like Fields below.

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
  partyAccessExportUrl: () => '/api/party-access/export.csv',
  savePartyAccess: (partyId: string, input: PartyAccessInput) =>
    put<PartyAccessRow>(`/api/party-access/${partyId}`, input),

  // --- Fields (docs/backend-modules/04-API-CONTRACT.md §5) -----------------
  // Reachable from both panels per the owner's decision — forwarded live,
  // failing hard (503) offline like every other module in this batch: a
  // curated list is company-wide configuration with no field-level merge to
  // fall back on (option_lists/custom_field_definitions carry no hlc/field_hlc).

  fieldsCatalogue: () => request<FieldCatalogue>('/api/fields/catalogue'),
  fieldValues: (listKey: string, options: { includeDeleted?: boolean; includeUnlisted?: boolean } = {}) => {
    const params = new URLSearchParams({ listKey });
    if (options.includeDeleted) params.set('includeDeleted', 'true');
    if (options.includeUnlisted) params.set('includeUnlisted', 'true');
    return request<{ items: OptionListItem[]; unlisted?: string[] }>(`/api/fields/values?${params}`);
  },
  fieldUsage: (listKey: string) =>
    request<FieldUsageBreakdown>(`/api/fields/usage?listKey=${encodeURIComponent(listKey)}`),
  createFieldValue: (input: OptionListItemInput) => post<OptionListItem>('/api/fields/values', input),
  updateFieldValue: (id: string, input: OptionListItemUpdateInput) =>
    put<OptionListItem>(`/api/fields/values/${id}`, input),
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
    put<CustomFieldDefinition>(`/api/fields/definitions/${id}`, input),
  deleteFieldDefinition: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/fields/definitions/${id}`, { method: 'DELETE' }),
  reorderFieldDefinitions: (input: CustomFieldReorderInput) =>
    post<CustomFieldDefinition[]>('/api/fields/definitions/reorder', input),

  fieldStages: () => request<Pipeline[]>('/api/fields/stages'),
  updateFieldStage: (id: string, input: PipelineStageInput) =>
    put<PipelineStage>(`/api/fields/stages/${id}`, input),
  reorderFieldStages: (input: StageReorderInput) => post<PipelineStage[]>('/api/fields/stages/reorder', input),
  archiveFieldStage: (id: string) => post<PipelineStage>(`/api/fields/stages/${id}/archive`),
  restoreFieldStage: (id: string) => post<PipelineStage>(`/api/fields/stages/${id}/restore`),

  // --- Logs (docs/backend-modules/04-API-CONTRACT.md §2) --------------------
  // Reachable from both panels — forwarded live, failing hard (503) offline
  // like every other module in this batch.

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
  verifyLogChain: (input: ChainVerifyInput = {}) => post<ChainVerification>('/api/logs/verify', input),
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

  // --- PDF Designer (docs/backend-modules/04-API-CONTRACT.md §6) ----------
  // Online-only. `render` answers with metadata and the browser then fetches
  // the file from `downloadPath`, so a retry does not re-render and the exact
  // bytes a customer received stay addressable.
  documentTemplates: (query: DocumentTemplateQuery = {}) => {
    const params = new URLSearchParams();
    if (query.documentType) params.set('documentType', query.documentType);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return request<CursorPage<DocumentTemplate>>(`/api/documents/templates${qs ? `?${qs}` : ''}`);
  },
  documentTemplate: (id: string) => request<DocumentTemplate>(`/api/documents/templates/${id}`),
  createDocumentTemplate: (input: DocumentTemplateInput) =>
    post<DocumentTemplate>('/api/documents/templates', input),
  updateDocumentTemplate: (id: string, input: DocumentTemplateInput & { expectedVersion: number }) =>
    put<DocumentTemplate>(`/api/documents/templates/${id}`, input),
  deleteDocumentTemplate: (id: string, expectedVersion: number) =>
    request<{ id: string; deletedAt: string }>(`/api/documents/templates/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedVersion }),
    }),
  restoreDocumentTemplate: (id: string) =>
    post<DocumentTemplate>(`/api/documents/templates/${id}/restore`),

  documentAssets: () => request<DocumentAsset[]>('/api/documents/assets'),
  uploadDocumentAsset: (input: DocumentAssetInput) =>
    post<DocumentAsset>('/api/documents/assets', input),
  documentAssetUrl: (id: string) => `/api/documents/assets/${id}/file`,

  renderDocument: (input: RenderDocumentInput) =>
    post<DocumentRenderResult>('/api/documents/render', input),
  /** The preview is bytes, not JSON — the caller turns it into an object URL. */
  previewDocument: async (input: PreviewDocumentInput): Promise<Blob> => {
    const response = await fetch('/api/documents/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as
        | { error?: string; message?: string; details?: Record<string, unknown> }
        | null;
      throw new ApiError(
        detail?.message ?? 'Preview failed',
        detail?.error ?? 'internal_error',
        detail?.details ?? {},
      );
    }
    return response.blob();
  },

  documentExports: (query: DocumentExportQuery = {}) => {
    const params = new URLSearchParams();
    if (query.subjectKind) params.set('subjectKind', query.subjectKind);
    if (query.subjectId) params.set('subjectId', query.subjectId);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return request<CursorPage<DocumentExport>>(`/api/documents/exports${qs ? `?${qs}` : ''}`);
  },
  documentExport: (id: string) => request<DocumentExport>(`/api/documents/exports/${id}`),
  documentExportUrl: (id: string) => `/api/documents/exports/${id}/file`,

  // --- Dashboard (docs/backend-modules/04-API-CONTRACT.md §7.2) ------------
  // The one live pull — everything else rides on `snapshot().dashboard` and
  // the SSE `snapshot` event this panel already re-sends on every change.
  refreshDashboard: () => post<DashboardSummary>('/api/dashboard/refresh'),

  // --- Product images (7-IMAGE-PIPELINE.md) --------------------------------
  // Online-only like Stock and Recycle Bin, and — unlike every write above —
  // answered with the full `Product` rather than a `QueuedResult`: nothing
  // here goes through the offline outbox, so there is no temporary id to
  // hand back, only the real record the Master just produced.
  uploadProductImage: (
    productId: string,
    file: Blob,
    crop: { cropX: number; cropY: number; cropWidth: number; cropHeight: number; rotationDeg: number; caption?: string | null },
  ) => {
    const form = new FormData();
    form.set('file', file, 'image');
    form.set('cropX', String(crop.cropX));
    form.set('cropY', String(crop.cropY));
    form.set('cropWidth', String(crop.cropWidth));
    form.set('cropHeight', String(crop.cropHeight));
    form.set('rotationDeg', String(crop.rotationDeg));
    if (crop.caption) form.set('caption', crop.caption);
    return postFile<Product>(`/api/products/${productId}/images`, form);
  },
  updateProductImage: (productId: string, imageId: string, input: ProductImageUpdateInput) =>
    patch<Product>(`/api/products/${productId}/images/${imageId}`, input),
  reorderProductImages: (productId: string, ids: string[]) =>
    post<Product>(`/api/products/${productId}/images/reorder`, { ids }),
  deleteProductImage: (productId: string, imageId: string) =>
    request<Product>(`/api/products/${productId}/images/${imageId}`, { method: 'DELETE' }),
};
