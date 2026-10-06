/**
 * D6 F-N5: with nobody signed in, the Master builds this panel's snapshot as the panel's own
 * role (`panel-actor.service.ts`), so the cache can hold that role's notices, bodies included,
 * with `builtForUserId: null`. None of it may reach the sign-in screen, and the next person
 * may see only what is for everybody, unread, until their own snapshot arrives.
 *
 * Pure: the Master link, the session and the local store are mocked, so this needs no cluster.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notice, SyncSnapshot } from '@orderbook/shared';

vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import { createApp } from '../src/http/app.js';
import { masterConnection } from '../src/realtime/master-connection.js';
import * as userSession from '../src/services/user-session.service.js';
import * as localStore from '../src/sync/local-store.js';

const notice = (id: string, over: Partial<Notice> = {}): Notice =>
  ({
    id,
    title: id,
    body: `secret body of ${id}`,
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

/** The cache as the Master built it for the panel's own role: nobody's, with an Office-role notice. */
const panelActorCache = {
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
  permissions: ['notices.view'],
  serverHlc: '0',
  serverTime: '2026-10-07T00:00:00.000Z',
  pendingCount: 0,
  builtForUserId: null,
  notices: [
    notice('everyone'),
    notice('office role only', { audience: { kind: 'roles', roleIds: ['RL-OFFICE'] } }),
  ],
} as unknown as SyncSnapshot & { pendingCount: number };

beforeEach(() => {
  vi.spyOn(masterConnection, 'getStatus').mockReturnValue({ state: 'disconnected' } as never);
  vi.spyOn(localStore, 'getView').mockResolvedValue(panelActorCache as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('notices in a cache built for the panel itself (F-N5)', () => {
  it('gives the sign-in screen nothing: snapshot, board and event stream all need a person', async () => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(null);
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue([]);
    vi.spyOn(userSession, 'can').mockReturnValue(false);
    const app = createApp();

    for (const path of ['/api/snapshot', '/api/notices', '/api/events']) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(401);
      expect(response.text, path).not.toContain('secret body');
    }
  });

  it('shows the next person only the notices for everybody, unread, never the panel role’s own', async () => {
    const session = {
      userId: 'US-SALES',
      username: 'sam',
      displayName: 'Sam',
      roleId: 'RL-SALES',
      roleName: 'Sales',
      roleTier: 'office',
      permissions: ['notices.view'],
      offline: true,
      signedInAt: new Date(0).toISOString(),
    };
    vi.spyOn(userSession, 'currentSession').mockReturnValue(session as never);
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(session.permissions);
    vi.spyOn(userSession, 'can').mockImplementation((p: string) => session.permissions.includes(p));
    const app = createApp();

    const snapshot = await request(app).get('/api/snapshot').expect(200);
    expect(snapshot.body.notices.map((n: Notice) => [n.id, n.readByMe])).toEqual([
      ['everyone', false],
    ]);
    expect(JSON.stringify(snapshot.body)).not.toContain('office role only');

    const board = await request(app).get('/api/notices').expect(200);
    expect(board.body.notices.map((n: Notice) => n.id)).toEqual(['everyone']);
    expect(board.body.unreadCount).toBe(1);
  });
});
