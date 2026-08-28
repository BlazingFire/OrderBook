/**
 * The recoverable password vault (`docs/overhaul/workstream-F.md`).
 *
 * Off by default and self-purging. Nothing is written while
 * `security.passwordRevealEnabled` is `false`, so on a default installation the
 * whole write path below is dead code; turning the setting off again deletes
 * every stored plaintext in the same transaction as the flag.
 *
 * **Read the residual risk before changing anything here.** Once the setting is
 * on, every password of every person who signs in *online* afterwards is
 * recoverable by anyone who can read the Master PC's data directory. The
 * encryption stops a copied database file and a stolen backup, and nothing
 * else. Inside the app it is one admin-tier permission — which a fresh
 * install's Administrator already holds — plus a re-typed password away, and
 * every use is a permanent `activity_log` row on a table whose triggers refuse
 * UPDATE and DELETE. Misuse is visible, not prevented. People reuse passwords,
 * so the blast radius is their email and their bank.
 *
 * The back-fill is free and needs no migration: every successful online sign-in
 * already holds the plaintext, so accounts seal themselves as people arrive at
 * work. An Office Panel signing somebody in *offline* verifies against its own
 * locally-minted verifier and never reaches the Master, so a clerk who works
 * offline for a fortnight fills no row — which is why `vaultStatus` reports the
 * gap as a number instead of leaving it to be discovered.
 */

import type { OneTimeSecret, VaultStatus } from '@orderbook/shared';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toErrorMessage,
  UnauthorizedError,
} from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { CURRENT_KEY_VERSION, open, seal, SecretBoxError } from '../lib/secret-box.js';
import { verifyPassword } from '../lib/password.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as panelCredentialRepo from '../repositories/panel-credential.repository.js';
import * as vaultRepo from '../repositories/password-vault.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { hasRecentReauth, noteRecentReauth } from './reauth-cache.js';
import { getSetting } from './settings.service.js';

const log = createLogger('vault');

function aadFor(tenantId: string, userId: string): string {
  return `vault:${tenantId}:${userId}`;
}

/**
 * Seal one person's password, if this company has asked for that.
 *
 * Called **after** the caller's transaction has committed, from all five
 * moments that already hold a plaintext: user creation, an administrative
 * reset, a self-service change, first-run setup, and every successful online
 * sign-in. Deliberately after rather than inside, and this is load-bearing:
 * `signIn` rewrites `password_hash` from bcrypt to scrypt inside its own
 * transaction and `setup.service.ts` hashes the first administrator with
 * bcrypt, so a fingerprint taken from the hash the caller was holding would be
 * a pre-upgrade one that never matches — and the shop's own admin account would
 * report `stale` on its very first reveal.
 *
 * Never throws into its caller. Failing to remember a password must not fail
 * the sign-in or the reset that produced it.
 */
export async function rememberPassword(
  tenantId: string,
  userId: string,
  plaintext: string,
  actorId: string | null,
  /** The live fingerprint, when the caller already read it (sign-in does). */
  knownFingerprint?: string | null,
): Promise<void> {
  try {
    await seedVaultEntry(tenantId, userId, plaintext, actorId, knownFingerprint);
  } catch (error) {
    // Logged, never rethrown. An unwritable key file or a lost connection must
    // not turn somebody's sign-in into a failure — the cost of not remembering
    // is that an administrator reveals nothing until the next sign-in, which is
    // the same state a default installation is permanently in.
    log.warn(`Could not remember the password for ${userId}: ${toErrorMessage(error)}`);
  }
}

async function seedVaultEntry(
  tenantId: string,
  userId: string,
  plaintext: string,
  actorId: string | null,
  knownFingerprint?: string | null,
): Promise<void> {
  if (!plaintext) return;
  if (!(await getSetting(tenantId, 'security.passwordRevealEnabled'))) return;

  const fingerprint =
    knownFingerprint ?? (await panelCredentialRepo.fingerprintForUser(tenantId, userId));
  if (!fingerprint) return;

  const existing = await vaultRepo.readVaultEntry(tenantId, userId);
  if (existing && existing.credentialFingerprint === fingerprint) return;

  const sealed = seal(plaintext, aadFor(tenantId, userId));

  await db().transaction(async (trx) => {
    await vaultRepo.upsertVaultEntry(
      tenantId,
      userId,
      sealed,
      fingerprint,
      CURRENT_KEY_VERSION,
      actorId,
      trx,
    );
  });
}

/**
 * Show a stored password once, to a re-authenticated administrator.
 *
 * The gates run in this order on purpose: permission, then the company's own
 * switch, then existence, then re-authentication, then staleness, then the
 * decryption itself — each one refusing before the next learns anything. The
 * audit row is committed **before** the response is built, so a reveal that
 * reaches somebody's screen has already reached the trail.
 */
export async function revealPassword(
  userId: string,
  confirmPassword: string,
  actor: ActorContext,
  sessionToken: string | undefined,
): Promise<OneTimeSecret> {
  requirePermission(actor, 'users.viewPassword');

  if (!(await getSetting(actor.tenantId, 'security.passwordRevealEnabled'))) {
    // Named separately from the generic 403: an administrator who holds the key
    // and is still refused needs to be sent to the setting, not to their own
    // permission grid.
    throw new ForbiddenError('users.viewPassword', 'error.forbidden.passwordRevealDisabled');
  }

  const subject = await userRepo.findById(actor.tenantId, userId);
  if (!subject) throw new NotFoundError('User');

  await requireRecentReauth(actor, confirmPassword, sessionToken);

  const entry = await vaultRepo.readVaultEntry(actor.tenantId, userId);
  const live = await panelCredentialRepo.fingerprintForUser(actor.tenantId, userId);

  // Stale beats wrong. A password that has since been changed elsewhere would
  // otherwise be shown as though it still worked.
  if (!entry || !live || entry.credentialFingerprint !== live) {
    throw new ConflictError('error.conflict.passwordNotStored', {});
  }

  let password: string;
  try {
    password = open(entry.sealed, aadFor(actor.tenantId, userId));
  } catch (error) {
    if (error instanceof SecretBoxError) {
      // No ciphertext, no lengths, no key path — `error-handler.ts` echoes the
      // message, the params and the details verbatim to the browser.
      throw new ConflictError('error.conflict.vaultUnreadable', {});
    }
    throw error;
  }

  await db().transaction(async (trx) => {
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: userId,
        action: 'password_revealed',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // The username and nothing else, forever. `renderActivity` copies
        // every string and number in `details` into the rendered sentence.
        details: { name: subject.username },
      },
      actor,
      trx,
    );
  });

  return { userId, username: subject.username, password };
}

/** How much of the company the vault covers, for the Settings screen. */
export async function vaultStatus(actor: ActorContext): Promise<VaultStatus> {
  requirePermission(actor, 'users.viewPassword');

  const [enabled, stored, total] = await Promise.all([
    getSetting(actor.tenantId, 'security.passwordRevealEnabled'),
    vaultRepo.countVaultEntries(actor.tenantId),
    userRepo.countUsers(actor.tenantId),
  ]);

  return { enabled, stored, total };
}

/**
 * Make the caller prove they are still at the keyboard.
 *
 * Cached for five minutes per session token so revealing three people's
 * passwords in a row is not three password prompts, and swept by
 * `purgeExpiredSessions` rather than growing forever.
 */
async function requireRecentReauth(
  actor: ActorContext,
  confirmPassword: string,
  sessionToken: string | undefined,
): Promise<void> {
  if (hasRecentReauth(sessionToken)) return;

  const credential = actor.userId
    ? await userRepo.readCredentialById(actor.tenantId, actor.userId)
    : null;

  const { matches } = await verifyPassword(confirmPassword, credential?.passwordHash ?? null);
  if (!matches) throw new UnauthorizedError('error.unauthorized.currentPasswordIncorrect');

  noteRecentReauth(sessionToken);
}
