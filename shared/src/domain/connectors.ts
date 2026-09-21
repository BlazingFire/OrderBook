/**
 * An outbound connection to another system, as data.
 *
 * The point of this shape is that "Hermes" is a row, not a code path: a base
 * URL, how to authenticate, which remote path holds which entity, and a list of
 * `local field ← JSON pointer` pairs. Adding a second system is a profile
 * somebody fills in, not a module somebody writes — and because it is data, the
 * same shape imports and exports as JSON at runtime.
 *
 * **The credential is not on any of these types.** The connector row holds it
 * sealed, and neither a list response nor a run error carries it;
 * `connector-secrets.test.ts` reads the source to hold that.
 *
 * Conflicts are resolved per field and **not** by the sync clock. A remote
 * system's `updated_at` is not causally ordered with this installation's HLC,
 * so handing the two to the sync merge would pick winners arbitrarily. Each
 * mapped field says what to do instead.
 */

import type { IsoTimestamp, Uuid } from './entities.js';

export type ConnectorAuthKind = 'none' | 'header' | 'bearer' | 'basic';
export type ConnectorScheduleKind = 'manual' | 'on_change' | 'periodic';
export type ConnectorEntity = 'party' | 'product';
export type ConnectorRunMode = 'dry_run' | 'import';
export type ConnectorRunTrigger = 'manual' | 'schedule' | 'change';
export type ConnectorRunStatus = 'running' | 'ok' | 'partial' | 'failed';

/**
 * What to do when the remote value and ours disagree.
 *
 * `flag` writes nothing and raises a row on the existing Conflicts screen. It
 * is offered only for the fields the conflict restorer can actually put back —
 * offering it elsewhere would produce a conflict nobody can resolve.
 */
export type ConnectorConflictRule = 'remote_wins' | 'local_wins' | 'flag';

/** The minimum period, in minutes. Below this a poll is a denial of service. */
export const CONNECTOR_MIN_INTERVAL_MIN = 5;

/** The fields `conflict.service.ts` can restore, and so the only ones `flag` fits. */
export const CONNECTOR_FLAGGABLE_FIELDS: Readonly<Record<ConnectorEntity, readonly string[]>> = {
  party: ['name', 'phone', 'notes', 'customFields'],
  product: ['name', 'alias', 'customFields'],
};

export interface Connector {
  id: Uuid;
  slug: string;
  label: string;
  baseUrl: string;
  authKind: ConnectorAuthKind;
  /** For `header` auth: which header the credential goes in. */
  authHeader: string | null;
  /** For `basic` auth. The password half is sealed, and is never on this type. */
  authUsername: string | null;
  /** Whether a credential is stored. Never the credential. */
  credentialConfigured: boolean;
  scheduleKind: ConnectorScheduleKind;
  intervalMin: number | null;
  /** Whose authority an import writes with. Never the system actor. */
  runAsUserId: Uuid | null;
  runAsUserName: string | null;
  /**
   * Bumped by any field-map write. An import is refused unless a successful dry
   * run exists at the current version, so a mapping cannot be changed and then
   * run blind.
   */
  mappingVersion: number;
  profileSlug: string | null;
  isEnabled: boolean;
  lastRunAt: IsoTimestamp | null;
  lastStatus: ConnectorRunStatus | null;
  lastError: string | null;
  createdAt: IsoTimestamp;
  resources: ConnectorResource[];
}

export interface ConnectorInput {
  slug: string;
  label: string;
  baseUrl: string;
  authKind: ConnectorAuthKind;
  authHeader?: string | null;
  authUsername?: string | null;
  /** Write-only. Absent leaves whatever is stored; `null` clears it. */
  credential?: string | null;
  scheduleKind: ConnectorScheduleKind;
  intervalMin?: number | null;
  runAsUserId?: Uuid | null;
  profileSlug?: string | null;
  isEnabled?: boolean;
}

export interface ConnectorResource {
  id: Uuid;
  connectorId: Uuid;
  entity: ConnectorEntity;
  /** Appended to the base URL. */
  path: string;
  method: 'GET' | 'POST';
  /** JSON pointer to the array of rows in the response. Empty means the root. */
  itemsPointer: string;
  /** JSON pointer to the remote record's own id, which is what links it to ours. */
  remoteIdPointer: string;
  updatedAtPointer: string | null;
  pageParam: string | null;
  pageSizeParam: string | null;
  pageSize: number | null;
  /** The high-water mark, only ever advanced by a successful run. */
  watermark: string | null;
  fieldMaps: ConnectorFieldMap[];
}

export interface ConnectorResourceInput {
  entity: ConnectorEntity;
  path: string;
  method?: 'GET' | 'POST';
  itemsPointer?: string;
  remoteIdPointer: string;
  updatedAtPointer?: string | null;
  pageParam?: string | null;
  pageSizeParam?: string | null;
  pageSize?: number | null;
}

export interface ConnectorFieldMap {
  id: Uuid;
  resourceId: Uuid;
  localField: string;
  remotePointer: string;
  /** A named, closed transform. Never an expression — that would be a code path. */
  transform: ConnectorTransform | null;
  onConflict: ConnectorConflictRule;
  isRequired: boolean;
}

export type ConnectorTransform = 'trim' | 'upper' | 'lower' | 'digits';

export const CONNECTOR_TRANSFORMS: readonly ConnectorTransform[] = ['trim', 'upper', 'lower', 'digits'];

export interface ConnectorFieldMapInput {
  localField: string;
  remotePointer: string;
  transform?: ConnectorTransform | null;
  onConflict?: ConnectorConflictRule;
  isRequired?: boolean;
}

/** One row's outcome, which is all a dry run reports. */
export interface ConnectorRowResult {
  remoteId: string;
  action: 'create' | 'update' | 'skip' | 'error';
  localId: string | null;
  changes: string[];
  error?: string;
}

export interface ConnectorRun {
  id: number;
  connectorId: Uuid;
  mode: ConnectorRunMode;
  trigger: ConnectorRunTrigger;
  mappingVersion: number;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
  status: ConnectorRunStatus;
  read: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Capped, with a total beside it — a run that fails every row must not be a log bomb. */
  errors: ConnectorRowResult[];
}

/** What a connection test hands back: proof it works, and the remote's shape. */
export interface ConnectorTestResult {
  ok: boolean;
  status: number | null;
  itemCount: number;
  /** Flattened JSON pointers of the first item — what the mapping picker offers. */
  samplePointers: string[];
  error?: string;
}

/** A ready-made connector, shipped as data so a new system needs a file. */
export interface ConnectorProfile {
  slug: string;
  label: string;
  baseUrl: string;
  authKind: ConnectorAuthKind;
  authHeader?: string;
  resources: Array<
    ConnectorResourceInput & {
      fieldMaps: ConnectorFieldMapInput[];
    }
  >;
}
