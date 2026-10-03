/**
 * The Office end of the Chatroom: what this panel's server forwards to the
 * Master, what it queues, and above all what it will not show to the wrong
 * person on a PC that several people share.
 *
 * Pure: the Master link, the session and the outbox are mocked, so this needs
 * no cluster and cannot silently skip.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import type { Mutation } from '@orderbook/shared';

import { createApp } from '../src/http/app.js';
import { MasterCommandError, masterConnection } from '../src/realtime/master-connection.js';
import * as userSession from '../src/services/user-session.service.js';
import * as localStore from '../src/sync/local-store.js';
import * as outbox from '../src/sync/outbox.store.js';
import * as sync from '../src/sync/sync.service.js';

const SESSION = {
  userId: 'US000000000A',
  username: 'asha',
  displayName: 'Asha',
  roleId: 'RL0000000001',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['chat.use', 'chat.shareRecords'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

const UNREACHABLE = new MasterCommandError('Not connected', undefined, undefined, true);

function queuedPost(overrides: Partial<Mutation> = {}): Mutation {
  return {
    mutationId: 'MU-A-1',
    kind: 'chat.post',
    entity: 'chat_message',
    entityId: 'TMP000000000001',
    hlc: '0',
    deviceCode: 'A3F9K2',
    payload: { roomId: 'room-1', body: 'waiting for the link' },
    fields: ['roomId', 'body'],
    baseFieldHlc: {},
    actorUserId: 'US000000000A',
    createdAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

describe('chat forwarding', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(SESSION as never);
    vi.spyOn(userSession, 'can').mockImplementation((permission: string) => SESSION.permissions.includes(permission));
    vi.spyOn(outbox, 'pending').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the reads and the admin writes to the matching Master command', async () => {
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue([] as never);
    const app = createApp();

    await request(app).get('/api/chat/people').expect(200);
    await request(app).get('/api/chat/rooms?all=1&archived=1').expect(200);
    await request(app).get('/api/chat/rooms/room-1').expect(200);
    await request(app).put('/api/chat/rooms/room-1').send({ name: 'Renamed' }).expect(200);
    await request(app).post('/api/chat/rooms/room-1/members').send({ userId: 'US2', role: 'admin' }).expect(200);
    await request(app).post('/api/chat/rooms/room-1/read').send({ seq: 7 }).expect(200);
    await request(app).post('/api/chat/rooms/room-1/mute').send({ muted: true }).expect(200);
    await request(app).post('/api/chat/direct').send({ userId: 'US2' }).expect(200);
    await request(app).put('/api/chat/messages/CM1').send({ body: 'fixed', mentions: ['US2'] }).expect(200);
    await request(app).delete('/api/chat/messages/CM1').expect(200);
    await request(app).post('/api/chat/messages/CM1/pin').send({ pinned: true }).expect(200);
    await request(app).post('/api/chat/messages/CM1/done').send({ done: true }).expect(200);
    await request(app).get('/api/chat/search?q=pallet&roomId=room-1').expect(200);
    await request(app).get('/api/chat/tasks?scope=created&includeDone=1').expect(200);
    await request(app).post('/api/chat/access-requests').send({ capability: 'chat.tasks' }).expect(200);

    expect(command.mock.calls).toEqual([
      ['chat:people'],
      ['chat:rooms', { all: true, includeArchived: true }],
      ['chat:room', 'room-1'],
      ['chat:roomUpdate', { roomId: 'room-1', input: { name: 'Renamed' } }],
      ['chat:memberSet', { roomId: 'room-1', userId: 'US2', role: 'admin' }],
      ['chat:read', { roomId: 'room-1', seq: 7 }],
      ['chat:mute', { roomId: 'room-1', muted: true }],
      ['chat:direct', { userId: 'US2' }],
      ['chat:edit', { messageId: 'CM1', body: 'fixed', mentions: ['US2'] }],
      ['chat:delete', 'CM1'],
      ['chat:pin', { messageId: 'CM1', pinned: true }],
      ['chat:taskDone', { messageId: 'CM1', done: true }],
      ['chat:search', { q: 'pallet', roomId: 'room-1' }],
      ['chat:tasks', { scope: 'created', includeDone: true }],
      ['chat:requestAccess', { capability: 'chat.tasks' }],
    ]);
  });

  it('answers 503 when the Master is away and passes a forbidden through with the key', async () => {
    const command = vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
    const away = await request(createApp()).get('/api/chat/rooms');
    expect(away.status).toBe(503);
    expect(away.body).toMatchObject({ error: 'unavailable', messageKey: 'error.unavailable' });

    command.mockRejectedValue(
      new MasterCommandError('Missing permission: chat.directMessages', 'forbidden', 'chat.directMessages', false),
    );
    const refused = await request(createApp()).post('/api/chat/direct').send({ userId: 'US2' });
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({ permission: 'chat.directMessages' });
  });

  describe('posting', () => {
    let submitted: Array<Record<string, unknown>>;

    beforeEach(() => {
      submitted = [];
      vi.spyOn(outbox, 'pendingCount').mockResolvedValue(1);
      vi.spyOn(sync, 'submit').mockImplementation(async (payload) => {
        submitted.push(payload as never);
        return { mutationId: 'MU-NEW' } as never;
      });
    });

    it('queues a chat.post with the room in its payload and answers 202 with the mutation id', async () => {
      const response = await request(createApp())
        .post('/api/chat/rooms/room-1/messages')
        .send({ body: '  see you at the gate ', refs: [{ kind: 'order', id: 'OD1' }] });

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ queued: true, mutationId: 'MU-NEW' });
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({
        kind: 'chat.post',
        entity: 'chat_message',
        actorUserId: 'US000000000A',
        payload: { roomId: 'room-1', body: 'see you at the gate', refs: [{ kind: 'order', id: 'OD1' }] },
      });
    });

    it('answers 403 before looking at the body when the person lacks chat.use, and 400 for an over-long one', async () => {
      vi.spyOn(userSession, 'can').mockReturnValue(false);
      const refused = await request(createApp()).post('/api/chat/rooms/room-1/messages').send({ body: '' });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: 'permission_denied', permission: 'chat.use' });

      vi.spyOn(userSession, 'can').mockReturnValue(true);
      const tooLong = await request(createApp())
        .post('/api/chat/rooms/room-1/messages')
        .send({ body: 'x'.repeat(4001) });
      expect(tooLong.status).toBe(400);
      expect(submitted).toHaveLength(0);
    });
  });

  describe('what is shown while the Master is away', () => {
    it('appends this person\'s queued posts for that room only, and never anybody else\'s', async () => {
      vi.spyOn(masterConnection, 'command').mockResolvedValue([] as never);
      vi.spyOn(outbox, 'pending').mockResolvedValue([
        queuedPost(),
        queuedPost({ mutationId: 'MU-OTHER-ROOM', payload: { roomId: 'room-2', body: 'elsewhere' } }),
        queuedPost({ mutationId: 'MU-B', actorUserId: 'US000000000B', payload: { roomId: 'room-1', body: 'not yours' } }),
        { ...queuedPost({ mutationId: 'MU-LEAD' }), kind: 'lead.update', entity: 'lead' } as Mutation,
      ]);

      const response = await request(createApp()).get('/api/chat/rooms/room-1/messages');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        clientId: 'MU-A-1',
        pending: true,
        body: 'waiting for the link',
        author: { id: 'US000000000A', displayName: 'Asha' },
        seq: 0,
      });
    });

    it('does not repeat a post the Master has already applied but the queue has not yet settled', async () => {
      vi.spyOn(masterConnection, 'command').mockResolvedValue([
        { id: 'CM0000000001', clientId: 'MU-A-1', seq: 4, body: 'waiting for the link' },
      ] as never);
      vi.spyOn(outbox, 'pending').mockResolvedValue([queuedPost()]);

      const response = await request(createApp()).get('/api/chat/rooms/room-1/messages');
      expect(response.body.map((message: { id: string }) => message.id)).toEqual(['CM0000000001']);
    });

    it('sends the pending list inside a 503 when there is no link, and not B\'s after A signs out', async () => {
      vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
      vi.spyOn(outbox, 'pending').mockResolvedValue([queuedPost()]);
      const app = createApp();

      const asA = await request(app).get('/api/chat/rooms/room-1/messages');
      expect(asA.status).toBe(503);
      expect(asA.body.details.pending).toHaveLength(1);

      // Shift change: B signs in. A's post is still in the queue, and is not B's to see.
      vi.spyOn(userSession, 'currentSession').mockReturnValue({ ...SESSION, userId: 'US000000000B' } as never);
      const asB = await request(app).get('/api/chat/rooms/room-1/messages');
      expect(asB.status).toBe(503);
      expect(asB.body.details.pending).toEqual([]);
    });

    it('does not page older messages with the pending ones', async () => {
      vi.spyOn(masterConnection, 'command').mockResolvedValue([{ id: 'CM1', seq: 1, clientId: null }] as never);
      vi.spyOn(outbox, 'pending').mockResolvedValue([queuedPost()]);

      const response = await request(createApp()).get('/api/chat/rooms/room-1/messages?before=2');
      expect(response.body.map((message: { id: string }) => message.id)).toEqual(['CM1']);
    });
  });

  describe('records by id', () => {
    it('serves this panel\'s own copy first and asks the Master only when it has none', async () => {
      vi.spyOn(localStore, 'getView').mockResolvedValue({
        leads: [{ id: 'LD1', partyId: 'PT1' }],
        orders: [],
        parties: [],
        partyGrants: undefined,
        permissions: [],
        dashboard: { asOf: '' },
      } as never);
      const command = vi.spyOn(masterConnection, 'command').mockResolvedValue({ id: 'OD9' } as never);
      const app = createApp();

      const local = await request(app).get('/api/leads/LD1').expect(200);
      expect(local.body.id).toBe('LD1');
      expect(command).not.toHaveBeenCalled();

      await request(app).get('/api/orders/OD9').expect(200);
      expect(command).toHaveBeenCalledWith('order:get', 'OD9');
    });
  });

  describe('the live stream', () => {
    it('sends a chat frame only to the person it is for, even after someone else signs in', async () => {
      vi.spyOn(localStore, 'getView').mockResolvedValue(null);
      const session = vi.spyOn(userSession, 'currentSession').mockReturnValue(SESSION as never);

      const server = createApp().listen(0);
      const { port } = server.address() as AddressInfo;
      let received = '';
      const stream = http.get(`http://127.0.0.1:${port}/api/events`, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          received += chunk;
        });
      });

      try {
        await vi.waitFor(() => expect(received).toContain('event: status'));

        masterConnection.emit('chat', { kind: 'room', roomId: 'for-a-1', forUserId: 'US000000000A' });
        await vi.waitFor(() => expect(received).toContain('for-a-1'));

        session.mockReturnValue({ ...SESSION, userId: 'US000000000B' } as never);
        masterConnection.emit('chat', { kind: 'room', roomId: 'for-a-2', forUserId: 'US000000000A' });
        masterConnection.emit('chat', { kind: 'room', roomId: 'unaddressed' });
        masterConnection.emit('chat', { kind: 'room', roomId: 'for-b-1', forUserId: 'US000000000B' });
        await vi.waitFor(() => expect(received).toContain('for-b-1'));

        expect(received).not.toContain('for-a-2');
        expect(received).not.toContain('unaddressed');
        expect(received.match(/event: chat/g)).toHaveLength(2);
      } finally {
        stream.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
