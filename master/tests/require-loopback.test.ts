/**
 * The Master-PC-only routes refuse a LAN caller before reading what it sent.
 *
 * The case that matters is the restore preview: it takes a multipart upload
 * that multer buffers in memory, up to a gigabyte. `requireLoopback` has to run
 * ahead of `backupUpload.single`, so a LAN host is turned away before multer
 * reads a byte — which this file proves by counting multer's invocations.
 *
 * No database: the one repository the setup routes consult before the upload
 * (`findMasterConfig`, behind "is this Master set up?") is mocked, and the
 * caller's address is set on the socket the way `isLoopback` reads it.
 */

import express, { type Express } from 'express';
import type multerModule from 'multer';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ multerCalls: 0, setUp: false }));

vi.mock('multer', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof multerModule }>()).default;
  const counting = (options?: Parameters<typeof actual>[0]) => {
    const instance = actual(options);
    const single = instance.single.bind(instance);
    instance.single = (field: string) => {
      const handler = single(field);
      return (req, res, next) => {
        state.multerCalls += 1;
        handler(req, res, next);
      };
    };
    return instance;
  };
  return { default: Object.assign(counting, actual) };
});

vi.mock('../src/repositories/master-config.repository.js', () => ({
  findMasterConfig: vi.fn(async () =>
    state.setUp
      ? {
          id: 1,
          tenant_id: 'tenant',
          master_unique_id: 'master',
          company_name: null,
          lan_ip: '127.0.0.1',
          port: 4100,
          pairing_password_hash: 'x',
          setup_completed_at: new Date(),
        }
      : null,
  ),
  insertMasterConfig: vi.fn(),
  updateLanIp: vi.fn(),
}));

const { errorHandler } = await import('../src/http/middleware/error-handler.js');
const { requireLoopback } = await import('../src/http/middleware/require-loopback.js');
const { masterKeyRoutes } = await import('../src/http/routes/master-key.routes.js');
const { setupRoutes } = await import('../src/http/routes/setup.routes.js');

/** An app whose every request appears to come from `address`. */
function appFrom(address: string): Express {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address, configurable: true });
    next();
  });
  app.use(express.json());
  app.use('/api/setup', setupRoutes);
  app.use('/api/master-key', masterKeyRoutes);
  app.use(errorHandler);
  return app;
}

const LAN = '192.168.1.5';

beforeEach(() => {
  state.multerCalls = 0;
  state.setUp = false;
});

function check(remoteAddress: string, headers: { host?: string; origin?: string }) {
  const next = vi.fn();
  requireLoopback({ socket: { remoteAddress }, headers } as never, {} as never, next);
  return next.mock.calls[0]?.[0];
}

describe('requireLoopback', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('lets %s through', (address) => {
    expect(check(address, { host: '127.0.0.1:4100' })).toBeUndefined();
  });

  it.each([
    { host: 'localhost:4100', origin: 'http://localhost:4100' },
    { host: '[::1]:4100' },
  ])('lets the Master PC through by any of its names: %o', (headers) => {
    expect(check('127.0.0.1', headers)).toBeUndefined();
  });

  it('refuses anything else with 403 masterPcOnly', () => {
    expect(check(LAN, { host: '127.0.0.1:4100' })).toMatchObject({
      statusCode: 403,
      messageKey: 'error.forbidden.masterPcOnly',
    });
  });

  it.each([
    { host: 'rebound.example:4100' },
    { host: '127.0.0.1:4100', origin: 'http://evil.example' },
    { host: '127.0.0.1:4100', origin: 'null' },
    {},
  ])('refuses loopback whose Host or Origin names another site: %o', (headers) => {
    expect(check('127.0.0.1', headers)).toMatchObject({ statusCode: 403 });
  });
});

describe('the restore preview', () => {
  it('refuses a multipart upload from the LAN with 403, and multer never runs', async () => {
    const response = await request(appFrom(LAN))
      .post('/api/setup/restore/preview')
      .attach('file', Buffer.alloc(64 * 1024, 1), 'backup.obbackup')
      .expect(403);

    expect(response.body.messageKey).toBe('error.forbidden.masterPcOnly');
    expect(state.multerCalls).toBe(0);
  });

  it('refuses the restore itself from the LAN the same way', async () => {
    await request(appFrom(LAN))
      .post('/api/setup/restore')
      .field('passphrase', 'whatever')
      .attach('file', Buffer.alloc(1024, 1), 'backup.obbackup')
      .expect(403);
    expect(state.multerCalls).toBe(0);
  });

  it('is refused on the Master PC too once setup has run, still before multer', async () => {
    state.setUp = true;
    const response = await request(appFrom('127.0.0.1'))
      .post('/api/setup/restore/preview')
      .attach('file', Buffer.alloc(1024, 1), 'backup.obbackup')
      .expect(409);

    expect(response.body.messageKey).toBe('error.conflict.alreadySetUp');
    expect(state.multerCalls).toBe(0);
  });

  it('reaches multer on the Master PC before setup — the counter above is live', async () => {
    await request(appFrom('127.0.0.1'))
      .post('/api/setup/restore/preview')
      .attach('file', Buffer.from('not a backup'), 'backup.obbackup');

    expect(state.multerCalls).toBe(1);
  });
});

describe('the other Master-PC-only routes', () => {
  it('refuses first-run setup from the LAN', async () => {
    await request(appFrom(LAN)).post('/api/setup/initialize').send({ accounts: [] }).expect(403);
  });

  it('refuses a restore posted to loopback by a page from another site', async () => {
    await request(appFrom('127.0.0.1'))
      .post('/api/setup/restore/preview')
      .set('Origin', 'http://evil.example')
      .attach('file', Buffer.from('not a backup'), 'backup.obbackup')
      .expect(403);
    expect(state.multerCalls).toBe(0);
  });

  it('refuses every master-key route from the LAN', async () => {
    const app = appFrom(LAN);
    await request(app).post('/api/master-key/verify').send({ key: 'anything' }).expect(403);
    await request(app).post('/api/master-key/lock').expect(403);
    await request(app).get('/api/master-key/server-masters').expect(403);
    await request(app).post('/api/master-key/server-masters').send({ accounts: [] }).expect(403);
    await request(app).post('/api/master-key/recover').send({}).expect(403);
  });

  it('refuses the pairing-password change from the LAN before asking who is signed in', async () => {
    await request(appFrom(LAN)).post('/api/setup/pairing-password').expect(403);
  });

  it('tells the status screen whether it is on the Master PC', async () => {
    const lan = await request(appFrom(LAN)).get('/api/setup/status').expect(200);
    expect(lan.body).toEqual({ setupComplete: false, onMasterPc: false, serverMasterSetupNeeded: false });

    const local = await request(appFrom('::1')).get('/api/setup/status').expect(200);
    expect(local.body.onMasterPc).toBe(true);
  });
});
