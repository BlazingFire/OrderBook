/**
 * The password gate behind developer mode and the master key: a password
 * check, a lockout, and short-lived in-memory tokens, with an injectable clock
 * so the lockout window can be tested without waiting a minute of wall time.
 *
 * Kept apart from `developer.service.ts` so it imports nothing that reaches
 * first-run setup: `master-key.service.ts` builds its gate from here, and
 * setup reaches back into the master key.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  DEVELOPER_PASSWORD_HASH,
  DEVELOPER_TOKEN_TTL_MS,
  DEVELOPER_UNLOCK_LOCKOUT_MS,
  DEVELOPER_UNLOCK_MAX_FAILURES,
  type DeveloperStatus,
  type DeveloperUnlock,
  type MessageKey,
} from '@orderbook/shared';

import { TooManyRequestsError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';

export interface DeveloperGate {
  unlock(password: unknown): Promise<DeveloperUnlock>;
  status(token: string | undefined): DeveloperStatus;
  lock(token: string | undefined): void;
  /** Throws 401 `error.unauthorized.developerMode` unless `token` is live. */
  assertUnlocked(token: string | undefined): void;
}

export interface DeveloperGateOptions {
  /** Milliseconds since the epoch. Tests hand in a fake. */
  now?: () => number;
  /** The `.env` override, read per call so a test can set and unset it. */
  overridePassword?: () => string | undefined;
  /**
   * The rest let the same gate guard a different secret — the master key
   * (`master-key.service.ts`) is a second instance. Every default is the
   * developer gate's own behaviour, unchanged.
   */
  passwordHash?: string;
  /** Thrown on a wrong password. */
  wrongPasswordKey?: MessageKey;
  /** Thrown by `assertUnlocked` without a live token. */
  lockedKey?: MessageKey;
  /** Thrown when no password was sent at all. */
  passwordRequiredKey?: MessageKey;
  tokenTtlMs?: number;
}

export function createDeveloperGate(options: DeveloperGateOptions = {}): DeveloperGate {
  const now = options.now ?? Date.now;
  const overridePassword =
    options.overridePassword ?? (() => process.env.ORDERBOOK_DEVELOPER_PASSWORD);
  const passwordHash = options.passwordHash ?? DEVELOPER_PASSWORD_HASH;
  const wrongPasswordKey = options.wrongPasswordKey ?? 'error.unauthorized.developerPassword';
  const lockedKey = options.lockedKey ?? 'error.unauthorized.developerMode';
  const passwordRequiredKey =
    options.passwordRequiredKey ?? 'validation.developer.passwordRequired';
  const tokenTtlMs = options.tokenTtlMs ?? DEVELOPER_TOKEN_TTL_MS;

  const tokens = new Map<string, number>();

  // One counter for the whole process rather than per address: the Master is
  // on a LAN where every caller shares a handful of addresses, and a guesser
  // who could reset the count by changing address would have no limit at all.
  let failures = 0;
  let lockedUntil = 0;

  function prune(): void {
    const at = now();
    for (const [token, expiresAt] of tokens) {
      if (expiresAt <= at) tokens.delete(token);
    }
  }

  async function matches(password: string): Promise<boolean> {
    const override = overridePassword();
    if (override !== undefined && override !== '') {
      const a = Buffer.from(password, 'utf8');
      const b = Buffer.from(override, 'utf8');
      // `timingSafeEqual` throws on unequal lengths rather than answering
      // false, and a thrown error would surface as a 500.
      return a.length === b.length && timingSafeEqual(a, b);
    }
    return (await verifyPassword(password, passwordHash)).matches;
  }

  async function attemptUnlock(password: unknown): Promise<DeveloperUnlock> {
    prune();
    const at = now();
    if (lockedUntil > at) {
      throw new TooManyRequestsError(Math.ceil((lockedUntil - at) / 1000));
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new ValidationError(passwordRequiredKey);
    }

    if (!(await matches(password))) {
      failures += 1;
      if (failures >= DEVELOPER_UNLOCK_MAX_FAILURES) {
        failures = 0;
        lockedUntil = now() + DEVELOPER_UNLOCK_LOCKOUT_MS;
      }
      throw new UnauthorizedError(wrongPasswordKey);
    }

    failures = 0;
    const token = randomBytes(32).toString('hex');
    const expiresAt = now() + tokenTtlMs;
    tokens.set(token, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  // Attempts run one at a time. Checked side by side, every guess already in
  // flight would pass the lockout check before any of them failed, so firing
  // guesses in parallel would get round the five-and-wait limit.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    unlock(password) {
      const attempt = queue.then(() => attemptUnlock(password));
      queue = attempt.catch(() => {});
      return attempt;
    },

    status(token) {
      prune();
      const expiresAt = token ? tokens.get(token) : undefined;
      const override = overridePassword();
      return {
        unlocked: expiresAt !== undefined,
        expiresAt: expiresAt === undefined ? null : new Date(expiresAt).toISOString(),
        passwordOverridden: override !== undefined && override !== '',
      };
    },

    lock(token) {
      prune();
      if (token) tokens.delete(token);
    },

    assertUnlocked(token) {
      prune();
      if (!token || !tokens.has(token)) {
        throw new UnauthorizedError(lockedKey);
      }
    },
  };
}
