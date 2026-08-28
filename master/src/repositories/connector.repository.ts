/**
 * Connectors, their resources, their field maps, their links and their runs.
 *
 * The credential is stored **sealed**, in a JSONB column, by `secret-box` with
 * this row's own AAD — so a ciphertext lifted out of one connector cannot be
 * pasted into another and opened. `mapConnector` reports only whether one is
 * configured; there is no read path that returns it to a caller, and
 * `openCredential` is the single function that unseals, called from the run
 * service at the moment a request is about to be signed.
 *
 * A sealed value survives a backup as ciphertext and cannot be opened after a
 * restore onto a new machine, because `vault.key` deliberately does not travel.
 * That is the same trade the password vault makes, and the answer is the same:
 * re-enter the credential.
 */

import type { Knex } from 'knex';
import type {
  Connector,
  ConnectorEntity,
  ConnectorFieldMap,
  ConnectorResource,
  ConnectorRowResult,
  ConnectorRun,
  ConnectorRunMode,
  ConnectorRunStatus,
  ConnectorRunTrigger,
  ConnectorTransform,
} from '@orderbook/shared';

import { db } from '../db/knex.js';
import { isSealedValue, open, seal, type SealedValue } from '../lib/secret-box.js';

type Runner = Knex | Knex.Transaction;

const CONNECTORS = 'api_connectors';
const RESOURCES = 'api_connector_resources';
const FIELD_MAPS = 'api_connector_field_maps';
const LINKS = 'api_connector_links';
const RUNS = 'api_connector_runs';

/** One AAD per connector, so a ciphertext cannot be moved between rows. */
function aadFor(tenantId: string, connectorId: string): string {
  return `connector:${tenantId}:${connectorId}`;
}

interface ConnectorRow {
  id: string;
  tenant_id: string;
  slug: string;
  label: string;
  base_url: string;
  auth_kind: string;
  auth_header: string | null;
  auth_username: string | null;
  credential_sealed: unknown;
  schedule_kind: string;
  interval_min: number | null;
  run_as_user_id: string | null;
  mapping_version: number;
  profile_slug: string | null;
  is_enabled: boolean;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  created_at: Date;
}

interface ResourceRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  entity: string;
  path: string;
  method: string;
  items_pointer: string;
  remote_id_pointer: string;
  updated_at_pointer: string | null;
  page_param: string | null;
  page_size_param: string | null;
  page_size: number | null;
  watermark: string | null;
}

interface FieldMapRow {
  id: string;
  resource_id: string;
  local_field: string;
  remote_pointer: string;
  transform: string | null;
  on_conflict: string;
  is_required: boolean;
}

export async function listConnectors(
  tenantId: string,
  runner: Runner = db(),
): Promise<Connector[]> {
  const rows = await runner(CONNECTORS)
    .leftJoin('users as u', 'u.id', `${CONNECTORS}.run_as_user_id`)
    .where(`${CONNECTORS}.tenant_id`, tenantId)
    .orderBy(`${CONNECTORS}.label`)
    .select<Array<ConnectorRow & { run_as_user_name: string | null }>>(
      `${CONNECTORS}.*`,
      'u.display_name as run_as_user_name',
    );

  if (rows.length === 0) return [];

  const resources = await loadResources(
    tenantId,
    rows.map((row) => row.id),
    runner,
  );

  return rows.map((row) => mapConnector(row, resources.get(row.id) ?? []));
}

export async function findConnector(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<Connector | null> {
  const row = await runner(CONNECTORS)
    .leftJoin('users as u', 'u.id', `${CONNECTORS}.run_as_user_id`)
    .where({ [`${CONNECTORS}.tenant_id`]: tenantId, [`${CONNECTORS}.id`]: id })
    .first<(ConnectorRow & { run_as_user_name: string | null }) | undefined>(
      `${CONNECTORS}.*`,
      'u.display_name as run_as_user_name',
    );

  if (!row) return null;

  const resources = await loadResources(tenantId, [row.id], runner);
  return mapConnector(row, resources.get(row.id) ?? []);
}

async function loadResources(
  tenantId: string,
  connectorIds: string[],
  runner: Runner,
): Promise<Map<string, ConnectorResource[]>> {
  const resourceRows = await runner(RESOURCES)
    .where({ tenant_id: tenantId })
    .whereIn('connector_id', connectorIds)
    .orderBy('entity')
    .select<ResourceRow[]>('*');

  const fieldMapRows =
    resourceRows.length === 0
      ? []
      : await runner(FIELD_MAPS)
          .where({ tenant_id: tenantId })
          .whereIn(
            'resource_id',
            resourceRows.map((row) => row.id),
          )
          .orderBy('local_field')
          .select<FieldMapRow[]>('*');

  const mapsByResource = new Map<string, ConnectorFieldMap[]>();
  for (const row of fieldMapRows) {
    mapsByResource.set(row.resource_id, [
      ...(mapsByResource.get(row.resource_id) ?? []),
      {
        id: row.id,
        resourceId: row.resource_id,
        localField: row.local_field,
        remotePointer: row.remote_pointer,
        transform: (row.transform as ConnectorTransform | null) ?? null,
        onConflict: row.on_conflict as ConnectorFieldMap['onConflict'],
        isRequired: row.is_required,
      },
    ]);
  }

  const byConnector = new Map<string, ConnectorResource[]>();
  for (const row of resourceRows) {
    byConnector.set(row.connector_id, [
      ...(byConnector.get(row.connector_id) ?? []),
      {
        id: row.id,
        connectorId: row.connector_id,
        entity: row.entity as ConnectorEntity,
        path: row.path,
        method: row.method as 'GET' | 'POST',
        itemsPointer: row.items_pointer,
        remoteIdPointer: row.remote_id_pointer,
        updatedAtPointer: row.updated_at_pointer,
        pageParam: row.page_param,
        pageSizeParam: row.page_size_param,
        pageSize: row.page_size,
        watermark: row.watermark,
        fieldMaps: mapsByResource.get(row.id) ?? [],
      },
    ]);
  }

  return byConnector;
}

export function mapConnector(
  row: ConnectorRow & { run_as_user_name?: string | null },
  resources: ConnectorResource[],
): Connector {
  // Destructured away rather than merely not copied, so a future `select *`
  // cannot start handing the ciphertext to a browser.
  const { credential_sealed: sealed, ...rest } = row;

  return {
    id: rest.id,
    slug: rest.slug,
    label: rest.label,
    baseUrl: rest.base_url,
    authKind: rest.auth_kind as Connector['authKind'],
    authHeader: rest.auth_header,
    authUsername: rest.auth_username,
    credentialConfigured: isSealedValue(sealed),
    scheduleKind: rest.schedule_kind as Connector['scheduleKind'],
    intervalMin: rest.interval_min,
    runAsUserId: rest.run_as_user_id,
    runAsUserName: row.run_as_user_name ?? null,
    mappingVersion: rest.mapping_version,
    profileSlug: rest.profile_slug,
    isEnabled: rest.is_enabled,
    lastRunAt: rest.last_run_at ? rest.last_run_at.toISOString() : null,
    lastStatus: (rest.last_status as ConnectorRunStatus | null) ?? null,
    lastError: rest.last_error,
    createdAt: rest.created_at.toISOString(),
    resources,
  };
}

export async function insertConnector(
  tenantId: string,
  values: Record<string, unknown>,
  runner: Runner,
): Promise<string> {
  const [row] = await runner(CONNECTORS)
    .insert({ ...values, tenant_id: tenantId })
    .returning<Array<{ id: string }>>('id');

  if (!row) throw new Error('connector insert returned no id');
  return row.id;
}

export async function updateConnector(
  tenantId: string,
  id: string,
  values: Record<string, unknown>,
  runner: Runner,
): Promise<void> {
  await runner(CONNECTORS)
    .where({ tenant_id: tenantId, id })
    .update({ ...values, updated_at: runner.fn.now() });
}

export async function deleteConnector(
  tenantId: string,
  id: string,
  runner: Runner,
): Promise<number> {
  return runner(CONNECTORS).where({ tenant_id: tenantId, id }).del();
}

/** Seal a credential against this connector's own AAD. */
export async function writeCredential(
  tenantId: string,
  connectorId: string,
  plaintext: string | null,
  runner: Runner,
): Promise<void> {
  const value = plaintext === null ? null : seal(plaintext, aadFor(tenantId, connectorId));
  await runner(CONNECTORS)
    .where({ tenant_id: tenantId, id: connectorId })
    .update({ credential_sealed: value ? JSON.stringify(value) : null });
}

/**
 * The one place a credential is unsealed.
 *
 * Returns `null` rather than throwing when the key cannot open it — after a
 * restore onto a new machine that is the normal state, and the connector's
 * answer is "re-enter the credential", not a crash on a scheduler tick.
 */
export async function openCredential(
  tenantId: string,
  connectorId: string,
  runner: Runner = db(),
): Promise<string | null> {
  const row = await runner(CONNECTORS)
    .where({ tenant_id: tenantId, id: connectorId })
    .first<{ credential_sealed: unknown } | undefined>('credential_sealed');

  if (!row || !isSealedValue(row.credential_sealed)) return null;

  try {
    return open(row.credential_sealed as SealedValue, aadFor(tenantId, connectorId));
  } catch {
    return null;
  }
}

export async function replaceResources(
  tenantId: string,
  connectorId: string,
  resources: Array<{
    entity: string;
    path: string;
    method: string;
    itemsPointer: string;
    remoteIdPointer: string;
    updatedAtPointer: string | null;
    pageParam: string | null;
    pageSizeParam: string | null;
    pageSize: number | null;
    fieldMaps: Array<{
      localField: string;
      remotePointer: string;
      transform: string | null;
      onConflict: string;
      isRequired: boolean;
    }>;
  }>,
  runner: Runner,
): Promise<void> {
  // Replaced wholesale rather than diffed. The watermark is the only state on a
  // resource worth keeping, and a mapping change is exactly when it should
  // start again — the rows it already imported were mapped by the old rules.
  await runner(RESOURCES).where({ tenant_id: tenantId, connector_id: connectorId }).del();

  for (const resource of resources) {
    const [inserted] = await runner(RESOURCES)
      .insert({
        tenant_id: tenantId,
        connector_id: connectorId,
        entity: resource.entity,
        path: resource.path,
        method: resource.method,
        items_pointer: resource.itemsPointer,
        remote_id_pointer: resource.remoteIdPointer,
        updated_at_pointer: resource.updatedAtPointer,
        page_param: resource.pageParam,
        page_size_param: resource.pageSizeParam,
        page_size: resource.pageSize,
      })
      .returning<Array<{ id: string }>>('id');

    if (!inserted) throw new Error('resource insert returned no id');
    if (resource.fieldMaps.length === 0) continue;

    await runner(FIELD_MAPS).insert(
      resource.fieldMaps.map((map) => ({
        tenant_id: tenantId,
        resource_id: inserted.id,
        local_field: map.localField,
        remote_pointer: map.remotePointer,
        transform: map.transform,
        on_conflict: map.onConflict,
        is_required: map.isRequired,
      })),
    );
  }

  await runner(CONNECTORS)
    .where({ tenant_id: tenantId, id: connectorId })
    .increment('mapping_version', 1);
}

export async function advanceWatermark(
  tenantId: string,
  resourceId: string,
  watermark: string,
  runner: Runner = db(),
): Promise<void> {
  await runner(RESOURCES).where({ tenant_id: tenantId, id: resourceId }).update({ watermark });
}

// --- Links -----------------------------------------------------------------

export interface ConnectorLink {
  remoteId: string;
  localId: string;
  remoteHash: string;
}

export async function findLink(
  tenantId: string,
  connectorId: string,
  entity: string,
  remoteId: string,
  runner: Runner = db(),
): Promise<ConnectorLink | null> {
  const row = await runner(LINKS)
    .where({ tenant_id: tenantId, connector_id: connectorId, entity, remote_id: remoteId })
    .first<{ remote_id: string; local_id: string; remote_hash: string } | undefined>();

  return row
    ? { remoteId: row.remote_id, localId: row.local_id, remoteHash: row.remote_hash }
    : null;
}

export async function upsertLink(
  tenantId: string,
  connectorId: string,
  entity: string,
  link: ConnectorLink,
  runner: Runner = db(),
): Promise<void> {
  await runner(LINKS)
    .insert({
      tenant_id: tenantId,
      connector_id: connectorId,
      entity,
      remote_id: link.remoteId,
      local_id: link.localId,
      remote_hash: link.remoteHash,
      last_seen_at: runner.fn.now(),
    })
    .onConflict(['connector_id', 'entity', 'remote_id'])
    .merge(['local_id', 'remote_hash', 'last_seen_at']);
}

// --- Runs ------------------------------------------------------------------

interface RunRow {
  id: string;
  connector_id: string;
  mode: string;
  trigger: string;
  mapping_version: number;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  read_count: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  failed_count: number;
  errors: unknown;
}

export async function startRun(
  tenantId: string,
  connectorId: string,
  mode: ConnectorRunMode,
  trigger: ConnectorRunTrigger,
  mappingVersion: number,
  runner: Runner = db(),
): Promise<number> {
  const [row] = await runner(RUNS)
    .insert({
      tenant_id: tenantId,
      connector_id: connectorId,
      mode,
      trigger,
      mapping_version: mappingVersion,
    })
    .returning<Array<{ id: string }>>('id');

  if (!row) throw new Error('run insert returned no id');
  return Number(row.id);
}

export async function finishRun(
  tenantId: string,
  runId: number,
  outcome: {
    status: ConnectorRunStatus;
    read: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    errors: ConnectorRowResult[];
  },
  runner: Runner = db(),
): Promise<void> {
  await runner(RUNS)
    .where({ tenant_id: tenantId, id: runId })
    .update({
      finished_at: runner.fn.now(),
      status: outcome.status,
      read_count: outcome.read,
      created_count: outcome.created,
      updated_count: outcome.updated,
      skipped_count: outcome.skipped,
      failed_count: outcome.failed,
      errors: JSON.stringify(outcome.errors),
    });
}

export async function listRuns(
  tenantId: string,
  connectorId: string,
  limit = 20,
  runner: Runner = db(),
): Promise<ConnectorRun[]> {
  const rows = await runner(RUNS)
    .where({ tenant_id: tenantId, connector_id: connectorId })
    .orderBy('started_at', 'desc')
    .limit(limit)
    .select<RunRow[]>('*');

  return rows.map(mapRun);
}

export async function findLatestSuccessfulDryRun(
  tenantId: string,
  connectorId: string,
  mappingVersion: number,
  runner: Runner = db(),
): Promise<ConnectorRun | null> {
  const row = await runner(RUNS)
    .where({
      tenant_id: tenantId,
      connector_id: connectorId,
      mode: 'dry_run',
      mapping_version: mappingVersion,
    })
    .whereIn('status', ['ok', 'partial'])
    .orderBy('started_at', 'desc')
    .first<RunRow | undefined>();

  return row ? mapRun(row) : null;
}

/**
 * Mark anything left `running` as failed.
 *
 * A run is in-process state: a Master that was killed mid-import leaves a row
 * claiming to be running for ever, and the overlap guard would then refuse that
 * connector until somebody edited the database.
 */
export async function failStaleRuns(
  olderThanMinutes: number,
  runner: Runner = db(),
): Promise<number> {
  return runner(RUNS)
    .where({ status: 'running' })
    .where(
      'started_at',
      '<',
      runner.raw(`now() - interval '${Math.floor(olderThanMinutes)} minutes'`),
    )
    .update({ status: 'failed', finished_at: runner.fn.now() });
}

function mapRun(row: RunRow): ConnectorRun {
  return {
    id: Number(row.id),
    connectorId: row.connector_id,
    mode: row.mode as ConnectorRunMode,
    trigger: row.trigger as ConnectorRunTrigger,
    mappingVersion: row.mapping_version,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    status: row.status as ConnectorRunStatus,
    read: row.read_count,
    created: row.created_count,
    updated: row.updated_count,
    skipped: row.skipped_count,
    failed: row.failed_count,
    errors: Array.isArray(row.errors) ? (row.errors as ConnectorRowResult[]) : [],
  };
}

/** Every connector due for a periodic run, across tenants. */
export async function listScheduled(
  runner: Runner = db(),
): Promise<
  Array<{ id: string; tenantId: string; intervalMin: number | null; lastRunAt: Date | null }>
> {
  const rows = await runner(CONNECTORS)
    .where({ is_enabled: true, schedule_kind: 'periodic' })
    .select<
      Array<{
        id: string;
        tenant_id: string;
        interval_min: number | null;
        last_run_at: Date | null;
      }>
    >('id', 'tenant_id', 'interval_min', 'last_run_at');

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    intervalMin: row.interval_min,
    lastRunAt: row.last_run_at,
  }));
}
