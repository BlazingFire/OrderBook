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
import * as roleRepo from '../repositories/role.repository.js';
import * as userRepo from '../repositories/user.repository.js';

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
): Promise<{ token: string; user: SignedInUser }> {
  const key = username?.trim().toLowerCase() ?? '';
  assertNotLockedOut(key);

  const credential = await userRepo.readCredentialForVerification(key);
  const { matches, needsUpgrade } = await verifyPassword(password, credential?.passwordHash ?? null);

  if (!credential || !matches) {
    recordFailure(key);
    await recordSignInAttempt(credential?.tenantId ?? null, key, false);
    // Deliberately generic. "No such user" versus "wrong password" is a
    // username oracle.
    throw new UnauthorizedError('Sign-in failed');
  }

  if (!credential.isActive) {
    // Distinguished from a bad password on purpose: this is not a guessing
    // signal, it is a fact the person needs in order to ask someone to fix it.
    throw new UnauthorizedError('This account has been deactivated');
  }

  failures.delete(key);

  const permissionSet = await roleRepo.permissionSetForRole(credential.roleId);
  if (!permissionSet) {
    throw new UnauthorizedError('This account has no role. Ask an administrator to assign one.');
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

  await recordSignInAttempt(credential.tenantId, key, true, credential.id);

  const token = randomBytes(32).toString('base64url');
  const roleVersion = (await roleRepo.roleVersion(credential.roleId ?? '')) ?? 0;

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
  if (!user) throw new UnauthorizedError('Sign-in failed');

  return { token, user: await decorate(user, token) };
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

  const permissionSet = await roleRepo.permissionSetForRole(user.roleId);
  if (!permissionSet) {
    if (token) sessions.delete(token);
    return null;
  }

  const currentVersion = (await roleRepo.roleVersion(user.roleId ?? '')) ?? 0;

  // The role moved (edited, or the user was reassigned): rebuild in place, so
  // the very next permission check uses the new set.
  if (currentVersion !== session.roleVersion || user.roleId !== session.roleId) {
    session.roleId = user.roleId;
    session.roleVersion = currentVersion;
    session.permissions = effectivePermissions(permissionSet.permissions, permissionSet.tier);
  }

  return user;
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

  const credential = await userRepo.readCredentialForVerification(user.username);
  const { matches } = await verifyPassword(input.currentPassword, credential?.passwordHash ?? null);

  // Changing your own password needs the current one, not `users.manage` —
  // otherwise nobody could change their own without administrative rights.
  if (!matches) throw new UnauthorizedError('Your current password is not correct');

  if (!input.newPassword || input.newPassword.length < 8) {
    throw new ValidationError('Choose a password of at least 8 characters');
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

    await activityLog.recordActivity({
      tenantId,
      entityType: 'user',
      entityId: userId,
      action: 'password_changed',
      actorType: 'user',
      actorId: userId,
      details: { username: user.username },
    });
  });

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
}

export function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
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
    throw new UnauthorizedError('Too many failed attempts. Try again in a minute.');
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

async function recordSignInAttempt(
  tenantId: string | null,
  username: string,
  success: boolean,
  userId?: string,
): Promise<void> {
  // A failure against an unknown username has no tenant to file under, so there
  // is nothing to record — and inventing one would put a stranger's typo into
  // some company's audit trail.
  if (!tenantId) return;

  await activityLog.recordActivity({
    tenantId,
    entityType: 'user',
    entityId: userId ?? username,
    action: success ? 'sign_in' : 'sign_in_failed',
    actorType: 'user',
    actorId: userId ?? null,
    details: { username },
  });
}
