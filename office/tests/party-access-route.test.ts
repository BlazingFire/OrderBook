/**
 * `GET /api/party-access` and `GET /api/party-access/summary` (Party Access redesign): the list's
 * new `sort` and `dir`, and the summary strip's counts, forwarded to the Master. Party Access is
 * not editable offline, so with the Master away both answer 503.
 *
 * Pure — `masterConnection` and the signed-in session are mocked.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import { createApp } from '../src/http/app.js';
import { MasterCommandError, masterConnection } from '../src/realtime/master-connection.js';
import * as userSession from '../src/services/user-session.service.js';

const FAKE_SESSION = {
  userId: 'US0000000001',
  username: 'kiran',
  displayName: 'Kiran',
  roleId: 'RL0000000001',
  roleName: 'Admin',
  roleTier: 'admin',
  permissions: ['party.assign'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

describe('the Party Access list and its summary', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the search, the person filter, the sort and the direction', async () => {
    const page = { items: [], total: 0, limit: 50, offset: 0 };
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue(page as never);

    const response = await request(createApp()).get(
      '/api/party-access?search=raj&userId=US0000000007&restriction=restricted&sort=city&dir=desc&limit=25&offset=50',
    );

    expect(response.status).toBe(200);
    expect(command).toHaveBeenCalledWith('partyAccess:list', {
      search: 'raj',
      userId: 'US0000000007',
      restriction: 'restricted',
      sort: 'city',
      dir: 'desc',
      limit: 25,
      offset: 50,
    });
  });

  it('drops a sort or direction it does not know rather than passing it on', async () => {
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue({ items: [] } as never);

    await request(createApp()).get('/api/party-access?sort=phone;drop&dir=sideways');

    const query = command.mock.calls[0]?.[1] as { sort?: string; dir?: string };
    expect(query.sort).toBeUndefined();
    expect(query.dir).toBe('asc');
  });

  it("forwards the summary as `partyAccess:summary` and answers with the Master's counts", async () => {
    const counts = { total: 7, restricted: 3, open: 4 };
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue(counts as never);

    const response = await request(createApp()).get('/api/party-access/summary');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(counts);
    expect(command).toHaveBeenCalledWith('partyAccess:summary');
  });

  it('is not read as a party id, and answers 503 while the Master cannot be reached', async () => {
    const command = vi
      .spyOn(masterConnection, 'command')
      .mockRejectedValue(new MasterCommandError('Not connected to the Master Panel', undefined, undefined, true));

    const response = await request(createApp()).get('/api/party-access/summary');

    expect(response.status).toBe(503);
    expect(command).not.toHaveBeenCalledWith('partyAccess:forParty', 'summary');
  });

  it('is behind the sign-in gate', async () => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(null);
    const command = vi.spyOn(masterConnection, 'command');

    const response = await request(createApp()).get('/api/party-access/summary');

    expect(response.status).toBe(401);
    expect(command).not.toHaveBeenCalled();
  });
});
