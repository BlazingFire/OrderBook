/**
 * Signing a person in on an Office Panel (docs/ROLES_AND_USERS.md §12, §15).
 *
 * Two paths, and which one runs is decided by whether the Master is reachable —
 * never by whether the Master said no:
 *
 *   · **Online.** The Master verifies, because the Master holds the hash. It
 *     returns a session token this panel then presents on every command, so the
 *     person's own role governs what they may do rather than the panel's. On the
 *     way through, the panel mints its own verifier from the plaintext it is
 *     briefly holding — that, and only that, is what makes the offline path
 *     possible later.
 *
 *   · **Offline.** Verified against that locally-minted verifier, with the
 *     permission set cached at the last online sign-in.
 *
 * The rule that matters: a *rejection* from the Master is final. Falling back to
 * the local verifier when the Master said no would mean a password changed or an
 * account deactivated on the Master kept working here — the panel would quietly
 * become the weakest door into the company's data.
 *
 * One person is signed in at a time. An Office Panel is one PC at one counter,
 * and the Master keys the acting user to this panel's socket, so "who is acting"
 * has to have exactly one answer.
 */

import type {
  MessageKey,
  MessageParams,
  PanelUserSession,
  SessionRejection,
  SignedInUser,
} from '@orderbook/shared';
import { SERVER_MASTER_TIER, SETTINGS } from '@orderbook/shared';

import { createLogger } from '../lib/logger.js';
import { mintVerifier, verifyAgainst } from '../lib/password.js';
import { MasterCommandError, masterConnection } from '../realtime/master-connection.js';
import * as attempts from './sign-in-attempts.store.js';
import * as offlineAuthEvents from './offline-auth-events.store.js';
import { cacheAvatar } from './avatar-cache.js';
import { masterFetch } from '../lib/master-fetch.js';
import * as userStore from './user-store.js';
import * as localStore from '../sync/local-store.js';

const log = createLogger('user-session');

/**
 * A refusal this panel can explain.
 *
 * `messageKey`/`params` carry the Master's own structured answer through rather
 * than flattening it. The Master distinguishes four outcomes — `signInFailed`,
 * `tooManyAttempts`, `accountDeactivated`, `noRole` — and serialises each with
 * a key, its placeholders and a code (`master/src/realtime/hub.ts`'s own doc
 * comment exists to stop that being lost). This class used to take the English
 * `message` alone, so all four collapsed into one sentence and one code, and
 * every sign-in failure on a Hindi panel rendered in English.
 */
export class SignInError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_credentials'
      | 'unknown_here'
      | 'inactive'
      | 'locked_out'
      | 'offline_disabled',
    readonly messageKey?: MessageKey,
    readonly params?: MessageParams,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * The Master's stable code, mapped onto the panel's narrower union.
 *
 * `invalid_credentials` is the default rather than the answer: it is what an
 * unrecognised code means for the person in front of the screen, but a lockout
 * and a deactivated account are different facts and the panel can say so.
 */
function signInCodeFor(code: string | undefined): SignInError['code'] {
  switch (code) {
    case 'locked_out':
      return 'locked_out';
    case 'inactive':
      return 'inactive';
    case 'unknown_here':
      return 'unknown_here';
    default:
      return 'invalid_credentials';
  }
}

export interface PanelSession {
  userId: string;
  username: string;
  displayName: string;
  roleId: string | null;
  roleName: string;
  roleTier: string;
  permissions: string[];
  /** True when nobody asked the Master — the permissions are a cached snapshot. */
  offline: boolean;
  signedInAt: string;
}

/**
 * In memory, so closing the panel signs the person out.
 *
 * The same call the Master makes for its own admins: for software sitting on a
 * counter, "whoever last used this PC is still signed in tomorrow morning" is a
 * worse default than asking for a password.
 */
let current: PanelSession | null = null;

export function currentSession(): PanelSession | null {
  return current;
}

export function sessionPermissions(): string[] {
  return current?.permissions ?? [];
}

export function can(permission: string): boolean {
  return current?.permissions.includes(permission) ?? false;
}

export async function signIn(username: string, password: string): Promise<PanelSession> {
  const trimmed = (username ?? '').trim();

  if (!trimmed || !password) {
    throw new SignInError(
      'Enter your username and password',
      'invalid_credentials',
      'signin.credentialsRequired',
    );
  }

  // Checked before the credential read, so a locked-out username costs an
  // attacker a round trip rather than a scrypt derivation.
  const locked = await attempts.lockedFor(trimmed);
  if (locked > 0) {
    /*
     * This panel's own offline counter, not the Master's.
     *
     * Decided deliberately: the panel throttles what it can see, which while
     * offline is the only throttle there is, and while online the Master's
     * check runs first and its answer wins (it reaches this code path through
     * `signInAgainstMaster`'s refusal, carrying its own `{seconds}`). Two
     * numbers that disagree between two states would be worse than none, so
     * the panel only ever reports the one that actually applies to the attempt
     * it is refusing.
     */
    const seconds = Math.max(1, Math.ceil(locked / 1000));
    throw new SignInError(
      `Too many failed attempts. Try again in ${seconds} seconds.`,
      'locked_out',
      'error.unauthorized.tooManyAttempts',
      { seconds },
    );
  }

  const connected = masterConnection.getStatus().state === 'connected';

  try {
    const session = connected
      ? await signInAgainstMaster(trimmed, password)
      : await signInOffline(trimmed, password);

    await attempts.recordSuccess(trimmed);
    return session;
  } catch (error) {
    // Counted here rather than in each path, so the offline route cannot be
    // added to later without inheriting the throttle.
    //
    // `offline_disabled` is the one exclusion, and it is not a nicety: the
    // lockout is checked ABOVE the online/offline branch, so three refusals
    // from the company's own switch would lock somebody out of their ONLINE
    // sign-in too — the person typed the right password every time and the
    // panel would tell them to wait a minute before trying a door that was
    // never shut.
    if (error instanceof SignInError && error.code !== 'offline_disabled') {
      await attempts.recordFailure(trimmed);
    }
    throw error;
  }
}

async function signInAgainstMaster(username: string, password: string): Promise<PanelSession> {
  let session: PanelUserSession;

  try {
    session = await masterConnection.command('auth:signIn', { username, password });
  } catch (error) {
    // Distinguish "the Master refused you" from "the Master did not answer".
    // Only the second may fall back to the local verifier — otherwise a password
    // changed or an account deactivated on the Master would keep working here,
    // and this panel would be the weakest door into the company's data.
    //
    // Decided from a flag the transport sets, not by reading the message. The
    // previous version substring-matched English, so a Postgres statement
    // timeout — a message the Master sent, meaning it was reachable and refused
    // us — classified as silence and fell straight through to the verifier.
    if (error instanceof MasterCommandError && error.unreachable) {
      log.warn(`Master unreachable during sign-in, trying this panel's own record`);
      return await signInOffline(username, password);
    }

    // The Master's own refusal, carried through rather than flattened. It was
    // built with `code`, `messageKey`, `params` and `details` all intact one
    // layer down, and this line used to discard every one of them.
    if (error instanceof MasterCommandError) {
      throw new SignInError(
        error.message,
        signInCodeFor(error.code),
        error.messageKey,
        error.params,
        error.details,
      );
    }

    throw new SignInError((error as Error).message, 'invalid_credentials');
  }

  const { token, user, credentialFingerprint } = session;

  /*
   * A Server Master signs in on the Master PC only. The Master already refuses
   * one over a panel socket; this is the panel's own half, so a Master that let
   * one through still leaves nothing behind here: no offline verifier (which
   * would let the account in with the network cable pulled), and no session.
   */
  if (user.roleTier === SERVER_MASTER_TIER) {
    try {
      await masterConnection.command('auth:signOut', token);
    } catch {
      // The Master expires it on its own; the refusal below stands either way.
    }
    throw new SignInError(
      'Server Master accounts sign in only on the Master PC',
      'invalid_credentials',
      'error.unauthorized.serverMasterMasterPcOnly',
    );
  }

  // The one moment this panel ever holds the plaintext. Mint a verifier from it
  // now — there is no second chance, and the Master will never send us its hash.
  const verifier = await mintVerifier(password);

  await userStore.remember({
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    roleId: user.roleId,
    roleName: user.roleName,
    roleTier: user.roleTier,
    verifier,
    credentialFingerprint,
    permissions: user.permissions,
    roleVersion: user.roleVersion,
    masterToken: token,
    lastSignInAt: new Date().toISOString(),
    avatarId: user.avatar?.id ?? null,
    blurhash: user.avatar?.blurhash ?? null,
  });

  await masterConnection.assume(token);

  /*
   * Pull the profile picture down while we are certainly online and certainly
   * authorised, which is only true right here.
   *
   * The screen that shows it — the panel's own sign-in list — renders with
   * nobody signed in and the Master very possibly off, so it can only ever read
   * a local file. Awaited rather than fired and forgotten so a fast second
   * sign-in cannot race the write, and it never throws: a missing picture costs
   * the list a face and nothing else.
   */
  if (user.avatar) await cacheAvatar(user.avatar.id, masterFetch);

  current = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    roleId: user.roleId,
    roleName: user.roleName,
    roleTier: user.roleTier,
    permissions: user.permissions,
    offline: false,
    signedInAt: new Date().toISOString(),
  };

  log.info(`${user.username} signed in`);
  return current;
}

async function signInOffline(username: string, password: string): Promise<PanelSession> {
  /*
   * The company's switch, read off the cached snapshot.
   *
   * Gated here rather than at the two call sites above, for the same reason the
   * failure count lives in one place: there are two ways in — the link being
   * down, and the Master answering `unreachable` — and a third would inherit
   * this automatically.
   *
   * `getSetting` is not available to this function by construction: it runs
   * precisely because the Master cannot be asked. `cachedFeatures()` reads the
   * snapshot file this panel already owns, so it works with the Master off and
   * after a restart, when memory is empty and only the file survives.
   *
   * Both absences resolve to the setting's declared fallback, which is `true`.
   * A snapshot from a Master too old to carry the field, and no snapshot at
   * all, both mean "nobody has told me otherwise" — and fail-closed here would
   * tell the person at the counter that only somebody who has signed in before
   * may sign in, which is a lie they cannot fix without the Master. It would
   * also buy nothing: anyone who can delete `snapshot.json` can edit the flag
   * inside it instead.
   */
  const features = await localStore.cachedFeatures();
  if (
    (features?.offlineSignInEnabled ?? SETTINGS['security.offlineSignInEnabled'].fallback) === false
  ) {
    throw new SignInError(
      'Signing in needs the Master Panel. This company does not allow signing in while it is off.',
      'offline_disabled',
      'error.generic.offlineSignInDisabled',
    );
  }

  const known = await userStore.findByUsername(username);

  // Deliberately the same message as a wrong password. "You have never signed in
  // on this panel" tells an outsider that the username itself is real.
  const matches = await verifyAgainst(password, known?.verifier ?? null);

  if (!known || !matches) {
    await offlineAuthEvents.append({
      username,
      ...(known ? { userId: known.userId } : {}),
      success: false,
      at: new Date().toISOString(),
    });
    throw new SignInError(
      'Sign-in failed. With the Master Panel unreachable, only people who have signed in on this panel before can sign in.',
      'unknown_here',
    );
  }

  current = {
    userId: known.userId,
    username: known.username,
    displayName: known.displayName,
    roleId: known.roleId,
    roleName: known.roleName,
    roleTier: known.roleTier,
    permissions: known.permissions,
    offline: true,
    signedInAt: new Date().toISOString(),
  };

  // Presenting the stored token now is harmless while the link is down and
  // means the reconnect re-establishes this person without a second prompt.
  if (known.masterToken) await masterConnection.assume(known.masterToken);

  // The Master cannot log this sign-in now, so it is kept and uploaded on reconnect.
  await offlineAuthEvents.append({
    username: known.username,
    userId: known.userId,
    success: true,
    at: new Date().toISOString(),
  });

  log.info(`${known.username} signed in offline against this panel's own record`);
  return current;
}

export async function signOut(): Promise<void> {
  const session = current;
  current = null;

  if (!session) return;

  const known = await userStore.findByUserId(session.userId);
  await masterConnection.assume(null);

  if (known?.masterToken && masterConnection.getStatus().state === 'connected') {
    try {
      await masterConnection.command('auth:signOut', known.masterToken);
    } catch {
      // The Master will expire it on its own. Not worth blocking a sign-out.
    }
  }

  await userStore.update(session.userId, { masterToken: null });
  log.info(`${session.username} signed out`);
}

/**
 * The Master will not honour this panel's session.
 *
 * What follows depends entirely on *why*, and conflating the two reasons is a
 * bug in either direction:
 *
 *  · `revoked` — the account is gone, deactivated, or lost its role. The local
 *    verifier goes with the session. Leaving it behind would let somebody the
 *    company has just locked out carry on working here by pulling the network
 *    cable, which is precisely the hole the offline path must not open.
 *
 *  · `expired` — the token is merely unknown, which a Master restart also
 *    produces because its sessions live in memory. Sign the person out, but keep
 *    the verifier: destroying it here would mean rebooting the Master silently
 *    stripped offline sign-in from whoever happened to be signed in at the time.
 */
export async function rejectCurrent(reason: SessionRejection): Promise<void> {
  const session = current;
  current = null;
  if (!session) return;

  if (reason === 'revoked') {
    await userStore.forget(session.userId);
    log.warn(`${session.username} was signed out and can no longer sign in offline here`);
    return;
  }

  log.info(`${session.username} was signed out: the Master no longer holds that session`);
}

/**
 * Revalidate every offline verifier this panel holds, on reconnect.
 *
 * The pushed rejection above only reaches a panel that was switched on when the
 * revocation happened. This covers the one that was not — a panel restarted
 * between a sign-in and a password reset would otherwise keep a verifier for the
 * old password indefinitely, with nothing anywhere to reconcile it against.
 */
export async function reconcileKnownUsers(): Promise<void> {
  const known = await userStore.listKnown();
  if (known.length === 0) return;

  let forget: string[];

  try {
    forget = await masterConnection.reconcile(
      known.map((user) => ({
        userId: user.userId,
        credentialFingerprint: user.credentialFingerprint,
      })),
    );
  } catch (error) {
    // Keep what we have and try again next reconnect. Forgetting on a failed
    // round trip would lock people out of their own panel over a dropped packet.
    log.warn(`Could not revalidate offline sign-ins: ${(error as Error).message}`);
    return;
  }

  for (const userId of forget) {
    await userStore.forget(userId);
    if (current?.userId === userId) {
      current = null;
      log.warn('The signed-in person was revoked while this panel was away');
    }
  }

  if (forget.length > 0) {
    log.info(`Removed ${forget.length} stale offline sign-in record(s)`);
  }
}

/** Refresh the cached permissions after the Master re-resolved this person. */
export async function refreshFrom(user: SignedInUser): Promise<void> {
  if (!current || current.userId !== user.id) return;

  current = {
    ...current,
    displayName: user.displayName,
    roleId: user.roleId,
    roleName: user.roleName,
    roleTier: user.roleTier,
    permissions: user.permissions,
    offline: false,
  };

  await userStore.update(user.id, {
    displayName: user.displayName,
    roleId: user.roleId,
    roleName: user.roleName,
    roleTier: user.roleTier,
    permissions: user.permissions,
    roleVersion: user.roleVersion,
  });
}

/** Test seam. */
export function resetSession(): void {
  current = null;
}
