/**
 * The developer gate, with the clock in hand: the built-in password and the
 * `.env` override, token lifetime, locking, and the lockout after five wrong
 * answers. Wall time never advances here — every "later" is the fake clock.
 */

import { describe, expect, it } from 'vitest';

import {
  DEVELOPER_TOKEN_TTL_MS,
  DEVELOPER_UNLOCK_LOCKOUT_MS,
  DEVELOPER_UNLOCK_MAX_FAILURES,
} from '@orderbook/shared';

import { createDeveloperGate } from '../src/services/developer.service.js';
import { TooManyRequestsError, UnauthorizedError, ValidationError } from '../src/lib/errors.js';

/** The plaintext `docs/DEVELOPER_MODE.md` documents for the built-in hash. */
const BUILT_IN = 'Dev@OrderBook2026';

function fakeClock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

function gateWith(override?: string) {
  const clock = fakeClock();
  const gate = createDeveloperGate({ now: clock.now, overridePassword: () => override });
  return { gate, clock };
}

describe('developer gate — password', () => {
  it('accepts the built-in password when no override is set', async () => {
    const { gate } = gateWith();
    const unlock = await gate.unlock(BUILT_IN);
    expect(unlock.token).toMatch(/^[0-9a-f]{64}$/);
    expect(gate.status(unlock.token)).toMatchObject({ unlocked: true, passwordOverridden: false });
  });

  it('refuses a wrong password with the developer-password key', async () => {
    const { gate } = gateWith();
    await expect(gate.unlock('nope')).rejects.toMatchObject({
      constructor: UnauthorizedError,
      messageKey: 'error.unauthorized.developerPassword',
    });
  });

  it('refuses an empty or missing password as validation, not as a wrong answer', async () => {
    const { gate } = gateWith();
    await expect(gate.unlock('')).rejects.toBeInstanceOf(ValidationError);
    await expect(gate.unlock(undefined)).rejects.toBeInstanceOf(ValidationError);
  });

  it('an override replaces the built-in password rather than adding to it', async () => {
    const { gate } = gateWith('shop-secret');
    await expect(gate.unlock(BUILT_IN)).rejects.toBeInstanceOf(UnauthorizedError);
    // Same length as the override, different bytes: the timing-safe compare
    // must answer false, not merely refuse on length.
    await expect(gate.unlock('shop-secreT')).rejects.toBeInstanceOf(UnauthorizedError);
    const unlock = await gate.unlock('shop-secret');
    expect(gate.status(unlock.token)).toMatchObject({ unlocked: true, passwordOverridden: true });
  });

  it('an empty override means no override', async () => {
    const { gate } = gateWith('');
    await expect(gate.unlock(BUILT_IN)).resolves.toBeTruthy();
    expect(gate.status(undefined).passwordOverridden).toBe(false);
  });
});

describe('developer gate — tokens', () => {
  it('expires a token after the TTL and reports it locked', async () => {
    const { gate, clock } = gateWith('pw');
    const { token, expiresAt } = await gate.unlock('pw');
    expect(new Date(expiresAt).getTime()).toBe(clock.now() + DEVELOPER_TOKEN_TTL_MS);

    clock.advance(DEVELOPER_TOKEN_TTL_MS - 1);
    expect(gate.status(token).unlocked).toBe(true);
    expect(() => gate.assertUnlocked(token)).not.toThrow();

    clock.advance(1);
    expect(gate.status(token)).toMatchObject({ unlocked: false, expiresAt: null });
    expect(() => gate.assertUnlocked(token)).toThrow(UnauthorizedError);
  });

  it('lock forgets that token and only that token', async () => {
    const { gate } = gateWith('pw');
    const first = await gate.unlock('pw');
    const second = await gate.unlock('pw');
    gate.lock(first.token);
    expect(gate.status(first.token).unlocked).toBe(false);
    expect(gate.status(second.token).unlocked).toBe(true);
  });

  it('a made-up token is locked, and so is no token at all', () => {
    const { gate } = gateWith('pw');
    expect(gate.status('f'.repeat(64)).unlocked).toBe(false);
    expect(() => gate.assertUnlocked(undefined)).toThrow(
      expect.objectContaining({ messageKey: 'error.unauthorized.developerMode' }),
    );
  });
});

describe('developer gate — lockout', () => {
  it('answers 429 after the maximum failures, for the lockout window, then forgives', async () => {
    const { gate, clock } = gateWith('pw');

    for (let i = 0; i < DEVELOPER_UNLOCK_MAX_FAILURES; i += 1) {
      await expect(gate.unlock('wrong')).rejects.toBeInstanceOf(UnauthorizedError);
    }

    // Locked: even the right password is refused, and with the seconds left.
    await expect(gate.unlock('pw')).rejects.toMatchObject({
      constructor: TooManyRequestsError,
      seconds: DEVELOPER_UNLOCK_LOCKOUT_MS / 1000,
    });

    clock.advance(DEVELOPER_UNLOCK_LOCKOUT_MS - 1000);
    await expect(gate.unlock('pw')).rejects.toMatchObject({ seconds: 1 });

    clock.advance(1000);
    await expect(gate.unlock('pw')).resolves.toBeTruthy();
  });

  it('holds against guesses fired all at once: the right one behind ten wrong is still refused', async () => {
    // The real hash, so every check is a real asynchronous scrypt run.
    const { gate } = gateWith();
    const wrong = Array.from({ length: 10 }, () => gate.unlock('wrong'));
    const right = gate.unlock(BUILT_IN);

    const settled = await Promise.allSettled([...wrong, right]);
    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toEqual([]);
    expect(settled.filter((outcome) => outcome.status === 'rejected' && outcome.reason instanceof UnauthorizedError))
      .toHaveLength(DEVELOPER_UNLOCK_MAX_FAILURES);
    await expect(right).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('a success clears the failure count', async () => {
    const { gate } = gateWith('pw');
    for (let i = 0; i < DEVELOPER_UNLOCK_MAX_FAILURES - 1; i += 1) {
      await expect(gate.unlock('wrong')).rejects.toBeInstanceOf(UnauthorizedError);
    }
    await gate.unlock('pw');
    // One more wrong answer is the first of a fresh run, not the fifth.
    await expect(gate.unlock('wrong')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(gate.unlock('pw')).resolves.toBeTruthy();
  });
});
