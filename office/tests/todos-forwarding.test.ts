/**
 * The Office end of the To-do list: every route is forwarded to the Master's `todo:*` command
 * with the same facts, and nothing is answered from the cache.
 *
 * Pure: the Master link and the session are mocked, so this needs no cluster.
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
  userId: 'US000000000B',
  username: 'bina',
  displayName: 'Bina',
  roleId: 'RL0000000002',
  roleName: 'Dispatch',
  roleTier: 'office',
  permissions: ['todos.view'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

beforeEach(() => {
  vi.spyOn(userSession, 'currentSession').mockReturnValue(SESSION as never);
  vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(SESSION.permissions);
  vi.spyOn(userSession, 'can').mockImplementation((permission: string) =>
    SESSION.permissions.includes(permission),
  );
  vi.spyOn(masterConnection, 'getStatus').mockReturnValue({ state: 'connected' } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('to-do forwarding', () => {
  it('forwards every route to the matching Master command with the same facts', async () => {
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue({} as never);
    const app = createApp();

    await request(app).get('/api/todos').expect(200);
    await request(app).post('/api/todos').send({ text: 'Load', expireAfterHours: 24 }).expect(201);
    await request(app)
      .post('/api/todos/T1/mark')
      .send({ status: 'completed', marked: true })
      .expect(200);
    await request(app).delete('/api/todos/T1').expect(200);

    expect(command.mock.calls).toEqual([
      ['todo:list'],
      ['todo:create', { text: 'Load', expireAfterHours: 24 }],
      ['todo:mark', { status: 'completed', marked: true, id: 'T1' }],
      ['todo:delete', 'T1'],
    ]);
  });

  it('a mark cannot name another task than the one in the path', async () => {
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue({} as never);
    await request(createApp())
      .post('/api/todos/T1/mark')
      .send({ id: 'T2', status: 'in_progress', marked: true })
      .expect(200);
    expect(command).toHaveBeenCalledWith('todo:mark', { id: 'T1', status: 'in_progress', marked: true });
  });
});
