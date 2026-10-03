/**
 * The Office end of the Printroom: what this panel's server forwards to the
 * Master, that a send lets the outbox go first, that nothing here is queued, and
 * what it will not show to the wrong person on a PC that several people share.
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

import { createApp } from '../src/http/app.js';
import { MasterCommandError, masterConnection } from '../src/realtime/master-connection.js';
import * as userSession from '../src/services/user-session.service.js';
import * as localStore from '../src/sync/local-store.js';
import * as sync from '../src/sync/sync.service.js';

const SESSION = {
  userId: 'US000000000A',
  username: 'asha',
  displayName: 'Asha',
  roleId: 'RL0000000001',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['print.send', 'print.station'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

const UNREACHABLE = new MasterCommandError('Not connected', undefined, undefined, true);

describe('print forwarding', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(SESSION as never);
    vi.spyOn(userSession, 'can').mockImplementation((permission: string) => SESSION.permissions.includes(permission));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards every Printroom route to the matching Master command with the same facts', async () => {
    vi.spyOn(sync, 'flush').mockResolvedValue({ sent: 0 } as never);
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue([] as never);
    const app = createApp();

    await request(app).get('/api/print-jobs?status=printed&mine=1&cursor=5:abc&limit=10').expect(200);
    await request(app).get('/api/print-jobs').expect(200);
    await request(app).post('/api/print-jobs').send({ requestId: 'a'.repeat(32), kind: 'filling', copies: 2 }).expect(200);
    await request(app).get('/api/print-jobs/J1').expect(200);
    await request(app).post('/api/print-jobs/J1/printed').send({ printed: true, printerName: 'HP' }).expect(200);
    await request(app).post('/api/print-jobs/J1/printed').send({ printed: false }).expect(200);
    await request(app).post('/api/print-jobs/J1/cancel').expect(200);
    await request(app).post('/api/print-jobs/J1/claim').expect(200);
    await request(app).get('/api/print-stations').expect(200);
    await request(app).put('/api/print-stations/self').send({ printerName: 'HP', autoPrint: true }).expect(200);

    expect(command.mock.calls).toEqual([
      ['print:list', { status: 'printed', mine: true, cursor: '5:abc', limit: 10 }],
      ['print:list', { mine: false }],
      ['print:send', { requestId: 'a'.repeat(32), kind: 'filling', copies: 2 }],
      ['print:get', 'J1'],
      ['print:mark', { id: 'J1', printed: true, printerName: 'HP' }],
      ['print:mark', { id: 'J1', printed: false }],
      ['print:cancel', 'J1'],
      ['print:claim', 'J1'],
      ['print:stations'],
      ['print:station', { printerName: 'HP', autoPrint: true }],
    ]);
  });

  it('lets the outbox hand over a just-edited order before the send, and never queues a send itself', async () => {
    const order: string[] = [];
    vi.spyOn(sync, 'flush').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('flush');
      return { sent: 1 } as never;
    });
    const submit = vi.spyOn(sync, 'submit');
    vi.spyOn(masterConnection, 'command').mockImplementation((async () => {
      order.push('send');
      return { id: 'J1' };
    }) as never);

    await request(createApp()).post('/api/print-jobs').send({ requestId: 'b'.repeat(32) }).expect(200);

    expect(order).toEqual(['flush', 'send']);
    expect(submit).not.toHaveBeenCalled();
  });

  it('still sends when the outbox cannot be flushed', async () => {
    vi.spyOn(sync, 'flush').mockRejectedValue(new Error('offline'));
    const command = vi.spyOn(masterConnection, 'command').mockResolvedValue({ id: 'J1' } as never);
    await request(createApp()).post('/api/print-jobs').send({ requestId: 'c'.repeat(32) }).expect(200);
    expect(command).toHaveBeenCalledWith('print:send', { requestId: 'c'.repeat(32) });
  });

  it('answers 503 when the Master is away, for a send and a read alike, and passes a refusal through with its key', async () => {
    vi.spyOn(sync, 'flush').mockResolvedValue({ sent: 0 } as never);
    const command = vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
    const app = createApp();

    for (const response of [await request(app).get('/api/print-jobs'), await request(app).post('/api/print-jobs').send({})]) {
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ error: 'unavailable', messageKey: 'error.unavailable' });
    }

    command.mockRejectedValue(new MasterCommandError('Missing permission: print.station', 'forbidden', 'print.station', false));
    const refused = await request(app).post('/api/print-jobs/J1/claim');
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({ permission: 'print.station' });

    command.mockRejectedValue(new MasterCommandError('Too old', 'updateNeeded', undefined, false));
    expect((await request(app).get('/api/print-stations')).status).toBe(426);
  });

  describe('the live stream', () => {
    it('sends a print frame only to the person it is for, even after someone else signs in', async () => {
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

        masterConnection.emit('print', { id: 'for-a-1', forUserId: 'US000000000A' });
        await vi.waitFor(() => expect(received).toContain('for-a-1'));

        session.mockReturnValue({ ...SESSION, userId: 'US000000000B' } as never);
        masterConnection.emit('print', { id: 'for-a-2', forUserId: 'US000000000A' });
        masterConnection.emit('print', { id: 'unaddressed' });
        masterConnection.emit('print', { id: 'for-b-1', forUserId: 'US000000000B' });
        await vi.waitFor(() => expect(received).toContain('for-b-1'));

        expect(received).not.toContain('for-a-2');
        expect(received).not.toContain('unaddressed');
        expect(received.match(/event: print/g)).toHaveLength(2);
      } finally {
        stream.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
