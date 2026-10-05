/**
 * A malformed percent-escape in a path (`/api/orders/%E0%A4%A`) is the caller's
 * mistake. Express raises "Failed to decode param" for it, which the generic
 * handler used to answer 500 (1.4.3 R18).
 *
 * Pure: the session and the Master link are mocked, so this cannot skip.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import { createApp } from '../src/http/app.js';
import { masterConnection } from '../src/realtime/master-connection.js';
import * as userSession from '../src/services/user-session.service.js';

const SESSION = {
  userId: 'US000000000A',
  username: 'asha',
  displayName: 'Asha',
  roleId: 'RL0000000001',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['chat.use', 'orders.view'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

describe('malformed percent-encoding on the Office', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(SESSION as never);
    vi.spyOn(userSession, 'can').mockReturnValue(true);
    vi.spyOn(masterConnection, 'command').mockResolvedValue([] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('answers 400, not 500, and keeps serving', async () => {
    const app = createApp();

    for (const path of ['/api/orders/%E0%A4%A', '/api/chat/rooms/%E0%A4%A', '/api/leads/%']) {
      const reply = await request(app).get(path);
      expect(reply.status, path).toBe(400);
      expect(reply.body.messageKey, path).toBe('validation.request.badInput');
    }
    await request(app).get('/api/chat/rooms/room-1').expect(200);
  });
});
