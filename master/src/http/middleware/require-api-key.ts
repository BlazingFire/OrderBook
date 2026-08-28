/**
 * Turning a bearer token into an actor.
 *
 * Two indexed queries, and that is the honest cost: the key by its prefix, then
 * the owner's role. `permissionSetForRole` is described elsewhere as cached, but
 * it issues a `roles` SELECT on every call to read the version *before*
 * consulting that cache — which is the same order of cost `attachSession`
 * already pays for a browser request, and worth stating rather than claiming
 * the request is free.
 *
 * **The actor is its own principal for audit and somebody else's for
 * authority.** `actor_type='api_key'` with the key's uuid is what lands in
 * `activity_log`, and the row hash covers both — so "which key did this" is
 * answerable and tamper-evident. But `userId` is the owner's, because
 * `party_access` is keyed on a user and `resolvePartyScope` reads
 * `actorUserId(actor)`: a key sees exactly the parties its owner sees.
 *
 * Permissions are the owner's current role **intersected** with the key's
 * scopes, with the tier ceiling re-applied. Never a union — a key cannot be a
 * way to hold a permission its owner does not.
 *
 * **A failed authentication is not written to `activity_log`.** Every insert
 * there takes `pg_advisory_xact_lock(hashtext(tenant_id))`, so somebody spraying
 * guessed keys would serialise every audited write in the company. Failures go
 * to a counter and the process log.
 */

import type { NextFunction, Request, Response } from 'express';
import { effectivePermissions, type PermissionSet } from '@orderbook/shared';

import type { ActorContext } from '../../domain/actor.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import * as apiKeyRepo from '../../repositories/api-key.repository.js';
import { permissionSetForRole } from '../../repositories/role.repository.js';
import { consume, noteUsed } from './api-key-rate-limit.js';

const log = createLogger('api-key');

declare module 'express-serve-static-core' {
  interface Request {
    apiActor?: ActorContext;
    apiKeyId?: string;
    apiKeyLabel?: string;
  }
}

/** Failed attempts since boot, per presented prefix. Memory only, never a row. */
const failures = new Map<string, number>();

function noteFailure(prefix: string): void {
  const count = (failures.get(prefix) ?? 0) + 1;
  failures.set(prefix, count);
  // One line per failure is what makes a spray visible in the shell's log
  // without giving the database a write per guess.
  log.warn(`Rejected API key ${prefix} (${count} failed attempts since start)`);
}

export function failureCount(prefix: string): number {
  return failures.get(prefix) ?? 0;
}

export function resetApiKeyFailures(): void {
  failures.clear();
}

/** `Authorization: Bearer obk_…`, or `X-OrderBook-Key: obk_…`. */
function presentedToken(req: Request): string | null {
  const header = req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();

  const direct = req.header('x-orderbook-key');
  return direct ? direct.trim() : null;
}

export function requireApiKey(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    try {
      const raw = presentedToken(req);
      const parsed = raw ? apiKeyRepo.parseToken(raw) : null;
      if (!parsed) throw new UnauthorizedError('error.unauthorized.apiKeyInvalid');

      const row = await apiKeyRepo.findByPrefix(parsed.prefix);
      if (!row || !apiKeyRepo.secretMatches(parsed.secret, row.token_hash)) {
        noteFailure(parsed.prefix);
        throw new UnauthorizedError('error.unauthorized.apiKeyInvalid');
      }

      const now = Date.now();
      const expired = row.expires_at ? row.expires_at.getTime() <= now : false;
      if (row.revoked_at || expired || row.owner_deactivated) {
        noteFailure(parsed.prefix);
        throw new UnauthorizedError('error.unauthorized.apiKeyExpired');
      }

      // Counted before any work is done, so a key over its limit costs one map
      // lookup rather than a role query and a service call.
      consume(row.id, row.rate_limit_per_min, now);

      const role = await permissionSetForRole(row.tenant_id, row.owner_role_id);
      const scoped = intersect(role, row.scopes);

      req.apiKeyId = row.id;
      req.apiKeyLabel = row.label;
      req.apiActor = {
        tenantId: row.tenant_id,
        actorType: 'api_key',
        actorId: row.id,
        userId: row.owner_user_id,
        permissions: scoped,
        // Not a paired device. The prefix is what makes a stamped id traceable
        // back to one key without putting a secret in a temporary id.
        deviceCode: `API:${row.token_prefix}`,
        actorName: `${row.owner_display_name} via API key ${row.label}`,
      };

      noteUsed(row.id);
      next();
    } catch (error) {
      next(error);
    }
  })();
}

/**
 * The owner's role, narrowed to what the key was issued for.
 *
 * The tier ceiling is applied again on the way out rather than trusted from the
 * role: `effectivePermissions` is the one place that rule lives, and a key is
 * exactly the kind of long-lived credential that would otherwise carry an old
 * answer forward.
 */
function intersect(role: PermissionSet | null, scopes: string[]): PermissionSet | null {
  if (!role) return null;

  const allowed = new Set(scopes);
  return {
    ...role,
    permissions: effectivePermissions(
      role.permissions.filter((permission) => allowed.has(permission)),
      role.tier,
    ),
  };
}

/** The actor a `/api/v1` handler acts as. */
export function apiActorFromRequest(req: Request): ActorContext {
  if (!req.apiActor) throw new UnauthorizedError('error.unauthorized.apiKeyInvalid');
  return req.apiActor;
}
