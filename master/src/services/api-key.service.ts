/**
 * Issuing, listing and revoking the keys another program authenticates with.
 *
 * **A key never exceeds its owner.** Its scopes are stored as asked for, but
 * what it can actually do is computed at request time as the owner's current
 * role **intersected** with those scopes, with the tier ceiling re-applied. So
 * a key issued with `products.edit` whose owner later loses that permission
 * stops being able to edit products, without anybody having to remember to
 * re-issue it. Intersection, never union.
 *
 * The plaintext token exists for exactly one response. That mirrors the rule
 * the rest of this product already follows for credentials — `OneTimeSecret`
 * for a reset password, "recovery is a reset" for a panel — and it is what lets
 * the key list be safe to render.
 *
 * Revocation is a timestamp, not a delete. An `activity_log` row naming a key
 * that no longer exists would be an audit trail with a hole in it.
 */

import {
  API_KEY_RATE_LIMIT_DEFAULT,
  API_KEY_RATE_LIMIT_MAX,
  API_KEY_RATE_LIMIT_MIN,
  isPermission,
  type ApiKey,
  type ApiKeyInput,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as apiKeyRepo from '../repositories/api-key.repository.js';
import * as userRepo from '../repositories/user.repository.js';

/** The token, once. `key` is what the list will show from now on. */
export interface IssuedApiKey {
  key: ApiKey;
  token: string;
}

export async function listKeys(actor: ActorContext): Promise<ApiKey[]> {
  requirePermission(actor, 'api.manage');
  return apiKeyRepo.listKeys(actor.tenantId);
}

export async function issueKey(actor: ActorContext, input: ApiKeyInput): Promise<IssuedApiKey> {
  requirePermission(actor, 'api.manage');

  const label = input.label?.trim();
  if (!label) throw new ValidationError('validation.apiKey.labelRequired');

  const owner = await userRepo.findById(actor.tenantId, input.ownerUserId);
  if (!owner) throw new NotFoundError('User');

  /*
   * Scopes are checked against the catalogue here, not just intersected later.
   * A key listing a permission that does not exist would look, in the list,
   * like a key that has it — and the person reading that list is deciding
   * whether the key is safe.
   */
  const scopes = [...new Set(input.scopes ?? [])].filter((scope) => isPermission(scope)).sort();
  if (scopes.length === 0) throw new ValidationError('validation.apiKey.scopesRequired');

  const rateLimit = clampRate(input.rateLimitPerMin);
  const minted = apiKeyRepo.mintToken();

  const id = await db().transaction(async (trx) => {
    const created = await apiKeyRepo.insertKey(
      {
        tenantId: actor.tenantId,
        label,
        tokenPrefix: minted.prefix,
        tokenHash: minted.hash,
        ownerUserId: owner.id,
        rateLimitPerMin: rateLimit,
        expiresAt: input.expiresAt ?? null,
        createdByUserId: actorUserId(actor),
        scopes,
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'api_key',
        entityId: created,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // The label and the owner, never the token and never the digest.
        details: { name: label, ownerUserId: owner.id, scopes },
      },
      actor,
      trx,
    );

    return created;
  });

  const keys = await apiKeyRepo.listKeys(actor.tenantId);
  const key = keys.find((candidate) => candidate.id === id);
  if (!key) throw new NotFoundError('API key');

  return { key, token: minted.token };
}

export async function revokeKey(actor: ActorContext, id: string): Promise<ApiKey> {
  requirePermission(actor, 'api.manage');

  const revoked = await db().transaction(async (trx) => {
    const row = await apiKeyRepo.revokeKey(actor.tenantId, id, trx);
    if (!row) throw new NotFoundError('API key');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'api_key',
        entityId: row.id,
        action: 'revoked',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.label },
      },
      actor,
      trx,
    );

    return row;
  });

  const keys = await apiKeyRepo.listKeys(actor.tenantId);
  return keys.find((key) => key.id === revoked.id) ?? apiKeyRepo.mapApiKey(revoked, []);
}

function clampRate(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return API_KEY_RATE_LIMIT_DEFAULT;
  return Math.max(API_KEY_RATE_LIMIT_MIN, Math.min(Math.floor(value), API_KEY_RATE_LIMIT_MAX));
}
