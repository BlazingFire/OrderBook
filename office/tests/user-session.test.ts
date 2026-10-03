/**
 * Signing in on an Office Panel (docs/ROLES_AND_USERS.md §12, §15).
 *
 * The security-critical case is the fourth test. Sign-in has two paths, and the
 * offline one must be reachable only when the Master could not be *asked* —
 * never when it was asked and said no. Getting that backwards turns the panel
 * into a way around a password change or a deactivation, which is the one thing
 * an offline replica must not become.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let dataDir: string;
let usersFile: string;

let signInAttemptsFile: string;

vi.mock('../src/config/index.js', () => ({
  get config() {
    return { dataDir, usersFile, signInAttemptsFile, packageRoot: dataDir };
  },
}));

/** Stands in for the link to the Master, so these tests need no server. */
const link = {
  state: 'connected' as 'connected' | 'disconnected',
  signIn: vi.fn(),
  reconcile: vi.fn(),
  assumed: null as string | null,
  signedOut: [] as string[],
};

/**
 * The real class, reproduced rather than imported, because mocking the module
 * replaces every export. `unreachable` is the flag sign-in branches on, so the
 * mock has to carry it faithfully or the tests would prove nothing.
 */
class MasterCommandError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly missingPermission: string | undefined,
    readonly unreachable: boolean,
  ) {
    super(message);
    this.name = 'MasterCommandError';
  }
}

vi.mock('../src/realtime/master-connection.js', () => ({
  MasterCommandError,
  masterConnection: {
    getStatus: () => ({ state: link.state }),
    command: (event: string, payload: unknown) => {
      if (event === 'auth:signIn') return link.signIn(payload);
      if (event === 'auth:signOut') {
        link.signedOut.push(payload as string);
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    },
    assume: (token: string | null) => {
      link.assumed = token;
      return Promise.resolve({ status: 'released' });
    },
    reconcile: (users: unknown) => link.reconcile(users),
  },
}));

const userSession = await import('../src/services/user-session.service.js');
const userStore = await import('../src/services/user-store.js');
const attempts = await import('../src/services/sign-in-attempts.store.js');
const offlineAuthEvents = await import('../src/services/offline-auth-events.store.js');
const localStore = await import('../src/sync/local-store.js');

const MASTER_USER = {
  id: 'US000000000C',
  tenantId: '11111111-1111-4111-8111-111111111111',
  username: 'sunita',
  displayName: 'Sunita Shah',
  roleId: 'RL0000000004',
  roleName: 'Sales',
  roleTier: 'management' as const,
  isActive: true,
  lastSignInAt: null,
  deletedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sync: { version: 1, hlc: '', fieldHlc: {}, temporaryId: null },
  permissions: ['leads.view', 'leads.create', 'orders.view'],
  roleVersion: 4,
};

/** A successful online sign-in, which is what leaves a verifier behind. */
async function signInOnline(
  password = 'correct-horse',
  fingerprint = 'fp-original',
): Promise<void> {
  link.state = 'connected';
  link.signIn.mockResolvedValue({
    token: 'token-abc',
    user: MASTER_USER,
    credentialFingerprint: fingerprint,
  });
  await userSession.signIn('sunita', password);
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-session-'));
  usersFile = path.join(dataDir, 'users.json');
  signInAttemptsFile = path.join(dataDir, 'sign-in-attempts.json');

  link.state = 'connected';
  link.assumed = null;
  link.signedOut = [];
  link.signIn.mockReset();
  link.reconcile.mockReset();
  link.reconcile.mockResolvedValue([]);

  userStore.resetUserStore();
  userSession.resetSession();
  attempts.resetSignInAttempts();
  offlineAuthEvents.resetOfflineAuthEvents();
  localStore.resetLocalStore();
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('signing in on an Office Panel', () => {
  it('runs the Master path when the link is up, and acts as that person afterwards', async () => {
    await signInOnline();

    const session = userSession.currentSession();
    expect(session?.username).toBe('sunita');
    expect(session?.offline).toBe(false);
    expect(session?.permissions).toEqual(MASTER_USER.permissions);

    // The Master issued the token, so the panel presents it rather than
    // asserting an identity of its own.
    expect(link.assumed).toBe('token-abc');
  });

  it('refuses somebody who has never signed in on this panel while it is offline', async () => {
    link.state = 'disconnected';

    await expect(userSession.signIn('imran', 'whatever')).rejects.toThrow(/Sign-in failed/);
    expect(userSession.currentSession()).toBeNull();
  });

  it('lets somebody sign in offline once they have signed in here online before', async () => {
    await signInOnline('correct-horse');
    userSession.resetSession();

    link.state = 'disconnected';
    const session = await userSession.signIn('sunita', 'correct-horse');

    expect(session.username).toBe('sunita');
    // Flagged, because these permissions are a snapshot: an administrator's
    // change made while this panel was unreachable is not reflected in them.
    expect(session.offline).toBe(true);
    expect(session.permissions).toEqual(MASTER_USER.permissions);
  });

  it('does not fall back to the local record when the Master actively refuses', async () => {
    await signInOnline('old-password');
    userSession.resetSession();

    // The password changed on the Master. The panel is reachable and is told no.
    link.state = 'connected';
    link.signIn.mockRejectedValue(
      new MasterCommandError('Sign-in failed', 'AUTH_FAILED', undefined, false),
    );

    await expect(userSession.signIn('sunita', 'old-password')).rejects.toThrow(/Sign-in failed/);

    // The stale local verifier would have accepted this. It must not be reached.
    expect(userSession.currentSession()).toBeNull();
  });

  it('treats a Master-side failure it did not expect as a refusal, not as silence', async () => {
    await signInOnline('correct-horse');
    userSession.resetSession();

    // A statement timeout is a message the Master *sent* — so it was reachable,
    // and this is a refusal. The old substring check read the word "timeout" and
    // fell through to the local verifier, which is the whole bug.
    link.state = 'connected';
    link.signIn.mockRejectedValue(
      new MasterCommandError(
        'canceling statement due to statement timeout',
        'internal',
        undefined,
        false,
      ),
    );

    await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toThrow(/timeout/);
    expect(userSession.currentSession()).toBeNull();
  });

  it('falls back to the local record when the Master does not answer', async () => {
    await signInOnline('correct-horse');
    userSession.resetSession();

    link.state = 'connected';
    link.signIn.mockRejectedValue(
      new MasterCommandError('The Master Panel did not respond', undefined, undefined, true),
    );

    const session = await userSession.signIn('sunita', 'correct-horse');
    expect(session.offline).toBe(true);
  });

  it('refuses a wrong password offline', async () => {
    await signInOnline('correct-horse');
    userSession.resetSession();

    link.state = 'disconnected';
    await expect(userSession.signIn('sunita', 'wrong')).rejects.toThrow(/Sign-in failed/);
  });

  it('stores a verifier of its own, never the Master’s hash', async () => {
    await signInOnline('correct-horse');

    const stored = await userStore.findByUsername('sunita');

    expect(stored?.verifier.startsWith('scrypt$')).toBe(true);
    // Nothing resembling a password is recoverable from the file, and the
    // Master never sent a hash for the panel to copy in the first place.
    expect(JSON.stringify(stored)).not.toContain('correct-horse');
  });

  it('drops the offline record when the Master says the account was revoked', async () => {
    await signInOnline('correct-horse');

    // The account was deactivated on the Master, and the panel was told why.
    await userSession.rejectCurrent('revoked');

    expect(userSession.currentSession()).toBeNull();
    expect(await userStore.findByUsername('sunita')).toBeNull();

    // The whole point: pulling the network cable must not restore their access.
    link.state = 'disconnected';
    await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toThrow(/Sign-in failed/);
  });

  it('keeps the offline record when the session merely expired', async () => {
    await signInOnline('correct-horse');

    // A Master restart empties its in-memory session map, so every live token
    // reads as unknown. That is not a statement about the account, and treating
    // it as one would strip offline sign-in from everybody on every reboot.
    await userSession.rejectCurrent('expired');

    expect(userSession.currentSession()).toBeNull();
    expect(await userStore.findByUsername('sunita')).not.toBeNull();

    link.state = 'disconnected';
    const session = await userSession.signIn('sunita', 'correct-horse');
    expect(session.offline).toBe(true);
  });

  it('lets a reused username belong to the new person, not the one who left', async () => {
    // The Master's uniqueness index is partial on live rows, on purpose, so a
    // username freed by somebody leaving can be given to the next person.
    await signInOnline('her-old-password');
    userSession.resetSession();

    link.state = 'connected';
    link.signIn.mockResolvedValue({
      token: 'token-def',
      user: { ...MASTER_USER, id: 'US000000000D', displayName: 'Sunita Patel' },
      credentialFingerprint: 'fp-new-hire',
    });
    await userSession.signIn('sunita', 'his-new-password');
    userSession.resetSession();

    link.state = 'disconnected';

    // The store resolves a sign-in by username, and it kept both records —
    // the leaver's first, so the leaver's is the one it found. The new hire was
    // refused against a verifier that was never hers.
    const session = await userSession.signIn('sunita', 'his-new-password');
    expect(session.offline).toBe(true);
    expect(session.userId).toBe('US000000000D');

    // And the worse half: the person the company deleted could sign in here by
    // pulling the network cable.
    userSession.resetSession();
    attempts.resetSignInAttempts();
    await expect(userSession.signIn('sunita', 'her-old-password')).rejects.toThrow(
      /Sign-in failed/,
    );
  });

  describe('throttling guesses', () => {
    it('locks a username out after three failures, offline', async () => {
      await signInOnline('correct-horse');
      userSession.resetSession();
      link.state = 'disconnected';

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(userSession.signIn('sunita', 'wrong')).rejects.toThrow(/Sign-in failed/);
      }

      // The offline path is reachable precisely when the Master — which does
      // enforce this rule — cannot be asked. Without a counter here, an
      // unattended panel with the cable out is an unthrottled guessing oracle.
      await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toThrow(
        /Too many failed attempts/,
      );
    });

    it('keeps the lock across a panel restart', async () => {
      await signInOnline('correct-horse');
      userSession.resetSession();
      link.state = 'disconnected';

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await userSession.signIn('sunita', 'wrong').catch(() => undefined);
      }

      // Relaunching the panel is not a meaningful obstacle to somebody sitting
      // at the machine, so an in-memory counter would be no counter at all.
      attempts.resetSignInAttempts();

      await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toThrow(
        /Too many failed attempts/,
      );
    });

    it('clears the count on a successful sign-in', async () => {
      await signInOnline('correct-horse');
      userSession.resetSession();
      link.state = 'disconnected';

      await userSession.signIn('sunita', 'wrong').catch(() => undefined);
      await userSession.signIn('sunita', 'wrong').catch(() => undefined);
      await userSession.signIn('sunita', 'correct-horse');

      userSession.resetSession();
      await userSession.signIn('sunita', 'wrong').catch(() => undefined);

      // Two failures, a success, then one more failure — that is one, not three.
      const session = await userSession.signIn('sunita', 'correct-horse');
      expect(session.username).toBe('sunita');
    });
  });

  describe('revalidating stored sign-ins on reconnect', () => {
    it('forgets a verifier the Master no longer accepts', async () => {
      await signInOnline('correct-horse');
      userSession.resetSession();

      // The Master compared the fingerprint against the stored hash and found
      // the password had been reset while this panel was away.
      link.reconcile.mockResolvedValue(['US000000000C']);
      await userSession.reconcileKnownUsers();

      expect(await userStore.findByUsername('sunita')).toBeNull();

      link.state = 'disconnected';
      await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toThrow(/Sign-in failed/);
    });

    it('offers the Master the fingerprint it was given, not the verifier', async () => {
      await signInOnline('correct-horse', 'fp-abc123');
      await userSession.reconcileKnownUsers();

      const claims = link.reconcile.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
      expect(claims).toEqual([{ userId: 'US000000000C', credentialFingerprint: 'fp-abc123' }]);

      // The locally-minted verifier is this panel's business alone.
      expect(JSON.stringify(claims)).not.toContain('scrypt$');
    });

    it('keeps everything when the revalidation call fails', async () => {
      await signInOnline('correct-horse');
      link.reconcile.mockRejectedValue(new Error('socket closed'));

      await userSession.reconcileKnownUsers();

      // A dropped packet must not lock somebody out of their own panel.
      expect(await userStore.findByUsername('sunita')).not.toBeNull();
    });

    it('signs out the person at the panel when they are the one revoked', async () => {
      await signInOnline('correct-horse');
      link.reconcile.mockResolvedValue(['US000000000C']);

      await userSession.reconcileKnownUsers();

      expect(userSession.currentSession()).toBeNull();
    });
  });

  it('returns the panel to acting as itself on sign-out', async () => {
    await signInOnline();
    await userSession.signOut();

    expect(userSession.currentSession()).toBeNull();
    expect(link.assumed).toBeNull();
    expect(link.signedOut).toContain('token-abc');

    // The verifier stays: signing out is not being locked out, and this person
    // must still be able to sign back in with the Master switched off.
    expect(await userStore.findByUsername('sunita')).not.toBeNull();
  });

  it('matches the username case-insensitively, as the Master does', async () => {
    await signInOnline('correct-horse');
    userSession.resetSession();

    link.state = 'disconnected';
    const session = await userSession.signIn('  SUNITA ', 'correct-horse');
    expect(session.userId).toBe('US000000000C');
  });

  /*
   * A Server Master signs in on the Master PC only. The Master refuses one over
   * a panel socket already; if one got through anyway, this panel must keep no
   * verifier for it, or pulling the network cable would let it in here.
   */
  it('never remembers a Server Master, and ends the session the Master issued', async () => {
    link.signIn.mockResolvedValue({
      token: 'token-master',
      user: { ...MASTER_USER, username: 'master', roleTier: 'server_master' },
      credentialFingerprint: 'fp-master',
    });

    await expect(userSession.signIn('master', 'correct-horse')).rejects.toMatchObject({
      messageKey: 'error.unauthorized.serverMasterMasterPcOnly',
    });

    expect(userSession.currentSession()).toBeNull();
    expect(link.assumed).toBeNull();
    expect(link.signedOut).toContain('token-master');
    expect(await userStore.findByUsername('master')).toBeNull();

    // And so it cannot sign in offline either.
    link.state = 'disconnected';
    await expect(userSession.signIn('master', 'correct-horse')).rejects.toThrow(/Sign-in failed/);
  });
});

/**
 * `security.offlineSignInEnabled`, which is the only setting in the product
 * whose reader runs *because* the Master cannot be reached. It cannot call
 * `getSetting`; it reads the switch off the snapshot this panel already has on
 * disk.
 */
describe('the company switch for signing in offline', () => {
  /** A snapshot carrying only what this gate reads. */
  async function cacheSwitch(offlineSignInEnabled: boolean | undefined): Promise<void> {
    await localStore.setSnapshot({
      parties: [],
      products: [],
      categories: [],
      partyVariants: [],
      leads: [],
      orders: [],
      pipelines: [],
      optionLists: [],
      customFields: [],
      conflicts: [],
      dashboard: {} as never,
      permissions: [],
      serverHlc: '0',
      serverTime: '2026-09-18T00:00:00.000Z',
      ...(offlineSignInEnabled === undefined
        ? {}
        : { features: { offlineSignInEnabled } }),
    });
  }

  it('refuses an offline sign-in when the company turned it off', async () => {
    await signInOnline();
    await userSession.signOut();
    await cacheSwitch(false);

    link.state = 'disconnected';
    await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toMatchObject({
      code: 'offline_disabled',
    });
    expect(userSession.currentSession()).toBeNull();
  });

  it('still allows it while the company leaves it on', async () => {
    await signInOnline();
    await userSession.signOut();
    await cacheSwitch(true);

    link.state = 'disconnected';
    const session = await userSession.signIn('sunita', 'correct-horse');
    expect(session.offline).toBe(true);
  });

  it('reads the switch off disk after a panel restart, with the Master off', async () => {
    // The claim this whole design rests on. `getRawSnapshot()` would answer
    // null here — memory is empty after a restart and only the file survives —
    // and the person would be let in.
    await signInOnline();
    await userSession.signOut();
    await cacheSwitch(false);

    localStore.resetLocalStore();
    userSession.resetSession();

    link.state = 'disconnected';
    await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toMatchObject({
      code: 'offline_disabled',
    });
  });

  it('signs people in offline against a snapshot from an older Master', async () => {
    // `features` absent entirely: a Master built before this switch existed.
    // Absent means "as before", never "refuse" — reading it strictly would
    // strip offline sign-in from every panel in the middle of an upgrade.
    await signInOnline();
    await userSession.signOut();
    await cacheSwitch(undefined);

    link.state = 'disconnected';
    const session = await userSession.signIn('sunita', 'correct-horse');
    expect(session.offline).toBe(true);
  });

  it('does not count a refusal from the switch toward the lockout', async () => {
    // The lockout is checked ABOVE the online/offline branch, so counting these
    // would lock somebody out of their ONLINE sign-in for typing the right
    // password three times at a door the company had shut.
    await signInOnline();
    await userSession.signOut();
    await cacheSwitch(false);

    link.state = 'disconnected';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(userSession.signIn('sunita', 'correct-horse')).rejects.toMatchObject({
        code: 'offline_disabled',
      });
    }

    link.state = 'connected';
    link.signIn.mockResolvedValue({
      token: 'token-abc',
      user: MASTER_USER,
      credentialFingerprint: 'fp-original',
    });
    const session = await userSession.signIn('sunita', 'correct-horse');
    expect(session.offline).toBe(false);
  });
});
