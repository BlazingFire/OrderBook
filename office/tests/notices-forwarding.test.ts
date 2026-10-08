/**
 * The Office end of the notice board: what this panel's server forwards to the Master, and what
 * it will and will not show out of its cache.
 *
 * Pure: the Master link, the session and the local store are mocked, so this needs no cluster.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notice, SellToday, SyncSnapshot } from '@orderbook/shared';

vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import { createApp } from '../src/http/app.js';
import { MasterCommandError, masterConnection } from '../src/realtime/master-connection.js';
import * as userSession from '../src/services/user-session.service.js';
import * as localStore from '../src/sync/local-store.js';

const SESSION = {
  userId: 'US000000000B',
  username: 'bina',
  displayName: 'Bina',
  roleId: 'RL0000000002',
  roleName: 'Dispatch',
  roleTier: 'office',
  permissions: ['notices.view'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

const notice = (id: string, over: Partial<Notice> = {}): Notice =>
  ({
    id,
    tenantId: 't1',
    title: id,
    body: '',
    priority: 'normal',
    pinned: false,
    showUntil: null,
    audience: { kind: 'all' },
    authorId: null,
    authorName: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    version: 1,
    readByMe: true,
    ...over,
  }) as Notice;

function view(over: Partial<SyncSnapshot> = {}) {
  return {
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
    dashboard: { asOf: '2026-10-07T00:00:00.000Z' },
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-10-07T00:00:00.000Z',
    pendingCount: 0,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.spyOn(userSession, 'currentSession').mockReturnValue(SESSION as never);
  vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(SESSION.permissions);
  vi.spyOn(userSession, 'can').mockImplementation((permission: string) =>
    SESSION.permissions.includes(permission),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('notice forwarding', () => {
  it('forwards every route to the matching Master command with the same facts', async () => {
    vi.spyOn(masterConnection, 'getStatus').mockReturnValue({ state: 'connected' } as never);
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue({} as never);
    const app = createApp();

    await request(app).get('/api/notices').expect(200);
    await request(app).get('/api/notices/manage').expect(200);
    await request(app).get('/api/notices/audiences').expect(200);
    await request(app).get('/api/notices/N1/readers').expect(200);
    await request(app)
      .post('/api/notices/read')
      .send({ ids: ['N1'] })
      .expect(200);
    await request(app).post('/api/notices/read').send({}).expect(200);
    await request(app).post('/api/notices').send({ title: 'Hi', body: '' }).expect(201);
    await request(app)
      .patch('/api/notices/N1')
      .send({ expectedVersion: 2, pinned: true })
      .expect(200);
    await request(app).delete('/api/notices/N1').expect(200);

    expect(command.mock.calls).toEqual([
      ['notice:list'],
      ['notice:manageList'],
      ['notice:audiences'],
      ['notice:readers', 'N1'],
      ['notice:markRead', { ids: ['N1'] }],
      ['notice:markRead', {}],
      ['notice:create', { title: 'Hi', body: '' }],
      ['notice:update', { expectedVersion: 2, pinned: true, id: 'N1' }],
      ['notice:delete', 'N1'],
    ]);
  });
});

describe('the board while the Master is not reachable', () => {
  beforeEach(() => {
    vi.spyOn(masterConnection, 'getStatus').mockReturnValue({ state: 'disconnected' } as never);
  });

  it('answers from the cached snapshot: this person’s own notices, minus any past their last day, newest and pinned first', async () => {
    vi.spyOn(localStore, 'getView').mockResolvedValue(
      view({
        builtForUserId: SESSION.userId,
        notices: [
          notice('old', { showUntil: '2020-01-01' }),
          notice('plain', { readByMe: false }),
          notice('pinned', { pinned: true, readByMe: false }),
          notice('forDispatch', { priority: 'important', audience: { kind: 'roles', roleIds: ['RL0000000002'] } }),
        ],
      }),
    );

    const response = await request(createApp()).get('/api/notices').expect(200);

    expect(response.body.notices.map((n: Notice) => n.id)).toEqual([
      'pinned',
      'forDispatch',
      'plain',
    ]);
    expect(response.body.unreadCount).toBe(2);
  });

  it('shows nobody the notices of somebody else’s cache but the ones for everybody, with no read marks', async () => {
    vi.spyOn(localStore, 'getView').mockResolvedValue(
      view({
        builtForUserId: 'US-ADMIN',
        notices: [
          notice('everyone', { readByMe: true }),
          notice('admins only', { audience: { kind: 'roles', roleIds: ['RL-ADMIN'] } }),
        ],
      }),
    );

    const board = await request(createApp()).get('/api/notices').expect(200);
    expect(board.body.notices.map((n: Notice) => [n.id, n.readByMe])).toEqual([
      ['everyone', false],
    ]);

    const snapshot = await request(createApp()).get('/api/snapshot').expect(200);
    expect(snapshot.body.notices.map((n: Notice) => n.id)).toEqual(['everyone']);
    expect(JSON.stringify(snapshot.body)).not.toContain('admins only');
  });

  it('shows nothing to somebody without notices.view, and says why on the board route', async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue([]);
    vi.spyOn(userSession, 'can').mockReturnValue(false);
    vi.spyOn(localStore, 'getView').mockResolvedValue(
      view({ builtForUserId: SESSION.userId, notices: [notice('a')] }),
    );

    const board = await request(createApp()).get('/api/notices');
    expect(board.status).toBe(403);
    expect(board.body.permission).toBe('notices.view');

    const snapshot = await request(createApp()).get('/api/snapshot').expect(200);
    expect(snapshot.body.notices).toEqual([]);
  });

  it('cannot record a read offline: that needs the Master', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      Object.assign(new Error('Not connected'), { unreachable: true }),
    );

    const response = await request(createApp())
      .post('/api/notices/read')
      .send({ ids: ['N1'] });

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});

describe('"Sell today" (2026-10-08)', () => {
  const entry = (id: string, over: Partial<SellToday> = {}): SellToday => ({
    id,
    tenantId: 't1',
    title: id,
    body: '',
    productIds: [],
    products: [],
    autoCloseSeconds: 15,
    showFrom: null,
    showUntil: null,
    audience: { kind: 'all' },
    authorId: null,
    authorName: null,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    version: 1,
    ...over,
  });

  it('forwards its three routes to its own commands, and deletes through notice:delete', async () => {
    vi.spyOn(masterConnection, 'getStatus').mockReturnValue({ state: 'connected' } as never);
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue({} as never);
    const app = createApp();

    await request(app).get('/api/notices/sell-today').expect(200);
    await request(app).post('/api/notices/sell-today').send({ title: 'Push', productIds: ['PR1'] }).expect(201);
    await request(app)
      .patch('/api/notices/sell-today/S1')
      .send({ expectedVersion: 1, autoCloseSeconds: 0 })
      .expect(200);
    await request(app).delete('/api/notices/S1').expect(200);

    expect(command.mock.calls).toEqual([
      ['sellToday:manageList'],
      ['sellToday:create', { title: 'Push', productIds: ['PR1'] }],
      ['sellToday:update', { expectedVersion: 1, autoCloseSeconds: 0, id: 'S1' }],
      ['notice:delete', 'S1'],
    ]);
  });

  it('says a Master too old for it needs an update (426), not that it failed', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError('The Master Panel needs an update', 'updateNeeded', undefined, false),
    );

    const response = await request(createApp()).get('/api/notices/sell-today');

    expect(response.status).toBe(426);
    expect(response.body.error).toBe('updateNeeded');
  });

  it('gates the cached entries like the notices: the person’s own, everybody’s from another cache, none without notices.view', async () => {
    vi.spyOn(masterConnection, 'getStatus').mockReturnValue({ state: 'disconnected' } as never);
    const cached = [entry('for all'), entry('admins only', { audience: { kind: 'roles', roleIds: ['RL-ADMIN'] } })];

    vi.spyOn(localStore, 'getView').mockResolvedValue(view({ builtForUserId: SESSION.userId, sellToday: cached }));
    const own = await request(createApp()).get('/api/snapshot').expect(200);
    expect(own.body.sellToday.map((e: SellToday) => e.id)).toEqual(['for all', 'admins only']);

    vi.spyOn(localStore, 'getView').mockResolvedValue(view({ builtForUserId: 'US-ADMIN', sellToday: cached }));
    const other = await request(createApp()).get('/api/snapshot').expect(200);
    expect(other.body.sellToday.map((e: SellToday) => e.id)).toEqual(['for all']);

    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue([]);
    const none = await request(createApp()).get('/api/snapshot').expect(200);
    expect(none.body.sellToday).toEqual([]);
  });
});
