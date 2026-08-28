/**
 * Sign-in and session resolution (docs/ROLES_AND_USERS.md §2, §4, §11).
 *
 * Sessions live in memory: the Master is a single long-running process on one
 * PC, and signing admins out on restart is acceptable — arguably correct — for
 * physically-local software.
 *
 * The part worth reading twice is `resolveSession`. A permission change must
 * take effect on the caller's **next call**, not after a timeout and not after a
 * re-login, so every resolution re-reads the role's `version` and rebuilds the
 * session's permissions when it moved. That read is a primary-key seek; there is
 * deliberately no TTL cache in front of it, because a time-based cache means a
 * revoked permission keeps working for the length of the TTL — exactly the
 * failure the rule exists to prevent.
 */

import { randomBytes } from 'node:crypto';
import type { ChangeOwnPasswordInput, SignedInUser, User } from '@orderbook/shared';
import { effectivePermissions } from '@orderbook/shared';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import * as panelCredentialRepo from '../repositories/panel-credential.repository.js';
import * as roleRepo from '../repositories/role.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { rememberPassword } from './password-vault.service.js';
import { clearRecentReauth, sweepRecentReauth } from './reauth-cache.js';

const log = createLogger('auth');

interface Session {
  userId: string;
  tenantId: string;
  roleId: string | null;
  /** The role version this session's permissions were derived from. */
  roleVersion: number;
  permissions: string[];
  expiresAt: number;
}

const sessions = new Map<string, Session>();

/** Failed attempts per username, for the lockout below. */
const failures = new Map<string, { count: number; lockedUntil: number }>();

const MAX_FAILURES = 3;
const LOCKOUT_MS = 60_000;

export async function signIn(
  username: string,
  password: string,
  /** Which machine the attempt came from, for the audit trail. */
  source?: string,
): Promise<{ token: string; user: SignedInUser; credentialFingerprint: string }> {
  const key = username?.trim().toLowerCase() ?? '';
  assertNotLockedOut(key);

  const credential = await userRepo.readCredentialForVerification(key);
  const { matches, needsUpgrade } = await verifyPassword(password, credential?.passwordHash ?? null);

  if (!credential || !matches) {
    recordFailure(key);
    await recordSignInAttempt(credential?.tenantId ?? null, key, false, undefined, source);
    // Deliberately generic. "No such user" versus "wrong password" is a
    // username oracle.
    throw new UnauthorizedError('error.unauthorized.signInFailed');
  }

  if (!credential.isActive) {
    // Recorded before throwing. Somebody trying a deactivated account is worth
    // seeing — it is either a person who does not know they were deactivated, or
    // somebody using credentials that should already have stopped working — and
    // this branch used to reach neither the trail nor the failure counter.
    recordFailure(key);
    await recordSignInAttempt(credential.tenantId, key, false, credential.id, source);

    // Distinguished from a bad password on purpose: this is not a guessing
    // signal, it is a fact the person needs in order to ask someone to fix it.
    throw new UnauthorizedError('error.unauthorized.accountDeactivated');
  }

  failures.delete(key);

  const permissionSet = await roleRepo.permissionSetForRole(credential.tenantId, credential.roleId);
  if (!permissionSet) {
    throw new UnauthorizedError('error.unauthorized.noRole');
  }

  await db().transaction(async (trx) => {
    await userRepo.touchLastSignIn(credential.id, trx);

    // Silent, one-time migration off bcrypt. The person is holding the correct
    // plaintext right now, which is the only moment the rewrite is possible.
    if (needsUpgrade) {
      const hlc = await nextHlc(trx);
      await userRepo.updateUserColumns(
        credential.tenantId,
        credential.id,
        { password_hash: await hashPassword(password) },
        { hlc, fieldHlc: {} },
        trx,
      );
      log.info(`Upgraded stored password for ${key} to scrypt`);
    }
  });

  await recordSignInAttempt(credential.tenantId, key, true, credential.id, source);

  const token = randomBytes(32).toString('base64url');
  const roleVersion = (await roleRepo.roleVersion(credential.tenantId, credential.roleId ?? '')) ?? 0;

  sessions.set(token, {
    userId: credential.id,
    tenantId: credential.tenantId,
    roleId: credential.roleId,
    roleVersion,
    // Intersected with the tier ceiling here as well as on save: a role row
    // that arrived over sync from a tampered replica carrying an admin key on
    // an office tier is stripped now and never enters the session.
    permissions: effectivePermissions(permissionSet.permissions, permissionSet.tier),
    expiresAt: Date.now() + config.session.ttlMs,
  });

  const user = await userRepo.findById(credential.tenantId, credential.id);
  if (!user) throw new UnauthorizedError('error.unauthorized.signInFailed');

  // Read after any bcrypt→scrypt rewrite above, so the panel stores a marker
  // for the hash that is now on disk rather than the one it replaced.
  const credentialFingerprint =
    (await panelCredentialRepo.fingerprintForUser(credential.tenantId, credential.id)) ?? '';

  // The password vault's back-fill, and the only reason it needs no migration:
  // this is the one moment the Master holds somebody's plaintext without having
  // just set it. A no-op unless the company switched the feature on, and after
  // the transaction so the fingerprint is the post-upgrade one.
  await rememberPassword(
    credential.tenantId,
    credential.id,
    password,
    credential.id,
    credentialFingerprint,
  );

  return {
    token,
    user: await decorate(user, token),
    credentialFingerprint,
  };
}

/**
 * Resolve a session, re-checking the role every time.
 *
 * Returns null — forcing a sign-out — when the role was deleted or the account
 * deactivated. Falling back to "no permissions" instead would leave someone
 * staring at an app where every button silently fails.
 */
export async function resolveSession(token: string | undefined): Promise<User | null> {
  const session = tokenSession(token);
  if (!session) return null;

  const user = await userRepo.findById(session.tenantId, session.userId);
  if (!user || !user.isActive) {
    if (token) sessions.delete(token);
    return null;
  }

  const permissionSet = await roleRepo.permissionSetForRole(session.tenantId, user.roleId);
  if (!permissionSet) {
    if (token) sessions.delete(token);
    return null;
  }

  const currentVersion = (await roleRepo.roleVersion(session.tenantId, user.roleId ?? '')) ?? 0;

  // The role moved (edited, or the user was reassigned): rebuild in place, so
  // the very next permission check uses the new set.
  if (currentVersion !== session.roleVersion || user.roleId !== session.roleId) {
    session.roleId = user.roleId;
    session.roleVersion = currentVersion;
    session.permissions = effectivePermissions(permissionSet.permissions, permissionSet.tier);
  }

  return user;
}

/**
 * Resolve a session, and say *why* when it fails.
 *
 * `resolveSession` collapses three different situations into `null`: the account
 * was revoked, the token expired, or this Master restarted and lost an in-memory
 * session map. That is fine for an HTTP request, which just signs the person out
 * either way — but an Office Panel holds an offline password verifier for that
 * person, and what it must do differs sharply. `revoked` means destroy it.
 * `expired` means keep it, because a Master reboot must not strip everybody's
 * ability to work offline.
 */
export async function resolveSessionDetailed(
  token: string | undefined,
): Promise<
  { status: 'active'; user: User } | { status: 'rejected'; reason: 'revoked' | 'expired' }
> {
  const session = tokenSession(token);

  // Not in the map: expired, or this process restarted. Not a statement about
  // the account, so it must not be reported as one.
  if (!session) return { status: 'rejected', reason: 'expired' };

  const user = await resolveSession(token);
  if (user) return { status: 'active', user };

  // The session existed and no longer resolves, which is a fact about the
  // account: deleted, deactivated, or its role removed.
  return { status: 'rejected', reason: 'revoked' };
}

/** The resolved permission set for a live session. */
export function sessionPermissions(token: string | undefined): string[] {
  return tokenSession(token)?.permissions ?? [];
}

export async function changeOwnPassword(
  input: ChangeOwnPasswordInput,
  userId: string,
  tenantId: string,
): Promise<void> {
  const user = await userRepo.findById(tenantId, userId);
  if (!user) throw new UnauthorizedError();

  // By id, not by username — this caller already knows who they are, and going
  // back through the username lookup was the second `readCredentialForVerification`
  // call site that made §11's "exactly one, forever" untrue.
  const credential = await userRepo.readCredentialById(tenantId, userId);
  const { matches } = await verifyPassword(input.currentPassword, credential?.passwordHash ?? null);

  // Changing your own password needs the current one, not `users.manage` —
  // otherwise nobody could change their own without administrative rights.
  if (!matches) throw new UnauthorizedError('error.unauthorized.currentPasswordIncorrect');

  if (!input.newPassword || input.newPassword.length < 8) {
    throw new ValidationError('validation.password.tooShort');
  }

  const passwordHash = await hashPassword(input.newPassword);

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    await userRepo.updateUserColumns(
      tenantId,
      userId,
      { password_hash: passwordHash },
      { hlc, fieldHlc: {} },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId,
        entityType: 'user',
        entityId: userId,
        action: 'password_changed',
        actorType: 'user',
        actorId: userId,
        details: { username: user.username },
      },
      {
        tenantId,
        actorType: 'user',
        actorId: userId,
        userId,
        permissions: null,
        deviceCode: null,
        actorName: user.displayName,
      },
      trx,
    );
  });

  await rememberPassword(tenantId, userId, input.newPassword, userId);

  invalidateSessionsForUser(userId, { except: undefined });
}

export function signOut(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/** Drop every session for a user — after a reset, a deactivation, or a delete. */
export function invalidateSessionsForUser(
  userId: string,
  options: { except?: string } = {},
): void {
  for (const [token, session] of sessions) {
    if (session.userId === userId && token !== options.except) sessions.delete(token);
  }
}

/**
 * Test seam: drop every session and every failed-attempt record.
 *
 * Both live in memory and survive a database truncate, so without this the
 * lockout from one test's deliberate wrong password locks out the next one.
 */
export function resetAuthState(): void {
  sessions.clear();
  failures.clear();
  clearRecentReauth();
}

export function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }

  // The reveal's re-authentication window rides the same sweep. An unswept map
  // keyed by session token is exactly the defect `failures` above still has.
  sweepRecentReauth();
}

/** Attach the caller's own resolved permissions, for the UI to render from. */
export async function decorate(user: User, token: string | undefined): Promise<SignedInUser> {
  const session = tokenSession(token);

  return {
    ...user,
    permissions: session?.permissions ?? [],
    roleVersion: session?.roleVersion ?? 0,
  };
}

function tokenSession(token: string | undefined): Session | null {
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function assertNotLockedOut(username: string): void {
  const record = failures.get(username);
  if (record && record.lockedUntil > Date.now()) {
    throw new UnauthorizedError('error.unauthorized.tooManyAttempts');
  }
}

function recordFailure(username: string): void {
  const record = failures.get(username) ?? { count: 0, lockedUntil: 0 };
  record.count += 1;

  if (record.count >= MAX_FAILURES) {
    record.lockedUntil = Date.now() + LOCKOUT_MS;
    record.count = 0;
  }

  failures.set(username, record);
}

/**
 * Record a sign-in attempt, successful or not (§9).
 *
 * This used to return early when the tenant was unknown — which is every failure
 * against a username that does not exist, because the tenant was being derived
 * *from the matched row*. That is exactly the population an auditor needs:
 * password spraying and username enumeration produce nothing but unknown-username
 * failures, so the trail went silent for the whole attack and spoke up only for
 * the guess that landed.
 *
 * The installation is single-tenant, so there is a correct tenant to file under
 * and no risk of putting a stranger's typo into some other company's trail.
 *
 * `source` names the machine when the attempt came through a panel; the socket
 * handshake has always known it and used to discard it.
 */
async function recordSignInAttempt(
  tenantId: string | null,
  username: string,
  success: boolean,
  userId?: string,
  source?: string,
): Promise<void> {
  const tenant = tenantId ?? (await resolveDefaultTenantId().catch(() => null));
  if (!tenant) return;

  await activityLog.recordDetachedActivity(
    {
      tenantId: tenant,
      entityType: 'user',
      entityId: userId ?? username,
      action: success ? 'sign_in' : 'sign_in_failed',
      actorType: 'user',
      actorId: userId ?? null,
      details: {
        username,
        // Distinguishes "this username does not exist here" from "wrong
        // password", which the *response* deliberately does not — the caller
        // must not learn it, the auditor must.
        ...(userId ? {} : { unknownUsername: true }),
        ...(source ? { source } : {}),
      },
    },
    {
      tenantId: tenant,
      actorType: 'user',
      actorId: userId ?? null,
      userId: userId ?? null,
      permissions: null,
      deviceCode: null,
      // The attempted username, not a resolved display name — this is exactly
      // the case where nothing else identifies who tried, including when the
      // username does not belong to any account.
      actorName: username,
    },
    db(),
  );
}
