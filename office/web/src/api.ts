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
  CustomFieldDefinition,
  CustomFieldDefinitionInput,
  CustomFieldDefinitionUpdateInput,
  CustomFieldReorderInput,
  FieldCatalogue,
  FieldUsageBreakdown,
  LeadInput,
  LeadUpdateInput,
  MessageKey,
  MessageParams,
  MutationResult,
  OptionListItem,
  OptionListItemInput,
  OptionListItemUpdateInput,
  OptionListReorderInput,
  PartyInput,
  PartyProductVariantInput,
  Pipeline,
  PipelineStage,
  PipelineStageInput,
  ProductInput,
  SearchHit,
  StageReorderInput,
  SyncConflict,
  SyncSnapshot,
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

  session: () => request<{ session: PanelSession | null }>('/api/session'),
  signIn: (username: string, password: string) =>
    post<{ session: PanelSession }>('/api/auth/sign-in', { username, password }),
  signOut: () => post<{ ok: true }>('/api/auth/sign-out'),

  snapshot: () => request<LocalView>('/api/snapshot'),
  syncState: () => request<SyncState>('/api/sync'),
  flush: () => post<FlushOutcome>('/api/sync/flush'),

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

  // Fields, forwarded live like stock and search — a curated list is
  // company-wide configuration with no field-level merge to fall back on
  // (option_lists/custom_field_definitions carry no hlc/field_hlc), so it
  // fails hard (503) rather than queuing offline.
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
};
