/**
 * The Office server's connection routes: what the screens are told after a pairing,
 * how a refusal reaches them, and who may leave the Master.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const state = {
  session: null as { userId: string } | null,
  permissions: [] as string[],
  removed: null as unknown,
  pending: 0,
  /** What the link to the Master says: the unpair rule reads it. */
  link: { state: 'unpaired', notRecognised: false },
};

const pairAutomatically = vi.fn();
const pairManually = vi.fn();
const testConnection = vi.fn();
const unpair = vi.fn();
const adoptMaster = vi.fn();

vi.mock('../src/realtime/master-connection.js', () => ({
  masterConnection: {
    on: vi.fn(),
    off: vi.fn(),
    isConnected: () => false,
    send: vi.fn(),
    getStatus: () => ({ ...state.link, hasNetworkLink: true }),
    connect: vi.fn(async () => {
      order.push('connect');
    }),
  },
  MasterCommandError: class extends Error {},
}));

vi.mock('../src/services/pairing.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pairAutomatically: (...args: unknown[]) => pairAutomatically(...args),
  pairManually: (...args: unknown[]) => pairManually(...args),
  testConnection: (...args: unknown[]) => testConnection(...args),
  scanForMasters: vi.fn(async () => []),
}));

vi.mock('../src/services/unpair.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  unpair: (...args: unknown[]) => unpair(...args),
}));

vi.mock('../src/services/master-binding.js', () => ({
  adoptMaster: (...args: unknown[]) => adoptMaster(...args),
  removedNote: async () => state.removed,
  parkedChangeCount: async () => 0,
}));

vi.mock('../src/services/user-session.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentSession: () => state.session,
  can: (permission: string) => state.permissions.includes(permission),
}));

vi.mock('../src/sync/outbox.store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pendingCount: async () => state.pending,
}));

vi.mock('../src/sync/device.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deviceCode: async () => 'AB12',
  refreshAfterPairing: async () => {
    order.push('refresh');
  },
}));

const { PairingError } = await import('../src/services/pairing.service.js');
const { UnpairError } = await import('../src/services/unpair.service.js');
const { createApp } = await import('../src/http/app.js');

const credentials = {
  panelId: 'p',
  panelSecret: 's',
  masterUniqueId: 'm1',
  masterHost: '192.168.1.10',
  masterPort: 4100,
  companyName: 'Shree Ceramics',
  pairedAt: '2026-10-04T10:00:00.000Z',
};

beforeEach(() => {
  order.length = 0;
  state.session = null;
  state.permissions = [];
  state.removed = null;
  state.pending = 0;
  state.link = { state: 'unpaired', notRecognised: false };
  for (const mock of [pairAutomatically, pairManually, testConnection, unpair, adoptMaster])
    mock.mockReset();
  adoptMaster.mockImplementation(async () => {
    order.push('adopt');
    return { newMaster: false, parkedChanges: 0 };
  });
});

describe('GET /api/connection', () => {
  it('says why this PC is not paired, when the Master removed it, and what is waiting to be sent', async () => {
    state.removed = {
      at: '2026-10-04T09:30:00.000Z',
      companyName: 'Shree Ceramics',
      masterUniqueId: 'm1',
      host: '192.168.1.10',
      port: 4100,
    };
    state.pending = 3;

    const response = await request(createApp()).get('/api/connection');

    expect(response.status).toBe(200);
    expect(response.body.removedByMaster).toMatchObject({
      companyName: 'Shree Ceramics',
      host: '192.168.1.10',
    });
    expect(response.body.unsentChanges).toBe(3);
  });
});

describe('pairing answers', () => {
  it('adopts the Master (keeping or dropping the cache) before the link opens, and says what it did', async () => {
    pairAutomatically.mockResolvedValue(credentials);
    adoptMaster.mockImplementation(async () => {
      order.push('adopt');
      return { newMaster: true, parkedChanges: 2 };
    });

    const response = await request(createApp())
      .post('/api/connection/pair/auto')
      .send({ panelName: 'Counter 2', masterUniqueId: 'm1' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      ok: true,
      companyName: 'Shree Ceramics',
      newMaster: true,
      parkedChanges: 2,
    });
    expect(order).toEqual(['adopt', 'refresh', 'connect']);
    // The chosen Master and a stop signal went to the pairing.
    expect(pairAutomatically).toHaveBeenCalledWith({
      panelName: 'Counter 2',
      masterUniqueId: 'm1',
      signal: expect.any(AbortSignal),
    });
  });

  it('a refusal carries its code, its message key and who did answer', async () => {
    pairAutomatically.mockRejectedValue(
      new PairingError('multiple_masters', 'connection.error.multipleMasters', {}, [
        {
          masterUniqueId: 'm1',
          companyName: 'A',
          address: '192.168.1.10:4100',
          acceptingPairing: true,
        },
      ]),
    );

    const response = await request(createApp()).post('/api/connection/pair/auto').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'multiple_masters',
      messageKey: 'connection.error.multipleMasters',
      details: { found: [{ masterUniqueId: 'm1', address: '192.168.1.10:4100' }] },
    });
    expect(order).toEqual([]);
  });

  it('the Master’s rate limit is a 429 with the seconds to wait', async () => {
    pairManually.mockRejectedValue(
      new PairingError('rate_limited', 'connection.error.rateLimited', { seconds: 42 }),
    );

    const response = await request(createApp())
      .post('/api/connection/pair/manual')
      .send({ host: '192.168.1.10', pairingPassword: 'pw' });

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ error: 'rate_limited', params: { seconds: 42 } });
  });

  it('manual pairing wants a password, and hands the address and port to the pairing exactly as typed', async () => {
    const missing = await request(createApp())
      .post('/api/connection/pair/manual')
      .send({ host: '192.168.1.10', pairingPassword: '  ' });
    expect(missing.status).toBe(400);
    expect(missing.body.messageKey).toBe('connection.error.passwordMissing');
    expect(pairManually).not.toHaveBeenCalled();

    pairManually.mockResolvedValue(credentials);
    await request(createApp())
      .post('/api/connection/pair/manual')
      .send({ host: ' 192.168.1.10:4200 ', port: '', pairingPassword: 'pw' });
    // Not guessed into 4100 here: the service reads and checks it.
    expect(pairManually).toHaveBeenCalledWith(
      expect.objectContaining({ host: ' 192.168.1.10:4200 ', port: '' }),
    );
  });

  it('a failure nobody expected is still translated, never a bare English sentence', async () => {
    pairManually.mockRejectedValue(new Error('boom'));

    const response = await request(createApp())
      .post('/api/connection/pair/manual')
      .send({ host: 'x', pairingPassword: 'pw' });

    expect(response.status).toBe(500);
    expect(response.body.messageKey).toBe('connection.error.unexpected');
  });
});

describe('POST /api/connection/test', () => {
  it('passes the typed address on and answers with what it found', async () => {
    testConnection.mockResolvedValue({
      host: '192.168.1.10',
      port: 4100,
      version: '1.4.1',
      status: 'ok',
      mine: '1.4.1',
      standing: 'same',
    });

    const response = await request(createApp())
      .post('/api/connection/test')
      .send({ host: '192.168.1.10', port: '4100' });

    expect(response.body).toMatchObject({ version: '1.4.1', standing: 'same' });
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: '192.168.1.10', port: '4100' }),
    );
  });

  it('answers a failure with its code', async () => {
    testConnection.mockRejectedValue(
      new PairingError('invalid_port', 'connection.error.invalidPort'),
    );
    const response = await request(createApp())
      .post('/api/connection/test')
      .send({ host: '192.168.1.10', port: 'abc' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_port');
  });
});

describe('POST /api/connection/unpair', () => {
  const post = (body: Record<string, unknown> = {}) =>
    request(createApp()).post('/api/connection/unpair').send(body);
  const ok = () => unpair.mockResolvedValue({ ok: true, keptChanges: 0, discardedChanges: 0 });

  it('is open without a sign-in when the Master cannot be reached', async () => {
    ok();
    state.link = { state: 'disconnected', notRecognised: false };

    expect((await post()).status).toBe(200);
    expect(unpair).toHaveBeenCalledWith({ pending: undefined });
  });

  it('is open without a sign-in when the Master does not recognise this PC', async () => {
    ok();
    state.link = { state: 'connected', notRecognised: true };

    expect((await post()).status).toBe(200);
  });

  it('needs a signed-in person who manages panels while connected and recognised', async () => {
    state.link = { state: 'connected', notRecognised: false };

    const anonymous = await post();
    expect(anonymous.status).toBe(403);
    expect(anonymous.body.messageKey).toBe('connection.unpair.signInRequired');
    expect(unpair).not.toHaveBeenCalled();

    state.session = { userId: 'u1' };
    const without = await post();
    expect(without.status).toBe(403);
    expect(without.body.messageKey).toBe('connection.unpair.forbidden');
    expect(unpair).not.toHaveBeenCalled();

    state.permissions = ['panels.manage'];
    ok();
    expect((await post()).status).toBe(200);
  });

  it('needs panels.manage once somebody is signed in, whatever the link says', async () => {
    state.link = { state: 'disconnected', notRecognised: true };
    state.session = { userId: 'u1' };

    expect((await post()).status).toBe(403);
    expect(unpair).not.toHaveBeenCalled();
  });

  it('never discards unsent work without a signed-in person who manages panels', async () => {
    ok();
    // Nobody signed in, Master gone: leaving is open, discarding is not.
    state.link = { state: 'disconnected', notRecognised: true };
    const refused = await post({ pending: 'discard' });
    expect(refused.status).toBe(403);
    expect(refused.body.messageKey).toBe('connection.unpair.discardNeedsSignIn');
    expect(unpair).not.toHaveBeenCalled();

    // Keep is fine.
    expect((await post({ pending: 'keep' })).status).toBe(200);

    state.session = { userId: 'u1' };
    state.permissions = ['panels.manage'];
    expect((await post({ pending: 'discard' })).status).toBe(200);
    expect(unpair).toHaveBeenLastCalledWith({ pending: 'discard' });
  });

  it('refuses with the count while work is unsent, and passes keep or discard through', async () => {
    unpair.mockRejectedValueOnce(new UnpairError('pending_changes', 4));
    const refused = await request(createApp()).post('/api/connection/unpair').send({});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'pending_changes',
      messageKey: 'connection.unpair.pendingBlocked',
      details: { count: 4 },
    });

    unpair.mockResolvedValue({ ok: true, keptChanges: 4, discardedChanges: 0 });
    await request(createApp()).post('/api/connection/unpair').send({ pending: 'keep' });
    expect(unpair).toHaveBeenLastCalledWith({ pending: 'keep' });

    // Anything else is not an answer to the question.
    await request(createApp()).post('/api/connection/unpair').send({ pending: 'yes please' });
    expect(unpair).toHaveBeenLastCalledWith({ pending: undefined });
  });
});
