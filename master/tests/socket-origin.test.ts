/**
 * Which pages may open a socket to the Master.
 *
 * The hub used to be built with `cors: { origin: true, credentials: true }`,
 * which reflects whatever `Origin` asks with credentials allowed — so any page
 * a person on the shop LAN had open could open a socket to the Master and
 * present whatever it held. CORS was never the control that mattered, either:
 * both real clients connect with `transports: ['websocket']`, and a browser
 * applies no CORS at all to a WebSocket. What is pinned here is the handshake
 * check that replaced it, against both transports, together with the callers
 * it must not break: the Master's own browser UI (same origin), the Electron
 * shell (`http://localhost:<port>`), the Master UI opened from another PC by
 * the Master's LAN address, the Vite dev proxy, and an Office Panel's server
 * (Node, no `Origin`).
 *
 * No database: the handshake is refused or admitted before the hub's own
 * authentication middleware runs, and nothing here gets that far.
 */

import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import { isAllowedSocketOrigin } from '../src/realtime/socket-origin.js';

let server: HttpServer;
let hub: RealtimeHub;
let port: number;

/** The first request of the long-polling transport: an engine.io open. */
function pollingHandshake(origin?: string): request.Test {
  const test = request(server).get('/socket.io/?EIO=4&transport=polling');
  return origin === undefined ? test : test.set('Origin', origin);
}

/**
 * A bare WebSocket upgrade, the way both real clients connect.
 *
 * Raw `node:http` rather than a Socket.IO client, so the only thing that can
 * decide the answer is the handshake check: 101 is admitted, anything else is
 * engine.io refusing the upgrade.
 */
function websocketHandshake(origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/socket.io/?EIO=4&transport=websocket',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin === undefined ? {} : { Origin: origin }),
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the socket handshake origin check', () => {
  beforeAll(async () => {
    server = createServer();
    hub = createRealtimeHub(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  // `io.close()` closes the HTTP server it is attached to as well.
  afterAll(() => hub.stop());

  it('admits a caller that sends no Origin — an Office Panel server connecting from Node', async () => {
    await pollingHandshake().expect(200);
    expect(await websocketHandshake()).toBe(101);
  });

  it('admits a page served by the Master itself, whatever address it was opened by', async () => {
    // Supertest and the raw request both reach the server as 127.0.0.1:<port>,
    // so that is the Host the page's own origin has to match — the same way
    // `http://localhost:4100` in the shell or `http://192.168.1.10:4100` from
    // another PC matches the Host its browser sends.
    const own = `http://127.0.0.1:${port}`;

    const response = await pollingHandshake(own).expect(200);
    expect(response.text).toContain('"sid"');
    expect(await websocketHandshake(own)).toBe(101);
  });

  it('refuses a page from another site on the polling transport, and does not reflect its origin', async () => {
    const response = await pollingHandshake('http://intranet.example').expect(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses a page from another site on the WebSocket transport, which CORS never covered', async () => {
    expect(await websocketHandshake('http://intranet.example')).not.toBe(101);
  });

  it('refuses another port on the same machine — a different origin, however close', async () => {
    expect(await websocketHandshake(`http://127.0.0.1:${port + 1}`)).not.toBe(101);
    await pollingHandshake(`http://127.0.0.1:${port + 1}`).expect(403);
  });

  it('refuses the opaque "null" origin of a sandboxed frame or a file:// page', async () => {
    expect(await websocketHandshake('null')).not.toBe(101);
    await pollingHandshake('null').expect(403);
  });
});

describe('isAllowedSocketOrigin', () => {
  it('admits no Origin at all, which is how a Node client connects', () => {
    expect(isAllowedSocketOrigin(undefined, '192.168.1.10:4100')).toBe(true);
    expect(isAllowedSocketOrigin(undefined, undefined)).toBe(true);
  });

  it('admits the page the Master served, by whichever address the browser used', () => {
    // The Electron shell.
    expect(isAllowedSocketOrigin('http://localhost:4100', 'localhost:4100')).toBe(true);
    // Another PC on the LAN, by the Master's address.
    expect(isAllowedSocketOrigin('http://192.168.1.10:4100', '192.168.1.10:4100')).toBe(true);
    // By the Master PC's name, as a browser writes it and as somebody types it.
    expect(isAllowedSocketOrigin('http://shop-master:4100', 'Shop-Master:4100')).toBe(true);
    // The Vite dev server: `/socket.io` is proxied with its `Host` untouched.
    expect(isAllowedSocketOrigin('http://localhost:5100', 'localhost:5100')).toBe(true);
    // A default port is absent from both sides.
    expect(isAllowedSocketOrigin('http://192.168.1.10', '192.168.1.10')).toBe(true);
    expect(isAllowedSocketOrigin('http://[fe80::1]:4100', '[fe80::1]:4100')).toBe(true);
  });

  it('refuses a page from anywhere else', () => {
    expect(isAllowedSocketOrigin('http://intranet.example', '192.168.1.10:4100')).toBe(false);
    expect(isAllowedSocketOrigin('http://192.168.1.50:4100', '192.168.1.10:4100')).toBe(false);
    // Same machine, other port: another origin, and another program.
    expect(isAllowedSocketOrigin('http://192.168.1.10:8080', '192.168.1.10:4100')).toBe(false);
    // `localhost` and `127.0.0.1` are the same machine but not the same origin.
    expect(isAllowedSocketOrigin('http://127.0.0.1:4100', 'localhost:4100')).toBe(false);
  });

  it('refuses what is not an http origin at all', () => {
    expect(isAllowedSocketOrigin('null', 'localhost:4100')).toBe(false);
    expect(isAllowedSocketOrigin('', 'localhost:4100')).toBe(false);
    expect(isAllowedSocketOrigin('file:///C:/page.html', 'localhost:4100')).toBe(false);
    expect(isAllowedSocketOrigin('chrome-extension://localhost:4100', 'localhost:4100')).toBe(false);
  });

  it('refuses an Origin when there is no Host to hold it against', () => {
    expect(isAllowedSocketOrigin('http://localhost:4100', undefined)).toBe(false);
    expect(isAllowedSocketOrigin('http://localhost:4100', '')).toBe(false);
  });
});
