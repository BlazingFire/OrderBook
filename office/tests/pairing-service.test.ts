/**
 * Joining a Master: every way it can fail has a code and a message key, the right
 * address is tried, and nothing is guessed.
 *
 * A real HTTP server on loopback stands in for the Master, so the requests that
 * leave the pairing service are the ones that would leave a PC; only discovery
 * (UDP) and the credentials file are replaced.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saved: unknown[] = [];
const discover = vi.fn();
/** The id this PC had before its pairing ended, if any (`master-binding.ts`). */
let previous: string | null = null;
let network = true;

vi.mock('../src/config/index.js', () => ({
  config: {
    panelName: 'Counter 2',
    hostname: 'test-host',
    discovery: { timeoutMs: 1000 },
    dataDir: '.',
    http: { host: '127.0.0.1', port: 4200 },
  },
}));
vi.mock('../src/discovery/client.js', () => ({
  discoverMasters: (...args: unknown[]) => discover(...args),
}));
vi.mock('../src/lib/network.js', () => ({
  hasNetworkLink: () => network,
}));
vi.mock('../src/lib/app-version.js', () => ({ appVersion: () => '1.4.1' }));
vi.mock('../src/services/master-binding.js', () => ({
  previousPanelId: async () => previous,
}));
vi.mock('../src/services/credentials.store.js', () => ({
  saveCredentials: async (credentials: unknown) => {
    saved.push(credentials);
  },
}));

const pairing = await import('../src/services/pairing.service.js');
const { PairingError } = pairing;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
let server: http.Server;
let port: number;
let lastBody: Record<string, unknown> | null;
let handler: Handler;

beforeEach(async () => {
  previous = null;
  saved.length = 0;
  discover.mockReset();
  network = true;
  lastBody = null;
  handler = (_req, res) => {
    res.writeHead(500);
    res.end();
  };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        lastBody = body ? (JSON.parse(body) as Record<string, unknown>) : null;
      } catch {
        lastBody = null;
      }
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const refuse =
  (status: number, body: unknown): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

const accept: Handler = (_req, res) => {
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      panelId: '11111111-1111-4111-8111-111111111111',
      panelSecret: 'secret',
      masterUniqueId: 'master-1',
      companyName: 'Shree Ceramics',
    }),
  );
};

const manual = (extra: Record<string, unknown> = {}) =>
  pairing.pairManually({ host: '127.0.0.1', port, pairingPassword: 'pw', ...extra });

async function failure(promise: Promise<unknown>): Promise<InstanceType<typeof PairingError>> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PairingError);
  return error as InstanceType<typeof PairingError>;
}

describe('manual pairing: what the Master said is recognised, not passed through', () => {
  it('pairs and stores the address it reached', async () => {
    handler = accept;
    const credentials = await manual();

    expect(credentials).toMatchObject({
      masterHost: '127.0.0.1',
      masterPort: port,
      companyName: 'Shree Ceramics',
    });
    expect(saved).toHaveLength(1);
    expect(lastBody).toMatchObject({
      mode: 'manual',
      pairingPassword: 'pw',
      panelName: 'Counter 2',
    });
  });

  it('sends the id this PC had before, so the Master can give the same PC its row back', async () => {
    handler = accept;
    previous = '99999999-9999-4999-8999-999999999999';
    await manual();
    expect(lastBody).toMatchObject({ previousPanelId: '99999999-9999-4999-8999-999999999999' });

    // A PC that was never paired sends none.
    previous = null;
    await manual();
    expect(lastBody).not.toHaveProperty('previousPanelId');
  });

  it('sends it in auto mode too', async () => {
    handler = accept;
    previous = 'old-panel';
    discover.mockResolvedValue([
      {
        masterUniqueId: 'm',
        companyName: 'X',
        lanIp: '127.0.0.1',
        addresses: ['127.0.0.1'],
        httpPort: port,
        acceptingPairing: true,
        nonce: 'n',
      },
    ]);
    await pairing.pairAutomatically();
    expect(lastBody).toMatchObject({ mode: 'auto', previousPanelId: 'old-panel' });
  });

  it('a wrong password is its own code, with a key to translate (not the Master’s English)', async () => {
    handler = refuse(401, {
      error: 'unauthorized',
      message: 'Incorrect pairing password',
      messageKey: 'error.unauthorized.incorrectPairingPassword',
    });
    const error = await failure(manual());

    expect(error.code).toBe('wrong_password');
    expect(error.messageKey).toBe('connection.error.wrongPassword');
    expect(saved).toEqual([]);
  });

  it('the rate limit says how long to wait', async () => {
    handler = refuse(429, {
      error: 'rate_limited',
      message: 'Too many requests. Try again in 45 seconds.',
      messageKey: 'error.rateLimited',
      params: { seconds: 45 },
    });
    const error = await failure(manual());

    expect(error).toMatchObject({
      code: 'rate_limited',
      messageKey: 'connection.error.rateLimited',
      params: { seconds: 45 },
    });
  });

  it('a 429 with no key still reads as the rate limit, not as a refusal', async () => {
    handler = refuse(429, { error: 'x' });
    expect((await failure(manual())).code).toBe('rate_limited');
  });

  it('a different Master than the one meant, and a Master that has not finished its setup', async () => {
    handler = refuse(401, { messageKey: 'error.unauthorized.differentMaster' });
    expect((await failure(manual())).code).toBe('different_master');

    handler = refuse(400, { messageKey: 'validation.panel.setupIncomplete' });
    expect((await failure(manual())).code).toBe('setup_incomplete');
  });

  it('anything else the Master refuses is a plain refusal with a key of ours', async () => {
    handler = refuse(403, { message: 'whatever the Master said' });
    const error = await failure(manual());
    expect(error).toMatchObject({ code: 'refused', messageKey: 'connection.error.refused' });
    expect(error.message).not.toContain('whatever');
  });

  it('another web server on that port is "not a Master", whether it sends HTML or 404', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>router login</html>');
    };
    expect((await failure(manual())).code).toBe('not_a_master');

    handler = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not_found"}');
    };
    expect((await failure(manual())).code).toBe('not_a_master');

    // A 200 that is JSON but is not a pairing answer.
    handler = refuse(200, { hello: 'world' });
    expect((await failure(manual())).code).toBe('not_a_master');
  });

  it('nothing listening is "connection refused", named with its port', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const error = await failure(manual());

    expect(error).toMatchObject({
      code: 'connection_refused',
      messageKey: 'connection.error.connectionRefused',
    });
    expect(error.params).toMatchObject({ port });
    // Re-open so afterEach can close it.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  it('no answer within the time limit is a timeout that says how long it waited', async () => {
    handler = () => {
      // Never answers.
    };
    const error = await failure(manual({ timeoutMs: 300 }));

    expect(error).toMatchObject({ code: 'timeout', messageKey: 'connection.error.timeout' });
    expect(error.params).toMatchObject({ seconds: 0.3 });
  });

  it('a name that does not exist is its own message', async () => {
    const error = await failure(
      pairing.pairManually({
        host: 'no-such-pc.invalid',
        port: 4100,
        pairingPassword: 'pw',
        timeoutMs: 3000,
      }),
    );
    expect(['host_not_found', 'timeout', 'unreachable']).toContain(error.code);
  });

  it('refuses a malformed address or port before any request is made', async () => {
    handler = accept;
    for (const host of ['', 'a b', '999.9.9.9', 'http://']) {
      const error = await failure(
        pairing.pairManually({ host, port: '4100', pairingPassword: 'pw' }),
      );
      expect(error.code, host).toBe('invalid_address');
    }
    for (const bad of ['abc', '0', '70000', '4100x']) {
      const error = await failure(
        pairing.pairManually({ host: '127.0.0.1', port: bad, pairingPassword: 'pw' }),
      );
      expect(error.code, bad).toBe('invalid_port');
    }
    expect(lastBody).toBeNull();
    expect(saved).toEqual([]);
  });

  it('reads "host:port" and a pasted URL instead of building http://http://', async () => {
    handler = accept;
    await pairing.pairManually({
      host: `http://127.0.0.1:${port}/`,
      port: '',
      pairingPassword: 'pw',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ masterHost: '127.0.0.1', masterPort: port });
  });
});

describe('auto pairing: the answer, the address and the refusals', () => {
  const found = (over: Record<string, unknown> = {}) => ({
    masterUniqueId: 'master-1',
    companyName: 'Shree Ceramics',
    lanIp: '127.0.0.1',
    addresses: ['127.0.0.1'],
    httpPort: 0,
    acceptingPairing: true,
    nonce: 'n-1',
    ...over,
  });

  it('pairs with the address the reply came from, not the one the Master claims', async () => {
    handler = accept;
    // The Master advertises an adapter this PC cannot reach (here, a port nothing uses on another loopback address).
    discover.mockResolvedValue([
      found({ httpPort: port, lanIp: '127.0.0.2', addresses: ['127.0.0.1', '127.0.0.2'] }),
    ]);

    const credentials = await pairing.pairAutomatically();

    expect(credentials.masterHost).toBe('127.0.0.1');
    expect(lastBody).toMatchObject({ mode: 'auto', nonce: 'n-1' });
  });

  it('falls back to the advertised address when the one it answered from does not work', async () => {
    handler = accept;
    // 127.0.0.2 is bound to nothing; the server listens on 127.0.0.1 only.
    discover.mockResolvedValue([
      found({ httpPort: port, lanIp: '127.0.0.1', addresses: ['127.0.0.2', '127.0.0.1'] }),
    ]);

    const credentials = await pairing.pairAutomatically();

    expect(credentials.masterHost).toBe('127.0.0.1');
  });

  it('does not try another address after the Master itself said no', async () => {
    let asked = 0;
    handler = (_req, res) => {
      asked += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messageKey: 'error.unauthorized.pairingNotAccepting' }));
    };
    discover.mockResolvedValue([found({ httpPort: port, addresses: ['127.0.0.1', '127.0.0.1'] })]);

    const error = await failure(pairing.pairAutomatically());

    expect(error.code).toBe('not_accepting');
    expect(asked).toBe(1);
  });

  it('has a code and a key for finding nobody, a Master that is not accepting, and two Masters', async () => {
    discover.mockResolvedValue([]);
    expect(await failure(pairing.pairAutomatically())).toMatchObject({
      code: 'no_master_found',
      messageKey: 'connection.error.noMaster',
    });

    discover.mockResolvedValue([found({ acceptingPairing: false })]);
    expect(await failure(pairing.pairAutomatically())).toMatchObject({
      code: 'not_accepting',
      messageKey: 'connection.error.notAccepting',
    });

    discover.mockResolvedValue([found({ masterUniqueId: 'a' }), found({ masterUniqueId: 'b' })]);
    expect(await failure(pairing.pairAutomatically())).toMatchObject({
      code: 'multiple_masters',
      messageKey: 'connection.error.multipleMasters',
    });
  });

  it('pairs with the Master the person chose when several answered', async () => {
    handler = accept;
    discover.mockResolvedValue([
      found({ masterUniqueId: 'a', httpPort: port }),
      found({ masterUniqueId: 'b', httpPort: 1 }),
    ]);

    await pairing.pairAutomatically({ masterUniqueId: 'a' });
    expect(saved).toHaveLength(1);

    // The one chosen has stopped answering: nothing is guessed in its place.
    saved.length = 0;
    discover.mockResolvedValue([found({ masterUniqueId: 'b', httpPort: 1 })]);
    expect((await failure(pairing.pairAutomatically({ masterUniqueId: 'a' }))).code).toBe(
      'no_master_found',
    );
    expect(saved).toEqual([]);
  });

  it('says so when this PC has no network, instead of searching', async () => {
    network = false;
    expect(await failure(pairing.pairAutomatically())).toMatchObject({
      code: 'network_unavailable',
      messageKey: 'connection.error.networkUnavailable',
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it('a search that fails (the network dropped under the socket) is "no network", not "failed unexpectedly"', async () => {
    discover.mockRejectedValue(
      Object.assign(new Error('bind EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }),
    );
    expect((await failure(pairing.pairAutomatically())).code).toBe('network_unavailable');
    expect((await failure(pairing.scanForMasters())).code).toBe('network_unavailable');
  });

  it('stops when told to: the search is given the signal, and the answer is "stopped"', async () => {
    const controller = new AbortController();
    discover.mockImplementation(async (options: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return [];
    });

    const pending = failure(pairing.pairAutomatically({ signal: controller.signal }));
    controller.abort();

    expect(await pending).toMatchObject({
      code: 'cancelled',
      messageKey: 'connection.error.cancelled',
    });
  });
});

describe('test connection', () => {
  const health = (body: unknown): Handler => refuse(200, body);

  it('reports the Master’s version and how it compares with this PC', async () => {
    handler = health({ panel: 'master', status: 'ok', version: '1.4.1' });
    expect(await pairing.testConnection({ host: '127.0.0.1', port })).toMatchObject({
      version: '1.4.1',
      mine: '1.4.1',
      standing: 'same',
      status: 'ok',
    });

    handler = health({ panel: 'master', status: 'ok', version: '1.3.0' });
    expect((await pairing.testConnection({ host: '127.0.0.1', port })).standing).toBe('ahead');

    handler = health({ panel: 'master', status: 'ok', version: '1.5.0' });
    expect((await pairing.testConnection({ host: '127.0.0.1', port })).standing).toBe('behind');
  });

  it('says when the Master is still starting', async () => {
    handler = health({ panel: 'master', status: 'starting', version: '1.4.1' });
    expect((await pairing.testConnection({ host: '127.0.0.1', port })).status).toBe('starting');
  });

  it('recognises that what answered is not a Master (an Office, a router)', async () => {
    handler = health({ panel: 'office', status: 'ok', version: '1.4.1' });
    expect((await failure(pairing.testConnection({ host: '127.0.0.1', port }))).code).toBe(
      'not_a_master',
    );

    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    };
    expect((await failure(pairing.testConnection({ host: '127.0.0.1', port }))).code).toBe(
      'not_a_master',
    );
  });

  it('validates the address, times out, and pairs nothing', async () => {
    expect(
      (await failure(pairing.testConnection({ host: 'not an address', port: '4100' }))).code,
    ).toBe('invalid_address');
    expect((await failure(pairing.testConnection({ host: '127.0.0.1', port: '99999' }))).code).toBe(
      'invalid_port',
    );

    handler = () => {
      // Never answers.
    };
    expect(
      (await failure(pairing.testConnection({ host: '127.0.0.1', port, timeoutMs: 200 }))).code,
    ).toBe('timeout');
    expect(saved).toEqual([]);
  });
});
