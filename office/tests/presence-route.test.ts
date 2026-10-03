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
