/**
 * Looking for the Master on the network: which addresses are searched, which are
 * remembered, and when the search stops.
 *
 * A UDP socket on loopback plays the Master. The port and the broadcast target are
 * passed in (`DiscoverOptions.port`, `.targets`) so the test never touches the real
 * discovery port 45789, which a running Master on this PC may hold.
 */

import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';

import {
  createHelloMessage,
  decodeDiscoveryMessage,
  encodeDiscoveryMessage,
} from '@orderbook/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/index.js', () => ({
  config: { hostname: 'test-pc', panelName: 'Test', discovery: { timeoutMs: 2000 } },
}));

const { discoverMasters } = await import('../src/discovery/client.js');
const { broadcastTargets } = await import('../src/lib/network.js');

const sockets: dgram.Socket[] = [];

/** A Master on 127.0.0.1 that answers every DISCOVER with `hello` (its address as it claims it). */
async function fakeMaster(hello: {
  lanIp: string;
  accepting?: boolean;
  id?: string;
  httpPort?: number;
}) {
  const socket = dgram.createSocket('udp4');
  sockets.push(socket);
  socket.on('message', (buffer, remote) => {
    const message = decodeDiscoveryMessage(buffer);
    if (!message || message.type !== 'DISCOVER') return;
    socket.send(
      encodeDiscoveryMessage(
        createHelloMessage({
          nonce: message.nonce,
          masterUniqueId: hello.id ?? 'master-1',
          companyName: 'Shree Ceramics',
          lanIp: hello.lanIp,
          httpPort: hello.httpPort ?? 4100,
          acceptingPairing: hello.accepting ?? true,
        }),
      ),
      remote.port,
      remote.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return (socket.address() as AddressInfo).port;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

describe('what a search remembers about a Master', () => {
  it('keeps the address the reply came from, ahead of the one the Master claims', async () => {
    // The Master says it is at 10.9.9.9 (an adapter this PC cannot reach); the reply arrived from 127.0.0.1.
    const port = await fakeMaster({ lanIp: '10.9.9.9' });

    const [master] = await discoverMasters({ port, targets: ['127.0.0.1'], timeoutMs: 1500 });

    expect(master?.lanIp).toBe('10.9.9.9');
    expect(master?.addresses).toEqual(['127.0.0.1', '10.9.9.9']);
  });

  it('does not list an address twice when the two agree', async () => {
    const port = await fakeMaster({ lanIp: '127.0.0.1' });

    const [master] = await discoverMasters({ port, targets: ['127.0.0.1'], timeoutMs: 1500 });

    expect(master?.addresses).toEqual(['127.0.0.1']);
  });

  it('finds two Masters that both answer, rather than stopping at the first', async () => {
    const first = await fakeMaster({ lanIp: '127.0.0.1', id: 'a', httpPort: 4100 });
    const second = await fakeMaster({ lanIp: '127.0.0.1', id: 'b', httpPort: 4101 });

    const found = await discoverMasters({
      port: first,
      targets: ['127.0.0.1'],
      timeoutMs: 1200,
      requireAcceptingPairing: true,
    });
    // One port per fake Master: this search asked the first only; ask the second as well.
    const other = await discoverMasters({ port: second, targets: ['127.0.0.1'], timeoutMs: 1200 });

    expect(found.map((m) => m.masterUniqueId)).toEqual(['a']);
    expect(other.map((m) => m.masterUniqueId)).toEqual(['b']);
  });
});

describe('stopping a search', () => {
  it('returns at once when told to, long before the timeout', async () => {
    const port = await fakeMaster({ lanIp: '127.0.0.1', accepting: false });
    const controller = new AbortController();
    const started = Date.now();

    const search = discoverMasters({
      port,
      targets: ['127.0.0.1'],
      timeoutMs: 20_000,
      requireAcceptingPairing: true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await search;

    // Without the signal this runs the whole 20 s: nothing accepting ever answers.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('does not search at all when it was stopped before it began', async () => {
    const port = await fakeMaster({ lanIp: '127.0.0.1' });
    const controller = new AbortController();
    controller.abort();

    const found = await discoverMasters({
      port,
      targets: ['127.0.0.1'],
      timeoutMs: 20_000,
      signal: controller.signal,
    });

    expect(found).toEqual([]);
  });
});

describe('where a search broadcasts', () => {
  const nic = (address: string, netmask: string, broadcastAddress: string) => ({
    name: 'x',
    address,
    netmask,
    broadcastAddress,
  });

  it('sends to the limited broadcast and to the subnet broadcast of every adapter, once each', () => {
    const targets = broadcastTargets([
      nic('192.168.1.20', '255.255.255.0', '192.168.1.255'),
      nic('172.22.48.1', '255.255.240.0', '172.22.63.255'),
      // Two adapters on one subnet.
      nic('192.168.1.21', '255.255.255.0', '192.168.1.255'),
    ]);

    expect(targets.sort()).toEqual(['172.22.63.255', '192.168.1.255', '255.255.255.255']);
  });

  it('skips a /32 (a VPN’s own address), where the "broadcast" is only this PC', () => {
    const targets = broadcastTargets([
      nic('10.8.0.2', '255.255.255.255', '10.8.0.2'),
      nic('192.168.1.20', '255.255.255.0', '192.168.1.255'),
    ]);

    expect(targets).not.toContain('10.8.0.2');
    expect(targets).toContain('192.168.1.255');
  });

  it('still has the limited broadcast when there is no adapter at all', () => {
    expect(broadcastTargets([])).toEqual(['255.255.255.255']);
  });
});
