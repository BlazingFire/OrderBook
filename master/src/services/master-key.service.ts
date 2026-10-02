/**
 * The master key gate (`shared/src/domain/master-key.ts` says what it guards).
 *
 * A second instance of the developer gate: the same lockout (five wrong keys
 * lock it for a minute, one counter for the whole process) and the same
 * short-lived in-memory tokens, checking `MASTER_KEY_HASH` instead. There is
 * no `.env` override.
 *
 * Every attempt is written to the activity log, right or wrong, detached: an
 * attempt changes nothing to be atomic with.
 */

import { MASTER_KEY_HASH, MASTER_KEY_TOKEN_TTL_MS, type MasterKeyUnlock } from '@orderbook/shared';

import { db } from '../db/knex.js';
import { systemActor, type ActorContext } from '../domain/actor.js';
import { UnauthorizedError } from '../lib/errors.js';
import { recordDetachedActivity } from '../repositories/activity-log.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import { createDeveloperGate, type DeveloperGate, type DeveloperGateOptions } from './developer-gate.js';

/**
 * A master-key gate. Tests pass their own `passwordHash` (and a fake clock),
 * so no test ever holds the real key.
 */
export function createMasterKeyGate(
  options: Pick<DeveloperGateOptions, 'now' | 'passwordHash'> = {},
): DeveloperGate {
  return createDeveloperGate({
    now: options.now,
    passwordHash: options.passwordHash ?? MASTER_KEY_HASH,
    // Never the developer password's `.env` override.
    overridePassword: () => undefined,
    wrongPasswordKey: 'error.unauthorized.masterKey',
    lockedKey: 'error.unauthorized.masterKeyRequired',
    passwordRequiredKey: 'validation.masterKey.required',
    tokenTtlMs: MASTER_KEY_TOKEN_TTL_MS,
  });
}

/*
 * Built on first use rather than at import: `developer.service.ts` imports
 * first-run setup, which reaches this file, so building it at import time would
 * call into a module that is still loading.
 */
let liveGate: DeveloperGate | undefined;
const gate = (): DeveloperGate => (liveGate ??= createMasterKeyGate());

/** The one gate the routes and services use. */
export const masterKeyGate: DeveloperGate = {
  unlock: (key) => gate().unlock(key),
  status: (token) => gate().status(token),
  lock: (token) => gate().lock(token),
  assertUnlocked: (token) => gate().assertUnlocked(token),
};

/** Who an unauthenticated master-key attempt is logged as: the PC it was typed on. */
export function masterPcActor(tenantId: string): ActorContext {
  return { ...systemActor(tenantId), actorName: 'Master PC' };
}

/**
 * Check a typed key and hand back a token, logging the attempt.
 *
 * `actor` is the signed-in user when there is one; recovery and the setup flow
 * run before anyone can sign in, and those are logged as the Master PC.
 */
export async function verifyMasterKey(
  key: unknown,
  actor: ActorContext | null,
  keyGate: DeveloperGate = masterKeyGate,
): Promise<MasterKeyUnlock> {
  const tenantId = actor?.tenantId ?? (await resolveDefaultTenantId());
  const who = actor ?? masterPcActor(tenantId);

  try {
    const unlock = await keyGate.unlock(key);
    await recordDetachedActivity(
      {
        tenantId,
        entityType: 'master_key',
        entityId: 'master_key',
        action: 'verified',
        actorType: who.actorType,
        actorId: who.actorId,
      },
      who,
      db(),
    );
    return unlock;
  } catch (error) {
    // A wrong key, not a lockout or an empty field: those were never a guess.
    if (error instanceof UnauthorizedError) {
      await recordDetachedActivity(
        {
          tenantId,
          entityType: 'master_key',
          entityId: 'master_key',
          action: 'failed',
          actorType: who.actorType,
          actorId: who.actorId,
        },
        who,
        db(),
      );
    }
    throw error;
  }
}
