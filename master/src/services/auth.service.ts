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
import type { ChangeOwnPasswordInput, PermissionSet, SignedInUser, User } from '@orderbook/shared';
import { effectivePermissions } from '@orderbook/shared';

import { db } from '../db/knex.js';
import { assertPasswordLongEnough, hashPassword, verifyPassword } from '../lib/password.js';
import { UnauthorizedError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import * as panelCredentialRepo from '../repositories/panel-credential.repository.js';
import * as roleRepo from '../repositories/role.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { companyFeatures } from './company-features.js';
import { rememberPassword } from './password-vault.service.js';
import { gatePricing, permissionSetForRole, pricingEnabled } from './pricing-gate.js';
import { getSetting } from './settings.service.js';
import { clearRecentReauth, sweepRecentReauth } from './reauth-cache.js';

const log = createLogger('auth');

interface Session {
  userId: string;
  tenantId: string;
  roleId: string | null;
  /** The role version this session's permissions were derived from. */
  roleVersion: number;
  /** Whether `pricing.enabled` was on when `permissions` was derived. */
  pricing: boolean;
  permissions: string[];
  expiresAt: number;
}

const sessions = new Map<string, Session>();

/**
 * Tokens whose session was destroyed *because the account lost access*, and
 * when that session would have expired on its own.
 *
 * Without this, "revoked" was inferred from the token still being in
 * `sessions` while no longer resolving — and every action that revokes access
 * calls `invalidateSessionsForUser`, which removes it. The evidence was
 * destroyed before anything asked, so the answer was always `expired`, and
 * `revoked` was unreachable in practice.
 *
 * That mattered off this machine: only `revoked` tells an Office panel to
 * destroy the offline verifier it holds for that person. Reported as `expired`,
 * a panel keeps it — so somebody the company had just deactivated could go on
 * signing in there by pulling the network cable, which is the one hole the
 * offline path is not allowed to open. A reconnect's `auth:reconcile` would
 * eventually catch it, but a panel that never drops its socket never
 * reconnects.
 *
 * Entries are bounded by the session lifetime they inherit: past that, the
 * token could not have been used anyway.
 */
const revokedTokens = new Map<string, number>();

/** Failed attempts per username, for the lockout below. */
const failures = new Map<string, { count: number; lockedUntil: number; lastFailureAt: number }>();

const MAX_FAILURES = 3;
const LOCKOUT_MS = 60_000;

/**
 * How long a failure record survives with nothing further happening to it.
 *
 * This map is keyed by the *attempted* username, so a password-spraying run
 * against invented names grows it without bound — `failures.delete` fires only
 * on a successful sign-in for that exact username, and an invented username
 * never has one. A day is far longer than any real person's gap between typing
 * their own password wrong twice, so nothing an operator would notice changes;
 * what changes is that the map has a ceiling.
 */
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Serialises sign-in attempts for one username.
 *
 * `assertNotLockedOut` runs synchronously, but `recordFailure` only fires
 * after two awaited steps (the credential read, the password verify) — so
 * several concurrent requests for the same username (a brute-force burst, or
 * just a flaky client retrying) could all pass the lockout check before any
 * of them recorded a failure, and `MAX_FAILURES` per minute became
 * `MAX_FAILURES` per *wave*. Chaining every attempt for a username through
 * one promise makes the Nth request genuinely wait for the (N-1)th to finish
 * — including its `recordFailure`/`failures.delete` — before it starts, which
 * closes the race without touching the counting logic itself or risking a
 * false lockout on legitimate concurrent traffic the way stamping a
 * reservation before verification would.
 *
 * Keyed the same way `failures` is — by the attempted username — so it has
 * the same unbounded-growth exposure against a spraying run of invented
 * names, and `failures` already keeps its own ceiling with `FAILURE_TTL_MS`.
 * This map needs no TTL of its own: a chain has nothing left to serialise
 * once the attempt it was holding settles, so the entry is deleted the
 * moment its own settled promise lands, provided nothing newer queued behind
 * it in the meantime.
 */
const signInChains = new Map<string, Promise<unknown>>();

function withSignInLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = signInChains.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  // Never rejects: a failed attempt must still let the next one in line run,
  // and a map entry that stayed on a rejected promise would wedge every
  // later sign-in for that username behind an error nothing is awaiting.
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  signInChains.set(key, settled);
  void settled.then(() => {
    if (signInChains.get(key) === settled) signInChains.delete(key);
  });
  return result;
}

export async function signIn(
  username: string,
  password: string,
  /** Which machine the attempt came from, for the audit trail. */
  source?: string,
): Promise<{
  token: string;
  user: SignedInUser;
  credentialFingerprint: string;
  /**
   * How long this session was stamped for, in milliseconds.
   *
   * Returned rather than re-read by the route, so the session's expiry and the
   * cookie's `maxAge` cannot disagree. They were two independent reads of
   * `config.session.ttlMs`, and the moment the value became a setting the
   * shorter of the two would silently win for the Master's own browser: set 24
   * hours and the cookie would still be dropped at 12, signing the
   * administrator out while the setting insisted otherwise.
   */
  sessionTtlMs: number;
}> {
  const key = username?.trim().toLowerCase() ?? '';
  return withSignInLock(key, () => attemptSignIn(key, password, source));
}

async function attemptSignIn(
  key: string,
  password: string,
  source?: string,
): Promise<{
  token: string;
  user: SignedInUser;
  credentialFingerprint: string;
  /** See `signIn` — this is the function that stamps it. */
  sessionTtlMs: number;
}> {
  assertNotLockedOut(key);

  const credential = await userRepo.readCredentialForVerification(key);
  const { matches, needsUpgrade } = await verifyPassword(
    password,
    credential?.passwordHash ?? null,
  );

  if (!credential || !matches) {
    recordFailure(key);
    // `credential?.id`, not `undefined`: the trail records which of the two
    // this was, and passing nothing here filed every wrong password against a
    // real account as an unknown username — the one distinction the entry
    // exists to make. It also left `actorId` null and the entity id set to the
    // typed name, so a person's failed attempts never joined up with the rest
    // of their history.
    await recordSignInAttempt(credential?.tenantId ?? null, key, false, credential?.id, source);
    /*
     * The *response* stays deliberately generic about *which* thing was wrong.
     * "No such user" versus "wrong password" is a username oracle for the
     * caller; the auditor is not the caller.
     *
     * The count is a different question and is safe to answer: the failure map
     * is keyed by the attempted username whether or not the account exists,
     * both branches share this one path, and a missing user still pays a full
     * scrypt hash — so the number is identical for a real and an invented name.
     * Withholding it only made the lockout arrive without warning.
     */
    const remaining = remainingAttempts(key);
    throw remaining > 0
      ? new UnauthorizedError('error.unauthorized.signInFailedRemaining.other', {
          count: remaining,
        })
      : new UnauthorizedError('error.unauthorized.signInFailed');
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

  const permissionSet = await permissionSetForRole(credential.tenantId, credential.roleId);
  if (!permissionSet) {
    // The last terminal branch that wrote nothing. Somebody holding the right
    // password and getting nowhere is exactly what an administrator is trying
    // to see when they open the trail to find out why a person cannot sign in,
    // and this was the one refusal that left no trace of itself.
    await recordSignInAttempt(credential.tenantId, key, false, credential.id, source);
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
  const roleVersion =
    (await roleRepo.roleVersion(credential.tenantId, credential.roleId ?? '')) ?? 0;

  // The company's own sign-out policy, not the twelve hours the config file
  // used to fix for everyone. `config.session.ttlMs` remains the parse fallback
  // and the value the boot path uses before any tenant exists.
  const sessionTtlMs =
    (await getSetting(credential.tenantId, 'security.sessionHours')) * 60 * 60 * 1000;

  sessions.set(token, {
    userId: credential.id,
    tenantId: credential.tenantId,
    roleId: credential.roleId,
    roleVersion,
    pricing: await pricingEnabled(credential.tenantId),
    // Intersected with the tier ceiling here as well as on save: a role row
    // that arrived over sync from a tampered replica carrying an admin key on
    // an office tier is stripped now and never enters the session.
    permissions: effectivePermissions(permissionSet.permissions, permissionSet.tier),
    expiresAt: Date.now() + sessionTtlMs,
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
    sessionTtlMs,
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
  return (await resolveSessionWithPermissions(token))?.user ?? null;
}

/**
 * The same resolution, handing back the permission set it already computed.
 *
 * This is one query. It used to be three — the user, the role for its
 * permissions, and the same role again for its version — on every HTTP
 * request, every socket connect, once per recipient socket on a party-scoped
 * change, and once per admin socket per dashboard flush. Two of the three read
 * the same row.
 *
 * Every caller that needs both the person and their permissions must use this
 * rather than calling `resolveSession` and then `permissionSetForRole`: fixing
 * one of the five sites and leaving four would have been the same defect with
 * a smaller blast radius.
 */
export async function resolveSessionWithPermissions(
  token: string | undefined,
): Promise<{ user: User; permissions: PermissionSet } | null> {
  const session = tokenSession(token);
  if (!session) return null;

  const found = await userRepo.findByIdWithRole(session.tenantId, session.userId);
  if (!found || !found.user.isActive) {
    if (token) sessions.delete(token);
    return null;
  }

  const permissionSet = found.role
    ? await gatePricing(session.tenantId, roleRepo.permissionSetFromRow(session.tenantId, found.role))
    : null;

  if (!permissionSet) {
    if (token) sessions.delete(token);
    return null;
  }

  const currentVersion = found.role?.version ?? 0;
  const pricing = await pricingEnabled(session.tenantId);

  // The role moved (edited, or the user was reassigned), or the company's
  // pricing switch flipped: rebuild in place, so the very next permission
  // check uses the new set.
  if (
    currentVersion !== session.roleVersion ||
    found.user.roleId !== session.roleId ||
    pricing !== session.pricing
  ) {
    session.roleId = found.user.roleId;
    session.roleVersion = currentVersion;
    session.pricing = pricing;
    session.permissions = effectivePermissions(permissionSet.permissions, permissionSet.tier);
  }

  return { user: found.user, permissions: permissionSet };
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
  const resolution = await resolveSessionDetailedWithPermissions(token);
  return resolution.status === 'active' ? { status: 'active', user: resolution.user } : resolution;
}

/** `resolveSessionDetailed`, carrying the permission set the same query found. */
export async function resolveSessionDetailedWithPermissions(
  token: string | undefined,
): Promise<
  | { status: 'active'; user: User; permissions: PermissionSet }
  | { status: 'rejected'; reason: 'revoked' | 'expired' }
> {
  const session = tokenSession(token);

  // Not in the map: revoked a moment ago, expired, or this process restarted.
  // Only the first is a statement about the account, and it is a statement we
  // have to have kept — by the time anyone asks, the session it would have been
  // read from is gone.
  if (!session) {
    return { status: 'rejected', reason: wasRevoked(token) ? 'revoked' : 'expired' };
  }

  const resolved = await resolveSessionWithPermissions(token);
  if (resolved) return { status: 'active', ...resolved };

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

  assertPasswordLongEnough(input.newPassword ?? '');

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

/** How many sign-in sessions this process is holding, for the health route. */
export function sessionCount(): number {
  return sessions.size;
}

export function signOut(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/**
 * Drop every session for a user — after a reset, a deactivation, or a delete.
 *
 * `reason` is not decoration. It travels to the Office panels, and only
 * `revoked` licenses one to destroy the offline verifier it is holding. Pass it
 * when the account itself lost access — deactivated, deleted, moved off its
 * role. Leave it `expired` for a password change: the verifier is stale rather
 * than illegitimate, and `auth:reconcile` retires it by credential fingerprint,
 * which is the mechanism built for exactly that.
 */
export function invalidateSessionsForUser(
  userId: string,
  options: { except?: string; reason?: 'revoked' | 'expired' } = {},
): void {
  for (const [token, session] of sessions) {
    if (session.userId !== userId || token === options.except) continue;

    sessions.delete(token);
    if (options.reason === 'revoked') revokedTokens.set(token, session.expiresAt);
  }
}

/**
 * Was this token's session destroyed because the account lost access?
 *
 * Prunes on the way past, in the style of the failure records above: an entry
 * older than the session it replaced answers nothing a live caller could act
 * on, because the token had expired regardless.
 */
function wasRevoked(token: string | undefined): boolean {
  const now = Date.now();
  for (const [entry, expiresAt] of revokedTokens) {
    if (expiresAt <= now) revokedTokens.delete(entry);
  }

  return token !== undefined && revokedTokens.has(token);
}

/**
 * Test seam: drop every session and every failed-attempt record.
 *
 * Both live in memory and survive a database truncate, so without this the
 * lockout from one test's deliberate wrong password locks out the next one.
 */
export function resetAuthState(): void {
  sessions.clear();
  revokedTokens.clear();
  failures.clear();
  clearRecentReauth();
}

export function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }

  // The reveal's re-authentication window rides the same sweep.
  sweepRecentReauth();

  // …and so does the lockout map, which used to be the one nothing swept.
  for (const [username, record] of failures) {
    if (record.lockedUntil > now) continue;
    if (now - record.lastFailureAt < FAILURE_TTL_MS) continue;
    failures.delete(username);
  }
}

/** Attach the caller's own resolved permissions, for the UI to render from. */
export async function decorate(user: User, token: string | undefined): Promise<SignedInUser> {
  const session = tokenSession(token);

  return {
    ...user,
    permissions: session?.permissions ?? [],
    roleVersion: session?.roleVersion ?? 0,
    features: await companyFeatures(user.tenantId),
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
    // The exact millisecond the lock lifts was already in scope one line up and
    // was thrown away, leaving the fixed sentence "try again in a minute" —
    // which is simply wrong once fifty of the sixty seconds have gone.
    throw new UnauthorizedError('error.unauthorized.tooManyAttempts', {
      seconds: Math.max(1, Math.ceil((record.lockedUntil - Date.now()) / 1000)),
    });
  }
}

/**
 * How many tries are left after the failure just recorded.
 *
 * Zero means the lock has just been applied — the caller should say so rather
 * than offer a countdown that is about to be overtaken by `assertNotLockedOut`.
 */
function remainingAttempts(username: string): number {
  const record = failures.get(username);
  if (!record) return MAX_FAILURES;
  return record.lockedUntil > Date.now() ? 0 : Math.max(0, MAX_FAILURES - record.count);
}

function recordFailure(username: string): void {
  const record = failures.get(username) ?? { count: 0, lockedUntil: 0, lastFailureAt: 0 };
  record.count += 1;
  record.lastFailureAt = Date.now();

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
