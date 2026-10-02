/**
 * Developer mode on an Office Panel (`shared/src/domain/developer.ts` says why
 * it is a password and not a permission).
 *
 * Two halves. The unlock — password check, lockout, short-lived token — is
 * kept here rather than in the routes so the HTTP layer stays the thin
 * translation the rest of `http/app.ts` is, and so the clock can be swapped
 * for a test without a request in sight.
 *
 * The one tool an Office has is `resetPanel`: put this PC back to the moment
 * before it was paired. It reaches for the same cache resets a restore does,
 * for the reason `backup-restore.service.ts` gives — the file on disk changing
 * tells nothing to the object holding a copy of it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';

import {
  DEVELOPER_PASSWORD_HASH,
  DEVELOPER_TOKEN_TTL_MS,
  DEVELOPER_UNLOCK_LOCKOUT_MS,
  DEVELOPER_UNLOCK_MAX_FAILURES,
  type DeveloperStatus,
  type DeveloperUnlock,
  type ResetAllResult,
} from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { createLogger } from '../lib/logger.js';
import { verifyAgainst } from '../lib/password.js';
import { masterConnection } from '../realtime/master-connection.js';
import { clearCredentials } from './credentials.store.js';
import { resetSignInAttempts } from './sign-in-attempts.store.js';
import { resetOfflineAuthEvents } from './offline-auth-events.store.js';
import * as userSession from './user-session.service.js';
import { resetUserStore } from './user-store.js';
import { resetClockCache } from '../sync/clock.js';
import { resetDeviceCache } from '../sync/device.js';
import { resetLocalStore } from '../sync/local-store.js';
import { resetOutboxCache } from '../sync/outbox.store.js';

const log = createLogger('developer');

export class DeveloperError extends Error {
  constructor(
    readonly status: 401 | 429,
    readonly code: 'developer_password' | 'too_many_requests',
    message: string,
    readonly details?: { seconds: number },
  ) {
    super(message);
    this.name = 'DeveloperError';
  }
}

/** Live tokens, by value. Pruned on every call so an expired one never answers. */
const tokens = new Map<string, number>();

/**
 * Per process, not per address: the panel listens on loopback only, so every
 * caller is somebody sitting at this PC and there is nothing to tell apart.
 */
let failures = 0;
let lockedUntil = 0;

let now: () => number = () => Date.now();

/** Test seam: the lockout and the token TTL are judged against this clock. */
export function setDeveloperClockForTest(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
  tokens.clear();
  failures = 0;
  lockedUntil = 0;
}

/** Read at call time, not import: a `.env` loaded later or a test must still win. */
function passwordOverride(): string | undefined {
  return process.env.ORDERBOOK_DEVELOPER_PASSWORD || undefined;
}

async function passwordMatches(password: string): Promise<boolean> {
  const override = passwordOverride();
  if (override === undefined) return verifyAgainst(password, DEVELOPER_PASSWORD_HASH);

  // Plaintext compare, constant-time. Length first for the same reason
  // `lib/password.ts` gives: `timingSafeEqual` throws on a mismatch.
  const given = Buffer.from(password, 'utf8');
  const expected = Buffer.from(override, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function prune(): void {
  const at = now();
  for (const [token, expiresAt] of tokens) {
    if (expiresAt <= at) tokens.delete(token);
  }
}

export async function unlock(password: string): Promise<DeveloperUnlock> {
  prune();

  const at = now();
  if (at < lockedUntil) {
    const seconds = Math.ceil((lockedUntil - at) / 1000);
    throw new DeveloperError(
      429,
      'too_many_requests',
      `Too many wrong passwords. Try again in ${seconds} seconds`,
      { seconds },
    );
  }

  if (!(await passwordMatches(password))) {
    failures += 1;
    if (failures >= DEVELOPER_UNLOCK_MAX_FAILURES) {
      failures = 0;
      lockedUntil = now() + DEVELOPER_UNLOCK_LOCKOUT_MS;
    }
    throw new DeveloperError(401, 'developer_password', 'That is not the developer password');
  }

  failures = 0;
  const token = randomBytes(32).toString('hex');
  const expiresAt = now() + DEVELOPER_TOKEN_TTL_MS;
  tokens.set(token, expiresAt);

  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export function isUnlocked(token: string | undefined): boolean {
  prune();
  return token !== undefined && tokens.has(token);
}

export function status(token: string | undefined): DeveloperStatus {
  const unlocked = isUnlocked(token);
  const expiresAt = unlocked && token !== undefined ? (tokens.get(token) ?? null) : null;

  return {
    unlocked,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    passwordOverridden: passwordOverride() !== undefined,
  };
}

export function lock(token: string | undefined): void {
  if (token !== undefined) tokens.delete(token);
}

/**
 * Back to unpaired. Order: drop the live session and the socket first so
 * nothing is mid-write while the files go; then the files; then the caches,
 * so the running process answers from the empty folder rather than from a
 * memory of the old one.
 *
 * The pointer that says *where* the data folder is — `config.settingsFile`
 * from source, the shell's `config.locationFile` under the desktop app — is
 * deliberately untouched: a reset should erase the folder's contents, not
 * forget which folder the operator chose.
 */
export async function resetPanel(): Promise<ResetAllResult> {
  userSession.resetSession();
  masterConnection.disconnect();

  const current = paths();
  const { dataDir, imagesDir, avatarsDir, ...files } = current;
  for (const file of Object.values(files)) {
    await fs.rm(file, { force: true });
  }
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.rm(avatarsDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });

  // Through the store, not the file (already gone above), so its cache
  // agrees with the disk — `backup-restore.service.ts` explains the hazard.
  await clearCredentials();

  resetDeviceCache();
  resetClockCache();
  resetOutboxCache();
  resetLocalStore();
  resetUserStore();
  resetSignInAttempts();
  resetOfflineAuthEvents();

  log.warn('Developer reset: this panel is unpaired and every local file is gone');

  return { ok: true, state: 'unpaired' };
}
