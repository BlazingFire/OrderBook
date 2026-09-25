/**
 * Testing a connection, and running an import.
 *
 * `fetch` and `AbortSignal.timeout` from Node 22 — no HTTP client dependency
 * for what is a GET with a header on it.
 *
 * **Writes go through the services, never SQL.** `catalogService.createParty`
 * and friends are what carry validation, party access, `publishChange` and the
 * audit trail; a repository call from here would have to reimplement all four
 * and would drift from the browser's behaviour the first time one of them
 * changed. The actor is a real principal — `actorType: 'connector'` with
 * the connector's id for audit, and the authority of the user the connection
 * runs as. `systemActor` is unusable on purpose: its `permissions` is `null`,
 * so `requirePermission` refuses everything.
 *
 * **One transaction per row, and partial failure is the normal outcome.** Each
 * service call opens its own transaction, so row seven failing leaves rows one
 * to six imported and reports `'partial'`. The alternative — one transaction
 * for the whole run — turns one bad remote record into an import that never
 * succeeds and gives nobody a way to see which record it was.
 *
 * **Two idempotency layers.** `api_connector_links` turns a re-import into an
 * update rather than a duplicate; `remote_hash` turns an unchanged row into a
 * zero-write skip. The second is also the loop guard for an `on_change`
 * connector: a change event carries no actor, so "would this write anything?"
 * is the only available way to tell our own echo from a real remote edit.
 */

import type {
  ConnectorEntity,
  ConnectorFieldMap,
  ConnectorResource,
  ConnectorRowResult,
  ConnectorRunMode,
  ConnectorRunStatus,
  ConnectorRunTrigger,
  ConnectorTestResult,
  Party,
  Product,
} from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { requirePermission } from '../domain/actor.js';
import { changedFields, mapRow } from '../domain/connector-mapping.js';
import { flattenPointers, readPointer } from '../domain/json-pointer.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as connectorRepo from '../repositories/connector.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import * as catalogService from './catalog.service.js';
import { assertReachableUrl } from './connector.service.js';

const log = createLogger('connector');

const REQUEST_TIMEOUT_MS = 10_000;
/** Enough to see the shape of the failure without turning a log into a bomb. */
const MAX_REPORTED_ERRORS = 50;
const MAX_PAGES = 200;

/** Retried: a network blip and the four "come back later" statuses. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

interface RunOutcome {
  status: ConnectorRunStatus;
  read: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: ConnectorRowResult[];
}

/**
 * One request, with the connector's authentication on it.
 *
 * The credential is unsealed here and used immediately; it is never returned,
 * logged, or put on an error. A run error that echoed request headers would put
 * the credential in `api_connector_runs.errors`, which is read by a screen.
 */
async function callRemote(
  connector: {
    id: string;
    baseUrl: string;
    authKind: string;
    authHeader: string | null;
    authUsername: string | null;
  },
  tenantId: string,
  path: string,
  method: string,
  query: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const url = assertReachableUrl(new URL(path, connector.baseUrl).toString());
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const headers: Record<string, string> = { accept: 'application/json' };
  const credential =
    connector.authKind === 'none'
      ? null
      : await connectorRepo.openCredential(tenantId, connector.id);

  if (connector.authKind !== 'none' && !credential) {
    throw new ValidationError('validation.connector.credentialMissing');
  }

  if (connector.authKind === 'bearer') headers.authorization = `Bearer ${credential}`;
  if (connector.authKind === 'header' && connector.authHeader) {
    headers[connector.authHeader.toLowerCase()] = credential ?? '';
  }
  if (connector.authKind === 'basic') {
    const pair = `${connector.authUsername ?? ''}:${credential ?? ''}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // A 4xx that is not a rate limit is the remote saying no. Retrying it
      // three times just makes the same mistake more slowly.
      if (!RETRY_STATUSES.has(response.status)) {
        const text = await response.text();
        return { status: response.status, body: text ? safeJson(text) : null };
      }

      lastError = new Error(`Remote answered ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }

  throw lastError instanceof Error ? lastError : new Error('The remote system did not answer');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one page and describe what came back.
 *
 * The sample pointers are the point: they are what the mapping editor's remote
 * field picker offers, so "test the connection" and "discover the schema" are
 * one action rather than two.
 */
export async function testConnection(
  actor: ActorContext,
  connectorId: string,
  entity: ConnectorEntity,
): Promise<ConnectorTestResult> {
  requirePermission(actor, 'api.manage');

  const connector = await connectorRepo.findConnector(actor.tenantId, connectorId);
  if (!connector) throw new NotFoundError('Connection');

  const resource = connector.resources.find((candidate) => candidate.entity === entity);
  if (!resource) throw new NotFoundError('Connection resource');

  try {
    const { status, body } = await callRemote(
      connector,
      actor.tenantId,
      resource.path,
      resource.method,
      resource.pageSizeParam && resource.pageSize
        ? { [resource.pageSizeParam]: String(Math.min(resource.pageSize, 5)) }
        : {},
    );

    const items = readPointer(body, resource.itemsPointer);
    const rows = Array.isArray(items) ? items : [];

    return {
      ok: status >= 200 && status < 300,
      status,
      itemCount: rows.length,
      samplePointers: rows.length > 0 ? flattenPointers(rows[0]) : [],
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      itemCount: 0,
      samplePointers: [],
      // The message only. Never the headers, which carry the credential.
      error: error instanceof Error ? error.message : 'The remote system did not answer',
    };
  }
}

/**
 * The actor an import writes as.
 *
 * Its own principal for audit and the run-as user's for authority, exactly like
 * an API key — and for the same reasons: the row hash covers `actor_type` and
 * `actor_id`, and party access is keyed on a user.
 */
async function connectorActor(
  tenantId: string,
  connector: { id: string; label: string; runAsUserId: string | null },
): Promise<ActorContext> {
  if (!connector.runAsUserId) throw new ValidationError('validation.connector.runAsRequired');

  const user = await userRepo.findById(tenantId, connector.runAsUserId);
  if (!user) throw new ValidationError('validation.connector.runAsRequired');

  const permissions = await permissionSetForRole(tenantId, user.roleId);

  return {
    tenantId,
    actorType: 'connector',
    actorId: connector.id,
    userId: user.id,
    permissions,
    deviceCode: `CONN:${connector.id}`,
    actorName: `${user.displayName} via ${connector.label}`,
  };
}

export async function runConnector(
  actor: ActorContext,
  connectorId: string,
  mode: ConnectorRunMode,
  trigger: ConnectorRunTrigger = 'manual',
): Promise<RunOutcome & { runId: number }> {
  requirePermission(actor, 'api.manage');

  const connector = await connectorRepo.findConnector(actor.tenantId, connectorId);
  if (!connector) throw new NotFoundError('Connection');

  /*
   * A real import needs a dry run at this exact mapping version.
   *
   * Any field-map write bumps the version, so "somebody looked at what this
   * would do" cannot be satisfied by a dry run against rules that have since
   * changed. This is the whole safety story for a bulk write path.
   */
  if (mode === 'import') {
    const proof = await connectorRepo.findLatestSuccessfulDryRun(
      actor.tenantId,
      connectorId,
      connector.mappingVersion,
    );
    if (!proof) throw new ValidationError('validation.connector.dryRunRequired');
  }

  const writer = mode === 'import' ? await connectorActor(actor.tenantId, connector) : actor;
  const runId = await connectorRepo.startRun(
    actor.tenantId,
    connectorId,
    mode,
    trigger,
    connector.mappingVersion,
  );

  const outcome: RunOutcome = {
    status: 'ok',
    read: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  try {
    for (const resource of connector.resources) {
      await runResource(connector, resource, writer, mode, outcome);
    }

    if (outcome.failed > 0) outcome.status = 'partial';
  } catch (error) {
    outcome.status = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    if (outcome.errors.length < MAX_REPORTED_ERRORS) {
      outcome.errors.push({
        remoteId: '',
        action: 'error',
        localId: null,
        changes: [],
        error: message,
      });
    }
    log.warn(`Connector ${connector.slug} failed: ${message}`);
  }

  await connectorRepo.finishRun(actor.tenantId, runId, outcome);
  await connectorRepo.updateConnector(
    actor.tenantId,
    connectorId,
    {
      last_run_at: db().fn.now(),
      last_status: outcome.status,
      last_error: outcome.errors[0]?.error ?? null,
    },
    db(),
  );

  if (mode === 'import') {
    await activityLog.recordDetachedActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'connector',
        entityId: connectorId,
        action: 'ran',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          name: connector.label,
          created: outcome.created,
          updated: outcome.updated,
          failed: outcome.failed,
        },
      },
      actor,
      db(),
    );
  }

  return { ...outcome, runId };
}

async function runResource(
  connector: Awaited<ReturnType<typeof connectorRepo.findConnector>> & object,
  resource: ConnectorResource,
  writer: ActorContext,
  mode: ConnectorRunMode,
  outcome: RunOutcome,
): Promise<void> {
  let page = 1;
  let highWatermark = resource.watermark;

  for (;;) {
    const query: Record<string, string> = {};
    if (resource.pageParam) query[resource.pageParam] = String(page);
    if (resource.pageSizeParam && resource.pageSize) {
      query[resource.pageSizeParam] = String(resource.pageSize);
    }

    const { body } = await callRemote(
      connector,
      writer.tenantId,
      resource.path,
      resource.method,
      query,
    );

    const items = readPointer(body, resource.itemsPointer);
    const rows = Array.isArray(items) ? items : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      outcome.read += 1;
      const result = await importRow(connector, resource, row, writer, mode);

      if (result.action === 'create') outcome.created += 1;
      else if (result.action === 'update') outcome.updated += 1;
      else if (result.action === 'skip') outcome.skipped += 1;
      else {
        outcome.failed += 1;
        if (outcome.errors.length < MAX_REPORTED_ERRORS) outcome.errors.push(result);
      }

      if (resource.updatedAtPointer) {
        const stamp = readPointer(row, resource.updatedAtPointer);
        if (typeof stamp === 'string' && (!highWatermark || stamp > highWatermark)) {
          highWatermark = stamp;
        }
      }
    }

    // Not paged, or the last page.
    if (!resource.pageParam || !resource.pageSize || rows.length < resource.pageSize) break;

    page += 1;
    if (page > MAX_PAGES) {
      // Said out loud rather than silently truncated: a run that stopped early
      // must not read as a run that covered everything.
      outcome.errors.push({
        remoteId: '',
        action: 'error',
        localId: null,
        changes: [],
        error: `Stopped after ${MAX_PAGES} pages`,
      });
      outcome.failed += 1;
      break;
    }
  }

  // The watermark advances only on a real import that got this far. A dry run
  // must be repeatable, and a failed page must be re-read next time.
  if (mode === 'import' && highWatermark && highWatermark !== resource.watermark) {
    await connectorRepo.advanceWatermark(writer.tenantId, resource.id, highWatermark);
  }
}

async function importRow(
  connector: { id: string; slug: string },
  resource: ConnectorResource,
  row: unknown,
  writer: ActorContext,
  mode: ConnectorRunMode,
): Promise<ConnectorRowResult> {
  const remoteId = String(readPointer(row, resource.remoteIdPointer) ?? '');
  if (!remoteId) {
    return {
      remoteId: '',
      action: 'error',
      localId: null,
      changes: [],
      error: 'The remote row has no id at the configured pointer',
    };
  }

  const mapped = mapRow(row, resource.fieldMaps);
  if (mapped.missing.length > 0) {
    return {
      remoteId,
      action: 'error',
      localId: null,
      changes: [],
      error: `Missing required fields: ${mapped.missing.join(', ')}`,
    };
  }

  const link = await connectorRepo.findLink(
    writer.tenantId,
    connector.id,
    resource.entity,
    remoteId,
  );

  const existing = link ? await findLocal(writer.tenantId, resource.entity, link.localId) : null;

  // A link whose target is gone is a create, not an error: somebody deleted the
  // record here and the remote still has it.
  if (link && existing && link.remoteHash === mapped.hash) {
    return { remoteId, action: 'skip', localId: link.localId, changes: [] };
  }

  try {
    if (!existing) {
      if (mode === 'dry_run')
        return { remoteId, action: 'create', localId: null, changes: Object.keys(mapped.input) };

      const created = await createLocal(resource.entity, mapped.input, writer);
      await connectorRepo.upsertLink(writer.tenantId, connector.id, resource.entity, {
        remoteId,
        localId: created.id,
        remoteHash: mapped.hash,
      });

      return {
        remoteId,
        action: 'create',
        localId: created.id,
        changes: Object.keys(mapped.input),
      };
    }

    const record = existing as unknown as Record<string, unknown>;
    const changes = changedFields(record, mapped.input);
    if (changes.length === 0) {
      if (mode === 'import') {
        await connectorRepo.upsertLink(writer.tenantId, connector.id, resource.entity, {
          remoteId,
          localId: existing.id,
          remoteHash: mapped.hash,
        });
      }
      return { remoteId, action: 'skip', localId: existing.id, changes: [] };
    }

    const { applied, flagged } = splitByConflictRule(resource.fieldMaps, changes);

    if (mode === 'dry_run') {
      return { remoteId, action: 'update', localId: existing.id, changes };
    }

    if (flagged.length > 0) {
      await raiseConflicts(
        connector.slug,
        resource.entity,
        existing.id,
        record,
        mapped.input,
        flagged,
        writer,
      );
    }

    if (applied.length > 0) {
      const merged = { ...record };
      for (const field of applied) merged[field] = mapped.input[field];
      await updateLocal(resource.entity, existing.id, merged, writer);
    }

    await connectorRepo.upsertLink(writer.tenantId, connector.id, resource.entity, {
      remoteId,
      localId: existing.id,
      remoteHash: mapped.hash,
    });

    return { remoteId, action: 'update', localId: existing.id, changes: applied };
  } catch (error) {
    return {
      remoteId,
      action: 'error',
      localId: existing?.id ?? null,
      changes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Which changed fields are written and which are raised as conflicts.
 *
 * `local_wins` is neither: it is a field the remote is not allowed to touch, so
 * it silently keeps what we hold. That is the point of offering it.
 */
function splitByConflictRule(
  fieldMaps: readonly ConnectorFieldMap[],
  changes: string[],
): { applied: string[]; flagged: string[] } {
  const rules = new Map(fieldMaps.map((map) => [map.localField, map.onConflict]));

  return {
    applied: changes.filter((field) => (rules.get(field) ?? 'remote_wins') === 'remote_wins'),
    flagged: changes.filter((field) => rules.get(field) === 'flag'),
  };
}

/**
 * Raise a row on the existing Conflicts screen rather than writing.
 *
 * The HLC is ours because there is no meaningful remote one — a remote
 * `updated_at` is not causally ordered with this installation's clock, which is
 * exactly why these fields are flagged instead of merged. The device codes say
 * which side is which in the language that screen already speaks.
 */
async function raiseConflicts(
  slug: string,
  entity: ConnectorEntity,
  entityId: string,
  existing: Record<string, unknown>,
  input: Record<string, unknown>,
  fields: string[],
  writer: ActorContext,
): Promise<void> {
  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    await syncRepo.recordConflicts(
      fields.map((field) => ({
        tenantId: writer.tenantId,
        entity,
        entityId,
        field,
        losingValue: input[field],
        losingHlc: hlc,
        losingDeviceCode: `CONN:${slug}`,
        winningValue: existing[field],
        winningHlc: hlc,
        winningDeviceCode: 'MASTER',
      })),
      trx,
    );
  });
}

async function findLocal(
  tenantId: string,
  entity: ConnectorEntity,
  id: string,
): Promise<Party | Product | null> {
  // Repository reads: the record as stored, the same base the public API's
  // PATCH merges over. Permission and party access are checked by the service
  // write, when one follows (`updateLocal`), not here.
  return entity === 'party'
    ? partyRepo.findPartyById(tenantId, id)
    : productRepo.findProductById(tenantId, id);
}

async function createLocal(
  entity: ConnectorEntity,
  input: Record<string, unknown>,
  writer: ActorContext,
): Promise<{ id: string }> {
  return entity === 'party'
    ? catalogService.createParty(input as never, writer)
    : catalogService.createProduct(withVariantFields(input, null) as never, writer);
}

async function updateLocal(
  entity: ConnectorEntity,
  id: string,
  merged: Record<string, unknown>,
  writer: ActorContext,
): Promise<void> {
  if (entity === 'party') await catalogService.updateParty(id, merged as never, writer);
  else await catalogService.updateProduct(id, withVariantFields(merged, merged) as never, writer);
}

/**
 * A remote item is one code, so the mapped `code` and `weightKg` become the
 * product's single variant. On an update the existing variant keeps its id
 * (stock and lines are keyed by it); a product the administrator has since
 * given colour variants is left alone — a connector cannot say which of
 * them the remote code means, so the code and weight are dropped and the
 * rest of the patch still lands.
 */
function withVariantFields(
  input: Record<string, unknown>,
  existing: Record<string, unknown> | null,
): Record<string, unknown> {
  const { code, weightKg, ...rest } = input;
  const variants = existing?.variants as Array<{ id: string; label: string | null }> | undefined;

  if (existing?.hasVariants === true) return rest;
  if (typeof code !== 'string' || !code.trim()) return rest;

  const current = variants?.[0];
  // A remote system that models no categories still has to land somewhere
  // the category-first search can reach; the administrator moves it later.
  const category =
    existing || rest.categoryId || (typeof rest.categoryName === 'string' && rest.categoryName.trim())
      ? {}
      : { categoryName: 'Imported' };
  return {
    ...rest,
    ...category,
    hasVariants: false,
    variants: [
      {
        ...(current ? { id: current.id } : {}),
        code: code.trim(),
        label: null,
        weightKg: typeof weightKg === 'number' && Number.isFinite(weightKg) ? weightKg : null,
      },
    ],
  };
}
