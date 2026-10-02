/**
 * Sign-ins an Office Panel checks offline are kept for the Master's audit trail
 * (`office/src/services/offline-auth-events.store.ts`). The upload on reconnect
 * is covered in `master-connection.test.ts`, which drives the real socket
 * handlers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let dataDir: string;

vi.mock('../src/config/index.js', () => ({
  get config() {
    return { dataDir, packageRoot: dataDir };
  },
}));

// Offline is the only state these tests need: the link is down.
vi.mock('../src/realtime/master-connection.js', () => ({
  MasterCommandError: class extends Error {},
  masterConnection: {
    getStatus: () => ({ state: 'disconnected' }),
    command: () => Promise.reject(new Error('not connected')),
    assume: () => Promise.resolve({ status: 'released' }),
  },
}));

const store = await import('../src/services/offline-auth-events.store.js');
const userSession = await import('../src/services/user-session.service.js');
const userStore = await import('../src/services/user-store.js');
const attempts = await import('../src/services/sign-in-attempts.store.js');
const localStore = await import('../src/sync/local-store.js');
const { mintVerifier } = await import('../src/lib/password.js');

function event(n: number, success = true) {
  return {
    username: `user${n}`,
    success,
    at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
  };
}

/** An event as the store keeps it: with the id it was given on the way in. */
function stored(e: ReturnType<typeof event>) {
  return { ...e, id: expect.any(String) };
}

function eventsFile(): string {
  return path.join(dataDir, 'offline-auth-events.json');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-offline-auth-'));
  store.resetOfflineAuthEvents();
  userStore.resetUserStore();
  userSession.resetSession();
  attempts.resetSignInAttempts();
  localStore.resetLocalStore();
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the offline sign-in store', () => {
  it('keeps events in order on disk, and reads them back after a restart', async () => {
    await store.append(event(1));
    await store.append(event(2, false));

    store.resetOfflineAuthEvents();
    const kept = await store.peek();
    expect(kept).toEqual([stored(event(1)), stored(event(2, false))]);
    // Each its own id, kept across the restart, so the Master can tell a resend.
    expect(new Set(kept.map((e) => e.id)).size).toBe(2);

    // Written under a temp name and renamed, so nothing is left beside it.
    expect((await fs.readdir(dataDir)).sort()).toEqual(['offline-auth-events.json']);
  });

  it('drops the oldest past the cap of 500', async () => {
    for (let n = 1; n <= store.MAX_OFFLINE_AUTH_EVENTS + 2; n += 1) await store.append(event(n));

    const kept = await store.peek(Infinity);
    expect(kept).toHaveLength(store.MAX_OFFLINE_AUTH_EVENTS);
    expect(kept[0]).toEqual(stored(event(3)));
    expect(kept[kept.length - 1]).toEqual(stored(event(store.MAX_OFFLINE_AUTH_EVENTS + 2)));
  });

  it('drops failures before a success that has not been uploaded', async () => {
    await store.append(event(1));
    for (let n = 2; n <= store.MAX_OFFLINE_AUTH_EVENTS + 50; n += 1) await store.append(event(n, false));

    const kept = await store.peek(Infinity);
    expect(kept).toHaveLength(store.MAX_OFFLINE_AUTH_EVENTS);
    expect(kept[0]).toEqual(stored(event(1)));
    // The newest failures stay; the oldest went first.
    expect(kept[1]).toEqual(stored(event(52, false)));
  });

  it('drops exactly the events that were sent, even if more arrived meanwhile', async () => {
    await store.append(event(1));
    await store.append(event(2));

    const sent = await store.peek();
    await store.append(event(3));
    await store.drop(sent);

    expect(await store.peek()).toEqual([stored(event(3))]);
  });

  it('skips a username longer than the Master would accept', async () => {
    await store.append({ ...event(1), username: 'x'.repeat(store.MAX_OFFLINE_USERNAME + 1) });
    await store.append({ ...event(2), username: 'x'.repeat(store.MAX_OFFLINE_USERNAME) });

    expect((await store.peek()).map((kept) => kept.username.length)).toEqual([store.MAX_OFFLINE_USERNAME]);
  });

  it('starts empty from an unreadable file rather than refusing sign-ins', async () => {
    await fs.writeFile(eventsFile(), '{not json');

    expect(await store.peek()).toEqual([]);
    await store.append(event(1));
    expect(await store.peek()).toEqual([stored(event(1))]);
  });
});

describe('signing in offline records it for the Master', () => {
  beforeEach(async () => {
    await userStore.remember({
      userId: 'US000000000C',
      username: 'sunita',
      displayName: 'Sunita Shah',
      roleId: 'RL0000000004',
      roleName: 'Sales',
      roleTier: 'management',
      verifier: await mintVerifier('correct-horse'),
      credentialFingerprint: 'fp',
      permissions: ['leads.view'],
      roleVersion: 1,
      masterToken: null,
      lastSignInAt: new Date().toISOString(),
      avatarId: null,
      blurhash: null,
    });
  });

  it('records a successful offline sign-in with the user id', async () => {
    await userSession.signIn('sunita', 'correct-horse');

    expect(await store.peek()).toEqual([
      { username: 'sunita', userId: 'US000000000C', success: true, at: expect.any(String), id: expect.any(String) },
    ]);
  });

  it('records a wrong password, and a username this panel has never seen', async () => {
    await expect(userSession.signIn('sunita', 'wrong')).rejects.toThrow(/Sign-in failed/);
    await expect(userSession.signIn('imran', 'whatever')).rejects.toThrow(/Sign-in failed/);

    expect(await store.peek()).toEqual([
      { username: 'sunita', userId: 'US000000000C', success: false, at: expect.any(String), id: expect.any(String) },
      { username: 'imran', success: false, at: expect.any(String), id: expect.any(String) },
    ]);
  });
});
