/** Thin wrapper over the Master's local HTTP API. */

import {
  anySignal,
  createRequestCache,
  isCacheableRead,
  publishSessionEnded,
  t,
  trackLoad,
  type LeadEntryView,
} from '@orderbook/ui';
import type {
  PickKind,
  DuplicateReport,
  DuplicateResolveInput,
  DuplicateResolveResult,
  ChatAccessCapability,
  PrintJob,
  PrintJobInput,
  PrintJobPage,
  PrintJobQuery,
  PrintJobSummary,
  PrintStation,
  PrintStationInput,
  ChatMemberRole,
  ChatMessage,
  ChatPerson,
  ChatPostInput,
  ChatRoomDetail,
  ChatRoomInput,
  ChatRoomPatch,
  ChatRoomSummary,
  ChatSearchHit,
  ChatTaskRow,
  ActivityLogEntry,
  DesktopBridge,
  ActivityLogFacets,
  ActivityLogQuery,
  ArchiveListEntry,
  ArchivePreview,
  AutoBackupConfig,
  AutoBackupStatus,
  BackupJobStatus,
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
  ApiKey,
  ApiKeyInput,
  Connector,
  ConnectorFieldMapInput,
  ConnectorInput,
  ConnectorResourceInput,
  ConnectorRun,
  ConnectorTestResult,
  FieldCatalogue,
  FieldUsageBreakdown,
  Lead,
  LeadInput,
  LeadUpdateInput,
  MasterIdentity,
  MasterKeyUnlock,
  MessageKey,
  MessageParams,
  UserNotification,
  BoardPresence,
  PresenceBeat,
  PresenceRecordKind,
  RecordPresence,
  OfficePanelDetail,
  OfficePanelWithPresence,
  PairingWindowState,
  PanelSecretRotation,
  OptionListItem,
  OptionListItemInput,
  OptionListItemUpdateInput,
  OptionListReorderInput,
  Order,
  Notice,
  NoticeBoard,
  NoticeInput,
  NoticeReaders,
  NoticeUpdate,
  Paginated,
  StageCounts,
  Party,
  AssignablePerson,
  PartyAccessInput,
  PartyAccessQuery,
  PartyAccessRow,
  PartyAccessSummary,
  ReleaseManifest,
  AutoUpdateConfig,
  AutoUpdateStatus,
  UpdateStatusResponse,
  PartyScopeFilter,
  PartyInput,
  PartyProductVariant,
  Pipeline,
  PipelineStage,
  PipelineStageInput,
  OneTimeSecret,
  PermissionCatalogue,
  CategoryInput,
  CategoryUpdateInput,
  Product,
  ProductCategory,
  ProductCategoryListRow,
  ProductImageUpdateInput,
  PartyImportFormat,
  PartyImportMode,
  PartyImportResult,
  ProductImportFormat,
  ProductImportMode,
  ProductImportResult,
  ProductInput,
  ProductListPage,
  ProductListQuery,
  RecycleBinQuery,
  ReportFormat,
  ReportKind,
  ReportOptions,
  ReportQuery,
  ReportTable,
  RestoreInput,
  Role,
  SettingKey,
  SettingView,
  RoleInput,
  SearchHit,
  ServerMasterAccount,
  ServerMasterAccountInput,
  StageReorderInput,
  StorageUsage,
  SignedInUser,
  SyncConflict,
  User,
  VaultStatus,
  UserInput,
  UserUpdateInput,
  DeviceInfo,
} from '@orderbook/shared';
import { MASTER_KEY_TOKEN_HEADER, reportQueryParams } from '@orderbook/shared';

/** A field a stale save disagrees with the server about. */
export interface FieldDifference {
  stored: unknown;
  incoming: unknown;
}

/** The caller's own grant on a party; null = open to them (no grant of theirs). */
export type PartyMyAccess = 'view' | 'manage' | null;

/** A party list row: the party plus its own-record count and the caller's own access. */
export type PartyListRow = Party & {
  recordCount?: number;
  myAccess?: PartyMyAccess;
  /** People holding a grant on it: 0 = open to everyone, 1 = private to its one holder. Absent from an older Master. */
  accessCount?: number;
};

/** One party with the caller's own access to it. */
export type PartyDetailRecord = Party & { myAccess?: PartyMyAccess };

/** A party's own record; `catalogueName` is null when the product is gone or not the caller's to read. */
export type PartyRecord = PartyProductVariant & { catalogueName: string | null };

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
 * The shared read cache of this panel (`ui/src/requestCache.ts`). The shell switches it on while its change
 * feed is up and calls `invalidateReads()` on every change event; `request()` below invalidates it after
 * every write. Exported for the shell and for tests.
 */
export const requestCache = createRequestCache();

export function invalidateReads(): void {
  requestCache.invalidate();
}

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
     * A refused sign-in is the exception: nobody was signed in, and the screen
     * already says why under the password box. Announcing it as well showed the
     * refusal twice, the second time as a banner with its `{count}` unfilled. So is the
     * boot-time `me` check: a 401 there means nobody has signed in yet, not that a session
     * ended, and it put "Not signed in" above a fresh sign-in form.
     */
    if (response.status === 401 && !path.endsWith('/sign-in') && path !== '/api/auth/me' && !MASTER_KEY_REFUSALS.has(detail?.messageKey ?? '')) {
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

/**
 * 401s about the master key, not the session: a wrong key, or a token that is
 * missing or has run out. The person is still signed in and the dialog asks
 * again, so these must not sign the window out.
 */
const MASTER_KEY_REFUSALS: ReadonlySet<string> = new Set([
  'error.unauthorized.masterKey',
  'error.unauthorized.masterKeyRequired',
]);

/** The master-key token as a request header, when there is one. */
function masterKeyHeader(token: string | undefined): Record<string, string> | undefined {
  return token ? { [MASTER_KEY_TOKEN_HEADER]: token } : undefined;
}

/** Every JSON call: counted by the loading strip along the top (`trackLoad`) until it settles. */
function request<T>(path: string, init?: RequestInit): Promise<T> {
  return trackLoad(requestUntracked<T>(path, init));
}

function requestUntracked<T>(path: string, init?: RequestInit): Promise<T> {
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
    const own = init?.signal ? anySignal([init.signal, timeout]) : timeout;
    const sent = send<T>(path, init, own).catch(asFailure);
    // A write (or a read that opted out) may change what cached lists say: the next read asks again.
    // Settled either way: a failed write can still have landed.
    if (method !== 'GET') void sent.then(invalidateReads, invalidateReads);
    return sent;
  }

  // A read of company data: answered from the shared cache while it is fresh (`requestCache`).
  if (!init?.headers && isCacheableRead(path)) {
    return requestCache.get(path, () => sharedRead<T>(path, init, timeout, asFailure));
  }
  return sharedRead<T>(path, init, timeout, asFailure);
}

/** One network read, shared by every caller asking the same question at the same time. */
function sharedRead<T>(
  path: string,
  init: RequestInit | undefined,
  timeout: AbortSignal,
  asFailure: (error: unknown) => never,
): Promise<T> {

  /*
   * The dedupe key is the path *plus* whatever headers the caller set. A GET
   * carrying `x-developer-token` is a different question from the same GET
   * without one, and sharing the two would answer "still locked" to the status
   * call made immediately after an unlock. (No screen sends the header now: the
   * /api/developer/load-catalogue route has had no screen since 5a32106.)
   */
  const key = init?.headers ? JSON.stringify([path, init.headers]) : path;

  let entry = inFlight.get(key);

  if (!entry) {
    const controller = new AbortController();
    const created = {
      controller,
      waiters: 0,
      promise: send<unknown>(path, init, anySignal([controller.signal, timeout])),
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
 * helper serves today — leads and orders the same. So a
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

/** Extracts `ApiError` from a non-JSON (or empty) failure body, for the two `fetch` helpers below. */
async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  const detail = body as {
    error?: string;
    message?: string;
    details?: Record<string, unknown>;
    messageKey?: MessageKey;
    params?: MessageParams;
  } | null;
  throw new ApiError(
    detail?.message ?? t('error.requestFailed'),
    detail?.error ?? 'internal_error',
    detail?.details ?? {},
    detail?.messageKey,
    detail?.params,
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

/** A binary download by GET, for the product import template — the response is the file itself. */
async function requestFile(
  path: string,
  fallbackName: string,
  init: RequestInit = {},
): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  await throwIfNotOk(response);

  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
  return { blob: await response.blob(), fileName: match?.[1] ?? fallbackName };
}

/** A multipart upload, for storage restore — the backup file rides as form data, not JSON. */
async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin' });
  await throwIfNotOk(response);
  return (await response.json()) as T;
}

/** What first-run setup answers: the two Server Masters it made, and how panels pair. */
export interface FirstRunCredentials {
  masterUniqueId: string;
  accounts: Array<{ username: string; displayName: string }>;
  pairingPassword: string;
  lanIps: string[];
  port: number;
}

/** `/api/setup/status`. The last two fields are absent on a Master older than 1.3. */
export interface SetupStatus {
  setupComplete: boolean;
  companyName?: string | null;
  /** This browser is on the Master PC itself (loopback). */
  onMasterPc?: boolean;
  /** Fewer than two active Server Masters exist; the master-key setup flow comes first. */
  serverMasterSetupNeeded?: boolean;
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
  /** The PC the Master runs on (memory, processors), for the sign-in warning. */
  device: () => request<DeviceInfo>('/api/device'),
  /** `companyName` once set up: the footer shows it (already public through discovery). */
  setupStatus: () => request<SetupStatus>('/api/setup/status'),
  /** Master PC only. Creates the two Server Masters the owner typed, and no admin. */
  initialize: (companyName: string, accounts: ServerMasterAccountInput[]) =>
    post<FirstRunCredentials>('/api/setup/initialize', { companyName, accounts }),
  /** A Server Master on the Master PC, with the master key. The new password is shown once. */
  changePairingPassword: (masterKeyToken: string) =>
    request<{ pairingPassword: string }>('/api/setup/pairing-password', {
      method: 'POST',
      headers: masterKeyHeader(masterKeyToken),
    }),

  // --- Master key (Master PC only; docs/MASTER_KEY.md) ----------------------

  /** A correct key buys a five-minute token; five wrong ones lock the gate for a minute. */
  verifyMasterKey: (key: string) => post<MasterKeyUnlock>('/api/master-key/verify', { key }),
  serverMasters: (masterKeyToken: string) =>
    request<{ accounts: ServerMasterAccount[]; needed: number }>(
      '/api/master-key/server-masters',
      { headers: masterKeyHeader(masterKeyToken) },
    ),
  /** The upgrade flow: exactly the missing Server Masters, before anyone signs in. */
  setUpServerMasters: (accounts: ServerMasterAccountInput[], masterKeyToken: string) =>
    request<{ accounts: Array<{ id: string; username: string; displayName: string }> }>(
      '/api/master-key/server-masters',
      {
        method: 'POST',
        body: JSON.stringify({ accounts }),
        headers: masterKeyHeader(masterKeyToken),
      },
    ),
  /** "Forgot Server Master password?": the password only, never the username. */
  recoverServerMaster: (userId: string, newPassword: string, masterKeyToken: string) =>
    request<void>('/api/master-key/recover', {
      method: 'POST',
      body: JSON.stringify({ userId, newPassword }),
      headers: masterKeyHeader(masterKeyToken),
    }),
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

  /** Magic restore at first run: a backup-everything zip on this PC, by path. */
  setupPreviewArchive: (path: string) =>
    post<ArchivePreview>('/api/setup/archive/preview', { path }),
  setupRestoreArchive: (path: string) =>
    post<BackupJobStatus>('/api/setup/archive/restore', { path }),
  /** The running backup or restore; answers through the restore's maintenance too. */
  setupArchiveJob: () => request<BackupJobStatus | null>('/api/setup/archive/job'),

  signIn: (username: string, password: string) =>
    post<{ user: SignedInUser; sessionToken: string }>('/api/auth/sign-in', { username, password }),
  signOut: () => post<void>('/api/auth/sign-out'),
  // Carries the caller's own resolved permissions, so the UI renders from what
  // the trusted process granted rather than guessing from the role name.
  me: () =>
    request<{ user: SignedInUser; sessionToken: string }>('/api/auth/me'),

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

  // --- Back up everything to a drive (Master PC only; docs/7-STORAGE-BACKUP-RESTORE.md)

  /** Starts the one backup job; the screen follows it with `archiveJob`. */
  startArchiveBackup: (folder: string) => post<BackupJobStatus>('/api/storage/archive', { folder }),
  archiveJob: () => request<BackupJobStatus | null>('/api/storage/archive/job'),
  listArchives: (folder: string) =>
    request<ArchiveListEntry[]>(`/api/storage/archives?${new URLSearchParams({ folder }).toString()}`),
  previewArchive: (path: string) => post<ArchivePreview>('/api/storage/archive/preview', { path }),
  /**
   * Replaces every record, so it needs the master key. The job is followed
   * with `setupArchiveJob`, which still answers during the restore and after
   * it has signed everyone out.
   */
  restoreArchive: (path: string, masterKeyToken: string) =>
    request<BackupJobStatus>('/api/storage/archive/restore', {
      method: 'POST',
      body: JSON.stringify({ path }),
      headers: masterKeyHeader(masterKeyToken),
    }),
  autoBackup: () => request<AutoBackupStatus>('/api/storage/auto-backup'),
  saveAutoBackup: (input: Partial<AutoBackupConfig>) =>
    request<AutoBackupStatus>('/api/storage/auto-backup', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  pipelines: () => request<Pipeline[]>('/api/pipelines'),
  optionLists: () => request<OptionListItem[]>('/api/option-lists'),

  // --- App update ----------------------------------------------------------

  updateStatus: () => request<UpdateStatusResponse>('/api/updates/status'),
  /** Check now (1.4 R6): asks GitHub straight away instead of waiting for the poll. */
  checkForUpdates: () => post<UpdateStatusResponse>('/api/updates/check', {}),
  /** The nightly update's switch and time (`settings.manage`). */
  saveAutoUpdate: (input: Partial<AutoUpdateConfig>) =>
    request<AutoUpdateStatus>('/api/updates/auto', { method: 'PUT', body: JSON.stringify(input) }),
  /** Verifies the setup file and returns its path; the shell runs it. */
  prepareMasterUpdate: () =>
    post<{ path: string; manifest: ReleaseManifest }>('/api/updates/master/install', {}),

  // --- Party Access --------------------------------------------------------

  partyAccess: (query: PartyAccessQuery = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.userId) params.set('userId', query.userId);
    if (query.restriction) params.set('restriction', query.restriction);
    if (query.sort) params.set('sort', query.sort);
    if (query.dir) params.set('dir', query.dir);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.offset) params.set('offset', String(query.offset));
    const search = params.toString();
    return request<Paginated<PartyAccessRow>>(`/api/party-access${search ? `?${search}` : ''}`);
  },
  /** Company-wide counts for the summary strip; whatever the search or filter on the list. */
  partyAccessSummary: () => request<PartyAccessSummary>('/api/party-access/summary'),
  partyAccessPeople: () => request<AssignablePerson[]>('/api/party-access/people'),
  partyAccessFor: (partyId: string) => request<PartyAccessRow>(`/api/party-access/${partyId}`),
  savePartyAccess: (partyId: string, input: PartyAccessInput) =>
    request<PartyAccessRow>(`/api/party-access/${partyId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

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
  openPairingWindow: () => post<PairingWindowState>('/api/panels/pairing-window/open'),
  pairingWindow: () => request<PairingWindowState>('/api/panels/pairing-window'),
  closePairingWindow: () => post<void>('/api/panels/pairing-window/close'),
  revokePanel: (id: string) => post<void>(`/api/panels/${id}/revoke`),
  rotatePanelSecret: (id: string) => post<PanelSecretRotation>(`/api/panels/${id}/rotate-secret`),
  renamePanel: (id: string, name: string) =>
    request<void>(`/api/panels/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  // --- One panel, administered (docs/UI_REDESIGN.md — Office Panels) --------

  panel: (id: string) => request<OfficePanelDetail>(`/api/panels/${id}`),

  parties: (
    search?: string,
    limit?: number,
    offset?: number,
    options: {
      sort?: string;
      dir?: 'asc' | 'desc';
      city?: string;
      state?: string;
      hasGst?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams(pagedQuery(search, limit, offset).replace(/^\?/, ''));
    if (options.sort) params.set('sort', options.sort);
    if (options.dir) params.set('dir', options.dir);
    if (options.city) params.set('city', options.city);
    if (options.state) params.set('state', options.state);
    if (options.hasGst !== undefined) params.set('hasGst', String(options.hasGst));
    const query = params.toString();
    return request<Paginated<PartyListRow>>(`/api/parties${query ? `?${query}` : ''}`);
  },
  party: (id: string) => request<PartyDetailRecord>(`/api/parties/${id}`),
  /** One party's own product records, each with the catalogue model it stands for named. */
  partyRecords: (id: string) => request<PartyRecord[]>(`/api/parties/${id}/variants`),
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
  updateProduct: (id: string, input: ProductInput) =>
    request<Product>(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  /** One page of the catalogue; `limit` is clamped by the server (2000 at most). */
  listProducts: (query: ProductListQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.categoryId) params.set('categoryId', query.categoryId);
    if (query.brand) params.set('brand', query.brand);
    if (query.missingWeight) params.set('missingWeight', 'true');
    if (query.sort) params.set('sort', query.sort);
    if (query.dir) params.set('dir', query.dir);
    if (query.size) params.set('size', query.size);
    if (query.hasPhoto !== undefined) params.set('hasPhoto', String(query.hasPhoto));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.offset) params.set('offset', String(query.offset));
    const qs = params.toString();
    return request<ProductListPage>(
      `/api/products${qs ? `?${qs}` : ''}`,
      signal ? { signal } : undefined,
    );
  },

  // Categories — the owner's Products (`docs/catalogue/CATALOGUE_MODEL.md` §5),
  // written from the Products module's Products page.
  categories: (query: { search?: string; brand?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.brand) params.set('brand', query.brand);
    const qs = params.toString();
    return request<ProductCategoryListRow[]>(`/api/categories${qs ? `?${qs}` : ''}`);
  },
  createCategory: (input: CategoryInput) => post<ProductCategory>('/api/categories', input),
  updateCategory: (id: string, input: CategoryUpdateInput) =>
    request<ProductCategory>(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteCategory: (id: string) =>
    request<{ id: string; deletedAt: string }>(`/api/categories/${id}`, { method: 'DELETE' }),

  /** Duplicate Products and sub products, and deleting the extra copies (`products.delete`). */
  duplicates: () => request<DuplicateReport>('/api/duplicates'),
  resolveDuplicates: (input: DuplicateResolveInput) =>
    post<DuplicateResolveResult>('/api/duplicates/resolve', input),

  /** 1.4 D3: Create product share; the Master draws the PDF with the photographs. */
  productSharePdf: (ids: string[]) =>
    requestFile('/api/products/share.pdf', 'product-share.pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),

  // Bulk product import (`products.bulk`, checked by the service).
  productImportTemplate: (format: ProductImportFormat) =>
    requestFile(`/api/products/import/template.${format}`, `products-template.${format}`),
  exportProducts: (format: ProductImportFormat, level: 'sub' | 'main' = 'sub') =>
    requestFile(
      `/api/products/export.${format}${level === 'main' ? '?level=main' : ''}`,
      `products.${format}`,
    ),
  importProducts: (file: File, options: { dryRun: boolean; mode: ProductImportMode }) => {
    const form = new FormData();
    form.append('file', file);
    form.append('dryRun', String(options.dryRun));
    form.append('mode', options.mode);
    return requestForm<ProductImportResult>('/api/products/import', form);
  },

  // Bulk party import and export (`parties.bulk` / `parties.view`, checked by the service).
  partyImportTemplate: (format: PartyImportFormat) =>
    requestFile(`/api/parties/import/template.${format}`, `parties-template.${format}`),
  exportParties: (format: PartyImportFormat) =>
    requestFile(`/api/parties/export.${format}`, `parties.${format}`),
  importParties: (file: File, options: { dryRun: boolean; mode: PartyImportMode }) => {
    const form = new FormData();
    form.append('file', file);
    form.append('dryRun', String(options.dryRun));
    form.append('mode', options.mode);
    return requestForm<PartyImportResult>('/api/parties/import', form);
  },

  // Product photos (`7-IMAGE-PIPELINE.md`): each answers with the whole `Product`.
  uploadProductImage: (
    productId: string,
    file: Blob,
    crop: {
      cropX: number;
      cropY: number;
      cropWidth: number;
      cropHeight: number;
      rotationDeg: number;
      caption?: string | null;
    },
  ) => {
    const form = new FormData();
    form.set('file', file, 'image');
    form.set('cropX', String(crop.cropX));
    form.set('cropY', String(crop.cropY));
    form.set('cropWidth', String(crop.cropWidth));
    form.set('cropHeight', String(crop.cropHeight));
    form.set('rotationDeg', String(crop.rotationDeg));
    if (crop.caption) form.set('caption', crop.caption);
    return requestForm<Product>(`/api/products/${productId}/images`, form);
  },
  updateProductImage: (productId: string, imageId: string, input: ProductImageUpdateInput) =>
    request<Product>(`/api/products/${productId}/images/${imageId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  reorderProductImages: (productId: string, ids: string[]) =>
    post<Product>(`/api/products/${productId}/images/reorder`, { ids }),
  deleteProductImage: (productId: string, imageId: string) =>
    request<Product>(`/api/products/${productId}/images/${imageId}`, { method: 'DELETE' }),

  leads: (
    options: {
      stageIds?: string[];
      includeConverted?: boolean;
      /** Only converted leads — the Converted page; wins over `includeConverted`. */
      convertedOnly?: boolean;
      partyId?: string;
      followUpDueOnly?: boolean;
      scope?: PartyScopeFilter;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.stageIds?.length) params.set('stageIds', options.stageIds.join(','));
    if (options.includeConverted) params.set('includeConverted', 'true');
    if (options.convertedOnly) params.set('convertedOnly', 'true');
    if (options.partyId) params.set('partyId', options.partyId);
    if (options.followUpDueOnly) params.set('followUpDueOnly', 'true');
    if (options.scope === 'assigned') params.set('scope', 'assigned');
    if (options.search) params.set('search', options.search);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return request<Paginated<Lead>>(`/api/leads${query ? `?${query}` : ''}`);
  },
  lead: (id: string) => request<Lead>(`/api/leads/${id}`),
  createLead: (input: LeadInput) => post<Lead>('/api/leads', input),
  updateLead: (id: string, input: LeadUpdateInput) =>
    request<Lead>(`/api/leads/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  /** What the New / Edit pending order form reads besides its pickers. */
  leadEntryView: () => request<LeadEntryView>('/api/lead-entry'),
  setLeadStage: (id: string, stageId: string, remark?: string | null) =>
    post<Lead>(`/api/leads/${id}/stage`, { stageId, remark }),
  addLeadRemark: (id: string, message: string) =>
    post<Lead>(`/api/leads/${id}/remarks`, { message }),
  convertLead: (
    id: string,
    input: { dispatchAddressLabel?: string | null; expectedDispatchDate?: string | null } = {},
  ) => post<Order>(`/api/leads/${id}/convert`, input),

  /** Per-stage counts under the same filters as `leads`, ignoring the stage chip. */
  leadStageCounts: (
    options: { includeConverted?: boolean; convertedOnly?: boolean; scope?: PartyScopeFilter; search?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.convertedOnly) params.set('convertedOnly', 'true');
    else if (options.includeConverted) params.set('includeConverted', 'true');
    if (options.scope === 'assigned') params.set('scope', 'assigned');
    if (options.search) params.set('search', options.search);
    const qs = params.toString();
    return request<StageCounts>(`/api/leads/stage-counts${qs ? `?${qs}` : ''}`);
  },
  /** Per-stage counts under the same filters as `orders`, ignoring the stage. */
  orderStageCounts: (options: { scope?: PartyScopeFilter; search?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.scope === 'assigned') params.set('scope', 'assigned');
    if (options.search) params.set('search', options.search);
    const qs = params.toString();
    return request<StageCounts>(`/api/orders/stage-counts${qs ? `?${qs}` : ''}`);
  },
  orders: (
    options: {
      stageIds?: string[];
      scope?: PartyScopeFilter;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.stageIds?.length) params.set('stageIds', options.stageIds.join(','));
    if (options.scope === 'assigned') params.set('scope', 'assigned');
    if (options.search) params.set('search', options.search);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
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
  /*
   * `masterKeyToken` is needed only where a Server Master account is created,
   * renamed, moved, deactivated, deleted or reset; the server says which.
   */
  createUser: (input: UserInput, masterKeyToken?: string) =>
    request<{ user: User; secret: OneTimeSecret }>('/api/access/users', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: masterKeyHeader(masterKeyToken),
    }),
  updateUser: (id: string, input: UserUpdateInput, masterKeyToken?: string) =>
    request<User>(`/api/access/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
      headers: masterKeyHeader(masterKeyToken),
    }),
  deleteUser: (id: string, masterKeyToken?: string) =>
    request<User>(`/api/access/users/${id}`, {
      method: 'DELETE',
      headers: masterKeyHeader(masterKeyToken),
    }),
  restoreUser: (id: string) => post<User>(`/api/access/users/${id}/restore`),
  /** Omit `password` to have the Master generate one. On an installation that
   *  has not switched the password vault on, this is still the only way an
   *  administrator can tell somebody what their password is: what is stored is
   *  a scrypt hash and nothing reads it back. */
  resetPassword: (id: string, password?: string, masterKeyToken?: string) =>
    request<OneTimeSecret>(`/api/access/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
      headers: masterKeyHeader(masterKeyToken),
    }),
  /** Refused unless `security.passwordRevealEnabled` is on, the caller holds
   *  `users.viewPassword`, and they re-type their own password. POST so it
   *  never lands in a URL or a proxy log. */
  revealPassword: (id: string, confirmPassword: string) =>
    post<OneTimeSecret>(`/api/access/users/${id}/reveal-password`, { confirmPassword }),
  /** A Server Master's own change needs the master-key token as well. */
  changeOwnPassword: (input: ChangeOwnPasswordInput, masterKeyToken?: string) =>
    request<void>('/api/access/me/password', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: masterKeyHeader(masterKeyToken),
    }),

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

  /**
   * The signed-in person's notifications, newest first: the bell. Not counted
   * by the loading strip, since the bell reads it in the background.
   */
  notifications: () =>
    requestUntracked<{ items: UserNotification[]; unreadCount: number }>('/api/notifications'),
  /**
   * "This tab has this record open" (or, with no record, "left it"). Untracked:
   * it runs every few seconds in the background. The same tab id rides on the
   * socket handshake, so closing the tab takes it off at once.
   */
  presenceBeat: (beat: PresenceBeat, keepalive = false) =>
    requestUntracked<RecordPresence | null>('/api/presence', {
      method: 'POST',
      body: JSON.stringify(beat),
      keepalive,
    }),
  /** Who is on each card of the Pending or Final board; the Master then pushes changes. */
  presenceBoard: (kind: PresenceRecordKind) =>
    requestUntracked<BoardPresence>(`/api/presence/board?kind=${kind}`),
  markNotificationsRead: (which: { ids: string[] } | { all: true }) =>
    post<{ unreadCount: number }>('/api/notifications/read', which),

  // --- The notice board (`/api/notices`) ---
  /** The notices meant for the signed-in person (the Master already leaves out expired and out-of-audience ones). */
  notices: () => request<NoticeBoard>('/api/notices'),
  /** Every notice, expired ones included, with role names and read counts. `notices.manage`. */
  noticeManageList: () => request<Notice[]>('/api/notices/manage'),
  noticeReaders: (id: string) => request<NoticeReaders>(`/api/notices/${encodeURIComponent(id)}/readers`),
  /** The roles an audience can be made of. `notices.manage`. */
  noticeAudiences: () => request<Array<{ id: string; name: string }>>('/api/notices/audiences'),
  createNotice: (input: NoticeInput) => post<Notice>('/api/notices', input),
  updateNotice: (id: string, update: NoticeUpdate) =>
    request<Notice>(`/api/notices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(update) }),
  deleteNotice: (id: string) =>
    request<{ id: string }>(`/api/notices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Marks the given notices read (all of them when `ids` is left out) and answers the new unread count. */
  markNoticesRead: (ids?: string[]) => post<{ unreadCount: number }>('/api/notices/read', ids ? { ids } : {}),

  // --- The Chatroom (`/api/chat`). Background reads, so the loading strip stays still. ---
  chatPeople: () => requestUntracked<ChatPerson[]>('/api/chat/people'),
  chatRooms: (options: { all?: boolean; includeArchived?: boolean } = {}) =>
    requestUntracked<ChatRoomSummary[]>(
      `/api/chat/rooms?all=${options.all ? '1' : '0'}&archived=${options.includeArchived ? '1' : '0'}`,
    ),
  chatRoom: (roomId: string) => requestUntracked<ChatRoomDetail>(`/api/chat/rooms/${encodeURIComponent(roomId)}`),
  chatMessages: (roomId: string, options: { beforeSeq?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.beforeSeq) params.set('before', String(options.beforeSeq));
    if (options.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    return requestUntracked<ChatMessage[]>(
      `/api/chat/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ''}`,
    );
  },
  chatPost: (roomId: string, input: ChatPostInput) =>
    requestUntracked<ChatMessage>(`/api/chat/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  chatEdit: (messageId: string, body: string, mentions?: string[]) =>
    requestUntracked<ChatMessage>(`/api/chat/messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      body: JSON.stringify({ body, ...(mentions ? { mentions } : {}) }),
    }),
  chatDelete: (messageId: string) =>
    requestUntracked<ChatMessage>(`/api/chat/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' }),
  chatPin: (messageId: string, pinned: boolean) =>
    requestUntracked<ChatMessage>(`/api/chat/messages/${encodeURIComponent(messageId)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    }),
  chatTaskDone: (messageId: string, done: boolean) =>
    requestUntracked<ChatMessage>(`/api/chat/messages/${encodeURIComponent(messageId)}/done`, {
      method: 'POST',
      body: JSON.stringify({ done }),
    }),
  chatRead: (roomId: string, seq: number) =>
    requestUntracked<{ lastReadSeq: number }>(`/api/chat/rooms/${encodeURIComponent(roomId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ seq }),
    }),
  chatMute: (roomId: string, muted: boolean) =>
    requestUntracked<null>(`/api/chat/rooms/${encodeURIComponent(roomId)}/mute`, {
      method: 'POST',
      body: JSON.stringify({ muted }),
    }),
  chatDirect: (userId: string) =>
    requestUntracked<ChatRoomSummary>('/api/chat/direct', { method: 'POST', body: JSON.stringify({ userId }) }),
  chatCreateRoom: (input: ChatRoomInput) =>
    requestUntracked<ChatRoomSummary>('/api/chat/rooms', { method: 'POST', body: JSON.stringify(input) }),
  chatUpdateRoom: (roomId: string, patch: ChatRoomPatch) =>
    requestUntracked<ChatRoomSummary>(`/api/chat/rooms/${encodeURIComponent(roomId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  chatSetMember: (roomId: string, userId: string, role: ChatMemberRole | null) =>
    requestUntracked<ChatRoomDetail | null>(`/api/chat/rooms/${encodeURIComponent(roomId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    }),
  chatSearch: (q: string, roomId?: string) =>
    requestUntracked<ChatSearchHit[]>(
      `/api/chat/search?q=${encodeURIComponent(q)}${roomId ? `&roomId=${encodeURIComponent(roomId)}` : ''}`,
    ),
  chatTasks: (scope: 'mine' | 'created', includeDone: boolean) =>
    requestUntracked<ChatTaskRow[]>(`/api/chat/tasks?scope=${scope}&includeDone=${includeDone ? '1' : '0'}`),
  chatRequestAccess: (capability: ChatAccessCapability, note?: string) =>
    requestUntracked<{ notified: number }>('/api/chat/access-requests', {
      method: 'POST',
      body: JSON.stringify({ capability, ...(note ? { note } : {}) }),
    }),

  // --- The Printroom (`/api/print-jobs`, `/api/print-stations`). Background reads, so the loading strip stays still. ---
  printJobs: (query: PrintJobQuery) => {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.mine) params.set('mine', '1');
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return requestUntracked<PrintJobPage>(`/api/print-jobs${qs ? `?${qs}` : ''}`);
  },
  printJob: (id: string) => requestUntracked<PrintJob>(`/api/print-jobs/${encodeURIComponent(id)}`),
  sendPrintJob: (input: PrintJobInput) =>
    requestUntracked<PrintJob>('/api/print-jobs', { method: 'POST', body: JSON.stringify(input) }),
  markPrintJob: (id: string, printed: boolean, printerName?: string | null) =>
    requestUntracked<PrintJobSummary>(`/api/print-jobs/${encodeURIComponent(id)}/printed`, {
      method: 'POST',
      body: JSON.stringify({ printed, ...(printerName ? { printerName } : {}) }),
    }),
  cancelPrintJob: (id: string) =>
    requestUntracked<PrintJobSummary>(`/api/print-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  printStations: () => requestUntracked<PrintStation[]>('/api/print-stations'),
  savePrintStation: (input: PrintStationInput) =>
    requestUntracked<PrintStation>('/api/print-stations/self', { method: 'PUT', body: JSON.stringify(input) }),
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
  // Every kind is one table (`GET /api/reports/table/:kind`); the three typed
  // legacy routes stay on the server for Offices that predate it and have no
  // caller here. Who may ask about whom is the Master's decision, so the query
  // carries what the person chose and nothing else.

  reportOptions: (signal?: AbortSignal) =>
    request<ReportOptions>('/api/reports/options', signal ? { signal } : undefined),
  reportTable: (kind: ReportKind, query: ReportQuery, signal?: AbortSignal) => {
    const qs = reportQueryParams(query).toString();
    return request<ReportTable>(`/api/reports/table/${kind}${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined);
  },
  reportExport: (kind: ReportKind, query: ReportQuery & { format: ReportFormat }) => {
    const params = reportQueryParams(query);
    params.set('format', query.format);
    return requestFile(`/api/reports/${kind}/export?${params}`, `${kind}.${query.format}`);
  },

  // --- Integrations (Stage 11) ---------------------------------------------

  apiKeys: () => request<ApiKey[]>('/api/integrations/keys'),
  /** The only call that ever sees a token. It is not stored anywhere else. */
  issueApiKey: (input: ApiKeyInput) =>
    post<{ key: ApiKey; token: string }>('/api/integrations/keys', input),
  revokeApiKey: (id: string) => post<ApiKey>(`/api/integrations/keys/${id}/revoke`),

  connectors: () => request<Connector[]>('/api/integrations/connectors'),
  createConnector: (input: ConnectorInput & { fromProfile?: string }) =>
    post<Connector>('/api/integrations/connectors', input),
  updateConnector: (id: string, input: ConnectorInput) =>
    request<Connector>(`/api/integrations/connectors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
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
};
