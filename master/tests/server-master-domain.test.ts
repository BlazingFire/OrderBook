/**
 * The Server Master rules that need no database: the tier guards in
 * `domain/access.ts`, the loopback check, and the master-key gate with the
 * clock in hand. The gate is built with a hash made here, so no test ever
 * holds the real master key.
 */

import { describe, expect, it } from 'vitest';

import {
  DEVELOPER_UNLOCK_LOCKOUT_MS,
  DEVELOPER_UNLOCK_MAX_FAILURES,
  MASTER_KEY_TOKEN_TTL_MS,
  ROLE_TIERS,
  type RoleTier,
} from '@orderbook/shared';

import type { ActorContext } from '../src/domain/actor.js';
import {
  assertAdminTier,
  assertMayManageUser,
  assertServerMasterRoleFrozen,
  assertServerMastersRetained,
  assertTierAssignable,
} from '../src/domain/access.js';
import { ForbiddenError, TooManyRequestsError, UnauthorizedError, ValidationError } from '../src/lib/errors.js';
import { hashPassword } from '../src/lib/password.js';
import { isLoopbackAddress } from '../src/lib/network.js';
import { createMasterKeyGate } from '../src/services/master-key.service.js';

function actorAt(tier: RoleTier): ActorContext {
  return {
    tenantId: 'tenant',
    actorType: 'user',
    actorId: 'US0000000001',
    userId: 'US0000000001',
    permissions: { roleId: 'RL0000000001', roleName: tier, tier, permissions: [] },
    deviceCode: null,
    actorName: 'Someone',
  };
}

describe('assertMayManageUser — nobody manages a user who outranks them', () => {
  const cases = ROLE_TIERS.flatMap((actor) => ROLE_TIERS.map((target) => [actor, target] as const));

  it.each(cases)('%s acting on %s', (actor, target) => {
    const run = () => assertMayManageUser(actorAt(actor), target);
    if (ROLE_TIERS.indexOf(target) > ROLE_TIERS.indexOf(actor)) {
      expect(run).toThrow(ForbiddenError);
      try {
        run();
      } catch (error) {
        expect((error as ForbiddenError).messageKey).toBe('error.forbidden.serverMasterTarget');
      }
    } else {
      expect(run).not.toThrow();
    }
  });

  it('an admin may never manage a Server Master, and may still manage another admin', () => {
    expect(() => assertMayManageUser(actorAt('admin'), 'server_master')).toThrow(ForbiddenError);
    expect(() => assertMayManageUser(actorAt('admin'), 'admin')).not.toThrow();
    expect(() => assertMayManageUser(actorAt('server_master'), 'server_master')).not.toThrow();
  });

  it('refuses an actor with no permission set at all', () => {
    expect(() => assertMayManageUser({ ...actorAt('admin'), permissions: null }, 'office')).toThrow(
      ForbiddenError,
    );
  });
});

describe('assertServerMastersRetained — at least two must remain', () => {
  it.each([
    [0, 0, true],
    [1, 1, true],
    [2, 2, true],
    [3, 2, true],
    [2, 3, true],
    [2, 1, false],
    [1, 0, false],
    [3, 1, false],
  ])('%i before, %i after: allowed %s', (before, after, allowed) => {
    const run = () => assertServerMastersRetained(before, after);
    if (allowed) expect(run).not.toThrow();
    else expect(run).toThrow(ValidationError);
  });
});

describe('the Server Master role is reserved and frozen', () => {
  it('no other role may be created at, or moved to, the Server Master tier', () => {
    expect(() => assertTierAssignable('server_master')).toThrow(ValidationError);
    for (const tier of ['office', 'management', 'admin'] as const) {
      expect(() => assertTierAssignable(tier)).not.toThrow();
    }
  });

  it('the Server Master role itself cannot be changed', () => {
    expect(() => assertServerMasterRoleFrozen({ tier: 'server_master' })).toThrow(ValidationError);
    expect(() => assertServerMasterRoleFrozen({ tier: 'admin' })).not.toThrow();
  });
});

describe('assertAdminTier — admin or above', () => {
  it.each([
    ['office', false],
    ['management', false],
    ['admin', true],
    ['server_master', true],
  ] as const)('%s: allowed %s', (tier, allowed) => {
    const run = () => assertAdminTier(actorAt(tier), 'roles.create');
    if (allowed) expect(run).not.toThrow();
    else expect(run).toThrow(ForbiddenError);
  });
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('%s is the Master PC', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each(['192.168.1.5', '::ffff:192.168.1.5', '10.0.0.1', '', null, undefined])(
    '%s is not',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    },
  );
});

describe('the master-key gate', () => {
  const KEY = 'test-only-master-key';

  async function gateWithClock() {
    let at = 1_000_000;
    const gate = createMasterKeyGate({ now: () => at, passwordHash: await hashPassword(KEY) });
    return { gate, advance: (ms: number) => (at += ms) };
  }

  it('accepts the key it was built with and refuses another, with its own message keys', async () => {
    const { gate } = await gateWithClock();

    await expect(gate.unlock('not-the-key')).rejects.toMatchObject({
      constructor: UnauthorizedError,
      messageKey: 'error.unauthorized.masterKey',
    });
    await expect(gate.unlock('')).rejects.toMatchObject({
      constructor: ValidationError,
      messageKey: 'validation.masterKey.required',
    });

    const unlock = await gate.unlock(KEY);
    expect(() => gate.assertUnlocked(unlock.token)).not.toThrow();
    expect(() => gate.assertUnlocked(undefined)).toThrow(
      expect.objectContaining({ messageKey: 'error.unauthorized.masterKeyRequired' }),
    );
  });

  it('ignores the developer password override', async () => {
    const before = process.env.ORDERBOOK_DEVELOPER_PASSWORD;
    process.env.ORDERBOOK_DEVELOPER_PASSWORD = 'shop-secret';
    try {
      const { gate } = await gateWithClock();
      await expect(gate.unlock('shop-secret')).rejects.toBeInstanceOf(UnauthorizedError);
    } finally {
      if (before === undefined) delete process.env.ORDERBOOK_DEVELOPER_PASSWORD;
      else process.env.ORDERBOOK_DEVELOPER_PASSWORD = before;
    }
  });

  it('issues tokens that expire after the master-key lifetime, not the developer one', async () => {
    const { gate, advance } = await gateWithClock();
    const unlock = await gate.unlock(KEY);

    advance(MASTER_KEY_TOKEN_TTL_MS - 1);
    expect(() => gate.assertUnlocked(unlock.token)).not.toThrow();
    advance(1);
    expect(() => gate.assertUnlocked(unlock.token)).toThrow(UnauthorizedError);
  });

  it('locks for a minute after five wrong keys, then lets the right one in', async () => {
    const { gate, advance } = await gateWithClock();

    for (let i = 0; i < DEVELOPER_UNLOCK_MAX_FAILURES; i += 1) {
      await expect(gate.unlock('wrong')).rejects.toBeInstanceOf(UnauthorizedError);
    }
    // Locked: even the right key waits.
    await expect(gate.unlock(KEY)).rejects.toBeInstanceOf(TooManyRequestsError);

    advance(DEVELOPER_UNLOCK_LOCKOUT_MS);
    await expect(gate.unlock(KEY)).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('lock ends a token early', async () => {
    const { gate } = await gateWithClock();
    const unlock = await gate.unlock(KEY);
    gate.lock(unlock.token);
    expect(() => gate.assertUnlocked(unlock.token)).toThrow(UnauthorizedError);
  });
});
