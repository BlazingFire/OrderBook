/**
 * Developer mode on an Office Panel: the password door, the lockout behind
 * it, and the one tool it guards — putting this PC back to unpaired.
 *
 * `config` is mocked the way `storage-path.test.ts` does it, and for the same
 * reason: the real `dataDir` is a folder somebody may be running the panel
 * from, and a reset that erased it would be a very memorable test failure.
 * The Master link is mocked too — a reset must hang up, and the test only
 * needs to see that it did.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVELOPER_TOKEN_TTL_MS, DEVELOPER_UNLOCK_LOCKOUT_MS } from '@orderbook/shared';

/** Plaintext of `DEVELOPER_PASSWORD_HASH`, as `docs/DEVELOPER_MODE.md` publishes it. */
const BUILT_IN_PASSWORD = 'Dev@OrderBook2026';

let root: string;
let dataDir: string;
let disconnects = 0;
let clock = 1_000_000;

async function load() {
  vi.doMock('../src/config/index.js', () => ({
    config: {
      dataDir,
      packageRoot: root,
      settingsFile: path.join(root, 'office-settings.env'),
      http: { port: 4200 },
      hostname: 'test-pc',
    },
  }));
  vi.doMock('../src/realtime/master-connection.js', () => ({
    masterConnection: {
      disconnect: () => {
        disconnects += 1;
      },
      // `http/app.ts` subscribes at import time, so the route half of this
      // suite needs a listener to hang on — nothing in here ever emits.
      on: () => undefined,
    },
  }));

  const pathsModule = await import('../src/config/paths.js');
  pathsModule.resetPathsForTest();
  const developer = await import('../src/services/developer.service.js');
  developer.setDeveloperClockForTest(() => clock);
  const credentials = await import('../src/services/credentials.store.js');
  const userSession = await import('../src/services/user-session.service.js');
  const offlineAuthEvents = await import('../src/services/offline-auth-events.store.js');
  return { paths: pathsModule.paths, developer, credentials, userSession, offlineAuthEvents };
}

/**
 * The same panel, plus its HTTP layer — imported through the same mocked
 * graph, so the routes and the assertions are talking to one service.
 */
async function loadWithRoutes() {
  const loaded = await load();
  const { createApp } = await import('../src/http/app.js');
  return { ...loaded, app: createApp() };
}

/** Enough of a session for `currentSession()` to be somebody. */
const SIGNED_IN = {
  userId: 'US0000000001',
  username: 'kiran',
  displayName: 'Kiran',
  roleId: 'RL0000000001',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: [],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-developer-'));
  dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  disconnects = 0;
  clock = 1_000_000;
  delete process.env.ORDERBOOK_DEVELOPER_PASSWORD;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ORDERBOOK_DEVELOPER_PASSWORD;
  vi.doUnmock('../src/config/index.js');
  vi.doUnmock('../src/realtime/master-connection.js');
  await fs.rm(root, { recursive: true, force: true });
});

describe('the developer password', () => {
  it('unlocks with the built-in password and hands back a token with an expiry', async () => {
    const { developer } = await load();

    const unlocked = await developer.unlock(BUILT_IN_PASSWORD);

    expect(unlocked.token).toMatch(/^[0-9a-f]{64}$/);
    expect(unlocked.expiresAt).toBe(new Date(clock + DEVELOPER_TOKEN_TTL_MS).toISOString());
    expect(developer.status(unlocked.token)).toEqual({
      unlocked: true,
      expiresAt: unlocked.expiresAt,
      passwordOverridden: false,
    });
  });

  it('refuses a wrong password with a 401, not a lockout', async () => {
    const { developer } = await load();

    await expect(developer.unlock('not-it')).rejects.toMatchObject({ status: 401, code: 'developer_password' });
  });

  it('lets a .env replace the built-in password outright', async () => {
    process.env.ORDERBOOK_DEVELOPER_PASSWORD = 'site-secret';
    const { developer } = await load();

    // The built-in one stops working: an override is a replacement, not a
    // second key, or changing it in `.env` would protect nothing.
    await expect(developer.unlock(BUILT_IN_PASSWORD)).rejects.toMatchObject({ status: 401 });
    const unlocked = await developer.unlock('site-secret');
    expect(developer.status(unlocked.token).passwordOverridden).toBe(true);
  });
});

describe('lockout and tokens', () => {
  it('locks after five wrong answers and reopens once the minute is up', async () => {
    const { developer } = await load();

    for (let i = 0; i < 5; i += 1) {
      await expect(developer.unlock('wrong')).rejects.toMatchObject({ status: 401 });
    }
    await expect(developer.unlock(BUILT_IN_PASSWORD)).rejects.toMatchObject({
      status: 429,
      code: 'too_many_requests',
      details: { seconds: DEVELOPER_UNLOCK_LOCKOUT_MS / 1000 },
    });

    clock += DEVELOPER_UNLOCK_LOCKOUT_MS;
    await expect(developer.unlock(BUILT_IN_PASSWORD)).resolves.toBeTruthy();
  });

  it('forgets the failures once a right answer lands', async () => {
    const { developer } = await load();

    for (let i = 0; i < 4; i += 1) {
      await expect(developer.unlock('wrong')).rejects.toMatchObject({ status: 401 });
    }
    await developer.unlock(BUILT_IN_PASSWORD);
    for (let i = 0; i < 4; i += 1) {
      await expect(developer.unlock('wrong')).rejects.toMatchObject({ status: 401 });
    }

    // Four, then four: still under the limit if the success reset the count.
    await expect(developer.unlock(BUILT_IN_PASSWORD)).resolves.toBeTruthy();
  });

  it('stops honouring a token once its time is up', async () => {
    const { developer } = await load();
    const { token } = await developer.unlock(BUILT_IN_PASSWORD);

    clock += DEVELOPER_TOKEN_TTL_MS;

    expect(developer.isUnlocked(token)).toBe(false);
    expect(developer.status(token)).toMatchObject({ unlocked: false, expiresAt: null });
  });

  it('answers locked for a token it never issued, and for one that was locked', async () => {
    const { developer } = await load();
    const { token } = await developer.unlock(BUILT_IN_PASSWORD);

    expect(developer.isUnlocked('0'.repeat(64))).toBe(false);
    expect(developer.isUnlocked(undefined)).toBe(false);

    developer.lock(token);
    expect(developer.isUnlocked(token)).toBe(false);
  });
});

describe('resetting the panel', () => {
  it('erases every file and folder the panel owns, and nothing else', async () => {
    const { paths, developer, credentials, userSession } = await load();
    const current = paths();
    const { dataDir: folder, imagesDir, avatarsDir, ...files } = current;
    for (const file of Object.values(files)) {
      await fs.writeFile(file, '{}');
    }
    await fs.writeFile(current.credentialsFile, '{"panelId":"p1"}');
    await fs.mkdir(path.join(imagesDir, 'IM1'), { recursive: true });
    await fs.writeFile(path.join(imagesDir, 'IM1', 'card.webp'), 'x');
    await fs.mkdir(avatarsDir, { recursive: true });
    await fs.writeFile(path.join(avatarsDir, 'u1.webp'), 'x');
    const settingsFile = path.join(root, 'office-settings.env');
    await fs.writeFile(settingsFile, `ORDERBOOK_OFFICE_DATA_DIR=${folder}\n`);
    // Prime the store's cache so the assertion below proves the cache was
    // dropped, not merely that the file went.
    expect(await credentials.loadCredentials()).toMatchObject({ panelId: 'p1' });

    const result = await developer.resetPanel();

    expect(result).toEqual({ ok: true, state: 'unpaired' });
    for (const file of Object.values(files)) {
      await expect(fs.stat(file)).rejects.toThrow();
    }
    await expect(fs.stat(imagesDir)).rejects.toThrow();
    await expect(fs.stat(avatarsDir)).rejects.toThrow();
    // The folder itself is recreated, empty, so the next write has a home.
    await expect(fs.readdir(folder)).resolves.toEqual([]);
    // The pointer to the folder is not the folder: it survives.
    await expect(fs.readFile(settingsFile, 'utf8')).resolves.toContain('ORDERBOOK_OFFICE_DATA_DIR');
    expect(await credentials.loadCredentials()).toBeNull();
    expect(userSession.currentSession()).toBeNull();
    expect(disconnects).toBe(1);
  });

  it('forgets offline sign-ins waiting for upload, so the next pairing never receives them', async () => {
    const { developer, offlineAuthEvents } = await load();
    await offlineAuthEvents.append({ username: 'kiran', success: true, at: new Date(0).toISOString() });
    expect(await offlineAuthEvents.peek()).toHaveLength(1);

    await developer.resetPanel();

    expect(await offlineAuthEvents.peek()).toEqual([]);
  });

  it('succeeds on a panel that never had any of the files', async () => {
    const { developer, paths } = await load();

    await expect(developer.resetPanel()).resolves.toEqual({ ok: true, state: 'unpaired' });
    await expect(fs.readdir(paths().dataDir)).resolves.toEqual([]);
  });
});

/**
 * The routes, over HTTP: without these four the service above is code nobody
 * can reach, which is how it shipped the first time.
 */
describe('the developer routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function signedIn() {
    const loaded = await loadWithRoutes();
    vi.spyOn(loaded.userSession, 'currentSession').mockReturnValue(SIGNED_IN as never);
    return loaded;
  }

  it('turns every one of them away when nobody is signed in', async () => {
    const { app, userSession } = await loadWithRoutes();
    vi.spyOn(userSession, 'currentSession').mockReturnValue(null);

    const calls = [
      request(app).post('/api/developer/unlock').send({ password: BUILT_IN_PASSWORD }),
      request(app).get('/api/developer/status'),
      request(app).post('/api/developer/lock'),
      request(app).post('/api/developer/reset-all').send({ confirmation: 'RESET' }),
    ];

    // The `/api` `requireUser` gate, the same one standing in front of the
    // storage routes: developer mode is a second door, never the first.
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: 'not_signed_in' });
    }
  });

  it('unlocks, reports the unlocked status for that token, and locks again', async () => {
    const { app } = await signedIn();

    const unlocked = await request(app)
      .post('/api/developer/unlock')
      .send({ password: BUILT_IN_PASSWORD });
    expect(unlocked.status).toBe(201);
    expect(unlocked.body.token).toMatch(/^[0-9a-f]{64}$/);

    const token = unlocked.body.token as string;
    const status = await request(app).get('/api/developer/status').set('x-developer-token', token);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      unlocked: true,
      expiresAt: unlocked.body.expiresAt,
      passwordOverridden: false,
    });

    // No header is not an error, it is simply locked — the panel asks for the
    // status before it knows whether it holds a token.
    await expect(
      request(app)
        .get('/api/developer/status')
        .then((r) => r.body.unlocked),
    ).resolves.toBe(false);

    const locked = await request(app).post('/api/developer/lock').set('x-developer-token', token);
    expect(locked.status).toBe(200);
    expect(locked.body).toEqual({ ok: true });
    await expect(
      request(app)
        .get('/api/developer/status')
        .set('x-developer-token', token)
        .then((r) => r.body.unlocked),
    ).resolves.toBe(false);
  });

  it('refuses a missing password before it ever reaches the lockout counter', async () => {
    const { app, developer } = await signedIn();

    const response = await request(app).post('/api/developer/unlock').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'validation_error' });
    // Had it counted as a failure, five of these would have locked the door on
    // somebody who never guessed at all.
    await expect(developer.unlock(BUILT_IN_PASSWORD)).resolves.toBeTruthy();
  });

  it('carries a wrong password through as a 401, and the lockout through with its seconds', async () => {
    const { app } = await signedIn();

    const wrong = await request(app).post('/api/developer/unlock').send({ password: 'not-it' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ error: 'developer_password' });
    expect(wrong.body.details).toBeUndefined();

    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/api/developer/unlock').send({ password: 'not-it' });
    }
    const locked = await request(app)
      .post('/api/developer/unlock')
      .send({ password: BUILT_IN_PASSWORD });

    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({
      error: 'too_many_requests',
      details: { seconds: DEVELOPER_UNLOCK_LOCKOUT_MS / 1000 },
    });
  });

  it('guards the reset with the token first and the typed word second', async () => {
    const { app, paths } = await signedIn();
    await fs.writeFile(paths().credentialsFile, '{"panelId":"p1"}');

    const noToken = await request(app)
      .post('/api/developer/reset-all')
      .send({ confirmation: 'RESET' });
    expect(noToken.status).toBe(401);
    expect(noToken.body).toMatchObject({ error: 'developer_locked' });

    const { body } = await request(app)
      .post('/api/developer/unlock')
      .send({ password: BUILT_IN_PASSWORD });
    const token = body.token as string;

    const unconfirmed = await request(app)
      .post('/api/developer/reset-all')
      .set('x-developer-token', token)
      .send({ confirmation: 'reset' });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body).toMatchObject({ error: 'validation_error' });
    // Refused means refused: the file is still there.
    await expect(fs.stat(paths().credentialsFile)).resolves.toBeTruthy();

    const done = await request(app)
      .post('/api/developer/reset-all')
      .set('x-developer-token', token)
      .send({ confirmation: 'RESET' });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ ok: true, state: 'unpaired' });
    await expect(fs.stat(paths().credentialsFile)).rejects.toThrow();
    expect(disconnects).toBe(1);
  });
});
