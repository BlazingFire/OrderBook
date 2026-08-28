/**
 * API keys, their scopes, and the one indexed lookup an authenticated request
 * costs.
 *
 * A request arrives carrying `obk_<prefix>_<secret>`. The prefix is the handle:
 * unique, indexed, and not a secret, so it can be found in one query and shown
 * in a list — exactly what `credentialFingerprint` is for an office panel. The
 * secret is compared against a sha256 digest with `timingSafeEqual`.
 *
 * **sha256, not scrypt.** `password.ts` uses scrypt because a human-chosen
 * password needs the work factor; a key is 256 bits of machine entropy and is
 * verified on every single request, where scrypt's ~40 ms would cap the whole
 * API near 25 requests a second on one core. The digest is one-way either way,
 * and the entropy is where the strength lives.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { API_KEY_TOKEN_PREFIX, type ApiKey } from '@orderbook/shared';

import { db } from '../db/knex.js';

type Runner = Knex | Knex.Transaction;

const TABLE = 'api_keys';
const SCOPES = 'api_key_scopes';

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  label: string;
  token_prefix: string;
  token_hash: string;
  owner_user_id: string;
  rate_limit_per_min: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

/** A row plus what authentication needs to decide, in one round trip. */
export interface ApiKeyAuthRow extends ApiKeyRow {
  scopes: string[];
  owner_role_id: string | null;
  owner_display_name: string;
  owner_deactivated: boolean;
}

export function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * `obk_<12 hex>_<43 base64url>`; the middle is the handle, the tail is the secret.
 *
 * The prefix is **hex, not base64url**, and the difference is load-bearing:
 * base64url's alphabet contains `_`, so a prefix could carry the separator and
 * a token would split into the wrong pieces roughly one time in five. The
 * secret keeps base64url for its density and `parseToken` rejoins whatever
 * follows the second separator, so an underscore in the secret is harmless.
 */
export function mintToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `${API_KEY_TOKEN_PREFIX}_${prefix}_${secret}`,
    prefix,
    hash: digest(secret),
  };
}

/** Splits a presented token without deciding anything about it. */
export function parseToken(raw: string): { prefix: string; secret: string } | null {
  const [scheme, prefix, ...rest] = raw.trim().split('_');
  // Rejoined, because the secret is base64url and may contain `_` itself.
  const secret = rest.join('_');
  if (scheme !== API_KEY_TOKEN_PREFIX || !prefix || !secret) return null;
  return { prefix, secret };
}

/**
 * Constant-time comparison, and constant-time about *length* too.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a signal;
 * hashing both sides first means the buffers are always 32 bytes.
 */
export function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(digest(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function findByPrefix(
  prefix: string,
  runner: Runner = db(),
): Promise<ApiKeyAuthRow | null> {
  const row = await runner(TABLE)
    .join('users as u', function joinOwner() {
      this.on('u.id', '=', `${TABLE}.owner_user_id`).andOn(
        'u.tenant_id',
        '=',
        `${TABLE}.tenant_id`,
      );
    })
    .where(`${TABLE}.token_prefix`, prefix)
    .first<
      | (ApiKeyRow & {
          owner_role_id: string | null;
          owner_display_name: string;
          owner_deactivated: boolean;
        })
      | undefined
    >(
      `${TABLE}.*`,
      'u.role_id as owner_role_id',
      'u.display_name as owner_display_name',
      db().raw('(u.deleted_at IS NOT NULL OR u.is_active = false) as owner_deactivated'),
    );

  if (!row) return null;

  const scopes = await runner(SCOPES)
    .where({ api_key_id: row.id, tenant_id: row.tenant_id })
    .pluck<string[]>('permission');

  return { ...row, scopes };
}

export async function listKeys(tenantId: string, runner: Runner = db()): Promise<ApiKey[]> {
  const rows = await runner(TABLE)
    .leftJoin('users as u', function joinOwner() {
      this.on('u.id', '=', `${TABLE}.owner_user_id`).andOn(
        'u.tenant_id',
        '=',
        `${TABLE}.tenant_id`,
      );
    })
    .where(`${TABLE}.tenant_id`, tenantId)
    .orderBy(`${TABLE}.created_at`, 'desc')
    .select<Array<ApiKeyRow & { owner_display_name: string | null }>>(
      `${TABLE}.*`,
      'u.display_name as owner_display_name',
    );

  if (rows.length === 0) return [];

  const scopeRows = await runner(SCOPES)
    .where({ tenant_id: tenantId })
    .select<Array<{ api_key_id: string; permission: string }>>('api_key_id', 'permission');

  const byKey = new Map<string, string[]>();
  for (const scope of scopeRows) {
    byKey.set(scope.api_key_id, [...(byKey.get(scope.api_key_id) ?? []), scope.permission]);
  }

  return rows.map((row) => mapApiKey(row, byKey.get(row.id) ?? []));
}

export async function insertKey(
  input: {
    tenantId: string;
    label: string;
    tokenPrefix: string;
    tokenHash: string;
    ownerUserId: string;
    rateLimitPerMin: number;
    expiresAt: string | null;
    createdByUserId: string | null;
    scopes: string[];
  },
  runner: Runner,
): Promise<string> {
  const [row] = await runner(TABLE)
    .insert({
      tenant_id: input.tenantId,
      label: input.label,
      token_prefix: input.tokenPrefix,
      token_hash: input.tokenHash,
      owner_user_id: input.ownerUserId,
      rate_limit_per_min: input.rateLimitPerMin,
      expires_at: input.expiresAt,
      created_by_user_id: input.createdByUserId,
    })
    .returning<Array<{ id: string }>>('id');

  const id = row?.id;
  if (!id) throw new Error('api key insert returned no id');

  if (input.scopes.length > 0) {
    await runner(SCOPES).insert(
      input.scopes.map((permission) => ({
        tenant_id: input.tenantId,
        api_key_id: id,
        permission,
      })),
    );
  }

  return id;
}

export async function revokeKey(
  tenantId: string,
  id: string,
  runner: Runner,
): Promise<ApiKeyRow | null> {
  const [row] = await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('revoked_at')
    .update({ revoked_at: runner.fn.now(), updated_at: runner.fn.now() })
    .returning<ApiKeyRow[]>('*');

  return row ?? null;
}

export async function findById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<ApiKeyRow | null> {
  const row = await runner(TABLE).where({ tenant_id: tenantId, id }).first<ApiKeyRow | undefined>();
  return row ?? null;
}

/**
 * Flush `last_used_at` for keys seen since the previous flush.
 *
 * Batched rather than written per request: a key used twice a second would
 * otherwise turn every read into a write, and the column is only ever read by a
 * human deciding whether a key is still in use.
 */
export async function touchKeys(seen: Map<string, Date>, runner: Runner = db()): Promise<void> {
  for (const [id, at] of seen) {
    await runner(TABLE).where({ id }).update({ last_used_at: at });
  }
}

/**
 * Row to wire shape.
 *
 * `token_hash` is destructured away rather than merely omitted, so adding a
 * column here cannot silently start returning it — the same discipline
 * `credential-invariants.test.ts` polices on the panel secret.
 */
export function mapApiKey(
  row: ApiKeyRow & { owner_display_name?: string | null },
  scopes: string[],
): ApiKey {
  const { token_hash: _hash, ...rest } = row;

  return {
    id: rest.id,
    label: rest.label,
    tokenPrefix: rest.token_prefix,
    ownerUserId: rest.owner_user_id,
    ownerName: row.owner_display_name ?? null,
    scopes: [...scopes].sort(),
    rateLimitPerMin: rest.rate_limit_per_min,
    expiresAt: rest.expires_at ? rest.expires_at.toISOString() : null,
    revokedAt: rest.revoked_at ? rest.revoked_at.toISOString() : null,
    lastUsedAt: rest.last_used_at ? rest.last_used_at.toISOString() : null,
    createdAt: rest.created_at.toISOString(),
  };
}
