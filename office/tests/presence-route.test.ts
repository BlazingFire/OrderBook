/**
 * `POST /api/presence` (1.3 Phase 4, rule 3): an open record screen's beat,
 * forwarded to the Master as `presence:beat`. Presence lives on the Master
 * only, so offline this answers 503 and the screen shows nobody.
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
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['leads.view'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

describe('POST /api/presence', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the beat with only the protocol's fields, and answers with the Master's view", async () => {
    const presence = { recordKind: 'lead', recordId: 'LD0000000042', entries: [] };
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue(presence as never);

    const response = await request(createApp()).post('/api/presence').send({
      tabId: 'a1b2c3',
      recordKind: 'lead',
      recordId: 'LD0000000042',
      editing: true,
      // Never forwarded: the Master takes who is beating from the session.
      userId: 'US0000000099',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(presence);
    expect(command).toHaveBeenCalledWith('presence:beat', {
      tabId: 'a1b2c3',
      recordKind: 'lead',
      recordId: 'LD0000000042',
      editing: true,
    });
  });

  it('forwards a leave (no record) as just the tab id, and drops a kind it does not know', async () => {
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue(null as never);

    await request(createApp()).post('/api/presence').send({ tabId: 'a1b2c3', recordKind: 'party', editing: 'yes' });

    expect(command).toHaveBeenCalledWith('presence:beat', { tabId: 'a1b2c3' });
  });

  it('answers 503 while the Master cannot be reached', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError('Not connected to the Master Panel', undefined, undefined, true),
    );

    const response = await request(createApp()).post('/api/presence').send({ tabId: 'a1b2c3' });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'unavailable' });
  });

  it('is behind the sign-in gate', async () => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(null);
    const command = vi.spyOn(masterConnection, 'command');

    const response = await request(createApp()).post('/api/presence').send({ tabId: 'a1b2c3' });

    expect(response.status).toBe(401);
    expect(command).not.toHaveBeenCalled();
  });
});

describe('GET /api/presence/board (1.4 R22)', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the kind as `presence:board` and answers with the Master's board", async () => {
    const board = { recordKind: 'order', records: { OD0000000001: [] } };
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue(board as never);

    const response = await request(createApp()).get('/api/presence/board?kind=order');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(board);
    expect(command).toHaveBeenCalledWith('presence:board', 'order');
  });

  it('refuses a kind that is not a board without troubling the Master', async () => {
    const command = vi.spyOn(masterConnection, 'command');

    for (const query of ['', '?kind=party', '?kind=lead,order']) {
      const response = await request(createApp()).get('/api/presence/board' + query);
      expect(response.status).toBe(400);
    }
    expect(command).not.toHaveBeenCalled();
  });

  it('answers 503 while the Master cannot be reached, and sits behind the sign-in gate', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError('Not connected to the Master Panel', undefined, undefined, true),
    );
    expect((await request(createApp()).get('/api/presence/board?kind=lead')).status).toBe(503);

    vi.spyOn(userSession, 'currentSession').mockReturnValue(null);
    const command = vi.spyOn(masterConnection, 'command');
    command.mockClear();
    expect((await request(createApp()).get('/api/presence/board?kind=lead')).status).toBe(401);
    expect(command).not.toHaveBeenCalled();
  });
});
