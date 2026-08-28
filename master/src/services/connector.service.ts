/**
 * Connectors as records: create, change, delete, and set their mapping.
 *
 * **The SSRF guard rejects one thing: this Master's own origin.** Loopback and
 * private ranges are deliberately *allowed*, because the shop LAN has no
 * internet and the system this feature exists to talk to runs on the shop PC
 * itself — a guard that blocked `127.0.0.0/8` would block the only target
 * anybody has. What it must stop is a connector pointed back at `/api/v1`,
 * which would let a mapping recurse into this process with its own authority.
 *
 * A credential is write-only from the outside: it arrives on an input, is
 * sealed by the repository, and no read path returns it. `credentialConfigured`
 * is the only thing a caller learns.
 *
 * Any field-map write bumps `mapping_version`, and an import is refused unless
 * a successful dry run exists at the current version. That is the whole safety
 * story for a feature that writes to the catalogue in bulk: somebody must have
 * seen what it was going to do, at the rules it is going to do it under.
 */

import {
  CONNECTOR_FLAGGABLE_FIELDS,
  CONNECTOR_MIN_INTERVAL_MIN,
  CONNECTOR_TRANSFORMS,
  type Connector,
  type ConnectorEntity,
  type ConnectorInput,
  type ConnectorProfile,
  type ConnectorResourceInput,
  type ConnectorFieldMapInput,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as connectorRepo from '../repositories/connector.repository.js';
import { CONNECTOR_PROFILES } from './connector-profiles.js';

export async function listConnectors(actor: ActorContext): Promise<Connector[]> {
  requirePermission(actor, 'api.manage');
  return connectorRepo.listConnectors(actor.tenantId);
}

export async function getConnector(actor: ActorContext, id: string): Promise<Connector> {
  requirePermission(actor, 'api.manage');

  const connector = await connectorRepo.findConnector(actor.tenantId, id);
  if (!connector) throw new NotFoundError('Connection');
  return connector;
}

export async function createConnector(
  actor: ActorContext,
  input: ConnectorInput,
): Promise<Connector> {
  requirePermission(actor, 'api.manage');

  const values = validated(input);

  const id = await db().transaction(async (trx) => {
    const created = await connectorRepo.insertConnector(actor.tenantId, values, trx);

    if (input.credential) {
      await connectorRepo.writeCredential(actor.tenantId, created, input.credential, trx);
    }

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'connector',
        entityId: created,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // The label and where it points. Never the credential.
        details: { name: input.label, baseUrl: values.base_url },
      },
      actor,
      trx,
    );

    return created;
  });

  return getConnector(actor, id);
}

export async function updateConnector(
  actor: ActorContext,
  id: string,
  input: ConnectorInput,
): Promise<Connector> {
  requirePermission(actor, 'api.manage');

  const existing = await connectorRepo.findConnector(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Connection');

  const values = validated(input);

  await db().transaction(async (trx) => {
    await connectorRepo.updateConnector(actor.tenantId, id, values, trx);

    // Absent leaves whatever is stored; `null` clears it. Those are different
    // requests, and a form that always sent the field would otherwise wipe a
    // credential every time somebody renamed the connection.
    if (input.credential !== undefined) {
      await connectorRepo.writeCredential(actor.tenantId, id, input.credential, trx);
    }

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'connector',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: input.label },
      },
      actor,
      trx,
    );
  });

  return getConnector(actor, id);
}

export async function deleteConnector(actor: ActorContext, id: string): Promise<void> {
  requirePermission(actor, 'api.manage');

  await db().transaction(async (trx) => {
    const existing = await connectorRepo.findConnector(actor.tenantId, id, trx);
    if (!existing) throw new NotFoundError('Connection');

    await connectorRepo.deleteConnector(actor.tenantId, id, trx);
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'connector',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.label },
      },
      actor,
      trx,
    );
  });
}

/**
 * Replace this connector's resources and their field maps.
 *
 * Wholesale, and it bumps `mapping_version` — which is what makes the dry-run
 * requirement mean something. A mapping edited after a dry run is a mapping
 * nobody has seen the consequences of.
 */
export async function setMapping(
  actor: ActorContext,
  id: string,
  resources: Array<ConnectorResourceInput & { fieldMaps: ConnectorFieldMapInput[] }>,
): Promise<Connector> {
  requirePermission(actor, 'api.manage');

  const existing = await connectorRepo.findConnector(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Connection');

  const prepared = resources.map((resource) => {
    if (!resource.remoteIdPointer?.trim()) {
      throw new ValidationError('validation.connector.remoteIdRequired');
    }

    const entity = assertEntity(resource.entity);

    return {
      entity,
      path: resource.path?.trim() ?? '',
      method: resource.method === 'POST' ? 'POST' : 'GET',
      itemsPointer: resource.itemsPointer ?? '',
      remoteIdPointer: resource.remoteIdPointer.trim(),
      updatedAtPointer: resource.updatedAtPointer ?? null,
      pageParam: resource.pageParam ?? null,
      pageSizeParam: resource.pageSizeParam ?? null,
      pageSize: resource.pageSize ?? null,
      fieldMaps: (resource.fieldMaps ?? []).map((map) => {
        const transform = map.transform ?? null;
        if (transform !== null && !CONNECTOR_TRANSFORMS.includes(transform)) {
          throw new ValidationError('validation.connector.transformUnknown');
        }

        const onConflict = map.onConflict ?? 'remote_wins';
        // `flag` writes nothing and raises a row on the Conflicts screen, so it
        // is only offered where the conflict restorer can actually put the old
        // value back. Anywhere else it would produce a conflict nobody can
        // resolve.
        if (onConflict === 'flag' && !CONNECTOR_FLAGGABLE_FIELDS[entity].includes(map.localField)) {
          throw new ValidationError('validation.connector.notFlaggable', {
            field: map.localField,
          });
        }

        return {
          localField: map.localField,
          remotePointer: map.remotePointer,
          transform,
          onConflict,
          isRequired: map.isRequired ?? false,
        };
      }),
    };
  });

  await db().transaction(async (trx) => {
    await connectorRepo.replaceResources(actor.tenantId, id, prepared, trx);
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'connector',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.label, mapping: true },
      },
      actor,
      trx,
    );
  });

  return getConnector(actor, id);
}

/** The ready-made profiles, so "create from profile" is data and not a code path. */
export function listProfiles(actor: ActorContext): readonly ConnectorProfile[] {
  requirePermission(actor, 'api.manage');
  return CONNECTOR_PROFILES;
}

export async function createFromProfile(
  actor: ActorContext,
  slug: string,
  overrides: { label?: string; baseUrl?: string },
): Promise<Connector> {
  requirePermission(actor, 'api.manage');

  const profile = CONNECTOR_PROFILES.find((candidate) => candidate.slug === slug);
  if (!profile) throw new NotFoundError('Connection profile');

  const connector = await createConnector(actor, {
    slug: profile.slug,
    label: overrides.label ?? profile.label,
    baseUrl: overrides.baseUrl ?? profile.baseUrl,
    authKind: profile.authKind,
    authHeader: profile.authHeader ?? null,
    scheduleKind: 'manual',
    profileSlug: profile.slug,
  });

  return setMapping(actor, connector.id, profile.resources);
}

// --- Validation ------------------------------------------------------------

function assertEntity(entity: string): ConnectorEntity {
  if (entity !== 'party' && entity !== 'product') {
    throw new ValidationError('validation.connector.entityUnknown');
  }
  return entity;
}

/**
 * Where a connector may point.
 *
 * `http:` or `https:` only — a `file:` URL would turn a mapping form into a way
 * to read the Master's own disk — and never this process's own origin, which is
 * the recursion guard. Everything else on the LAN is allowed on purpose.
 */
export function assertReachableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('validation.connector.urlInvalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('validation.connector.urlScheme');
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];
  if (port === config.http.port && local.includes(url.hostname)) {
    throw new ValidationError('validation.connector.urlSelf');
  }

  return url;
}

function validated(input: ConnectorInput): Record<string, unknown> {
  const slug = input.slug?.trim();
  const label = input.label?.trim();
  if (!slug) throw new ValidationError('validation.connector.slugRequired');
  if (!label) throw new ValidationError('validation.connector.labelRequired');

  const url = assertReachableUrl(input.baseUrl ?? '');

  const scheduleKind = input.scheduleKind ?? 'manual';
  const intervalMin = input.intervalMin ?? null;
  if (scheduleKind === 'periodic') {
    // Below five minutes a poll stops being a schedule and becomes a load
    // generator against somebody else's server as well as this one.
    if (!intervalMin || intervalMin < CONNECTOR_MIN_INTERVAL_MIN) {
      throw new ValidationError('validation.connector.intervalTooShort', {
        minutes: CONNECTOR_MIN_INTERVAL_MIN,
      });
    }
  }

  return {
    slug,
    label,
    base_url: url.toString(),
    auth_kind: input.authKind ?? 'none',
    auth_header: input.authHeader ?? null,
    auth_username: input.authUsername ?? null,
    schedule_kind: scheduleKind,
    interval_min: scheduleKind === 'periodic' ? intervalMin : null,
    run_as_user_id: input.runAsUserId ?? null,
    profile_slug: input.profileSlug ?? null,
    is_enabled: input.isEnabled ?? false,
  };
}
