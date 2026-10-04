/**
 * Broadcast address arithmetic decides where discovery packets are sent, so a
 * mistake here means the panels never find each other on some networks.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

// node:os is a frozen ESM namespace, so it is replaced wholesale rather than
// spied on. `networkInterfacesResult` is what the mock returns for each test.
let networkInterfacesResult: Record<string, unknown[]> = {};

vi.mock('node:os', () => ({
  networkInterfaces: () => networkInterfacesResult,
  hostname: () => 'test-host',
}));

const { addressForPeer, hasNetworkLink, isLoopbackAddress, listLanInterfaces, primaryLanAddress } = await import(
  '../src/lib/network.js'
);

function iface(name: string, address: string, netmask: string, internal = false) {
  return {
    name,
    entry: { address, netmask, family: 'IPv4' as const, internal, mac: '00:00:00:00:00:00', cidr: null },
  };
}

function mockInterfaces(entries: ReturnType<typeof iface>[]) {
  const grouped: Record<string, unknown[]> = {};
  for (const { name, entry } of entries) {
    grouped[name] = [...(grouped[name] ?? []), entry];
  }
  networkInterfacesResult = grouped;
}

afterEach(() => {
  networkInterfacesResult = {};
});

describe('listLanInterfaces', () => {
  it('computes the subnet broadcast address for a /24', () => {
    mockInterfaces([iface('eth0', '192.168.1.10', '255.255.255.0')]);

    expect(listLanInterfaces()[0]).toMatchObject({
      address: '192.168.1.10',
      broadcastAddress: '192.168.1.255',
    });
  });

  it('computes the broadcast address for a /16', () => {
    mockInterfaces([iface('eth0', '172.16.4.9', '255.255.0.0')]);

    expect(listLanInterfaces()[0]?.broadcastAddress).toBe('172.16.255.255');
  });

  it('computes the broadcast address for a non-byte-aligned /26', () => {
    mockInterfaces([iface('eth0', '10.0.0.70', '255.255.255.192')]);

    // 10.0.0.70 in a /26 sits in the 10.0.0.64–10.0.0.127 block.
    expect(listLanInterfaces()[0]?.broadcastAddress).toBe('10.0.0.127');
  });

  it('skips loopback', () => {
    mockInterfaces([
      iface('lo', '127.0.0.1', '255.0.0.0', true),
      iface('eth0', '192.168.1.10', '255.255.255.0'),
    ]);

    const found = listLanInterfaces();
    expect(found).toHaveLength(1);
    expect(found[0]?.address).toBe('192.168.1.10');
  });

  it('ranks a real LAN adapter ahead of Docker and VPN adapters', () => {
    // Virtual adapters commonly sort first alphabetically; if one were chosen
    // as the primary address, Office Panels would be told to connect to an
    // address the router cannot reach.
    mockInterfaces([
      iface('docker0', '172.17.0.1', '255.255.0.0'),
      iface('br-abc123', '172.18.0.1', '255.255.0.0'),
      iface('eth0', '192.168.1.10', '255.255.255.0'),
    ]);

    expect(primaryLanAddress()).toBe('192.168.1.10');
  });

  it('falls back to the only adapter present even if it looks virtual', () => {
    mockInterfaces([iface('docker0', '172.17.0.1', '255.255.0.0')]);

    expect(primaryLanAddress()).toBe('172.17.0.1');
  });
});

describe('hasNetworkLink', () => {
  it('is false when only loopback exists', () => {
    mockInterfaces([iface('lo', '127.0.0.1', '255.0.0.0', true)]);
    expect(hasNetworkLink()).toBe(false);
  });

  it('is true once a real adapter is present', () => {
    mockInterfaces([iface('wlan0', '192.168.0.5', '255.255.255.0')]);
    expect(hasNetworkLink()).toBe(true);
  });

  it('reports no link rather than throwing when there are no interfaces at all', () => {
    mockInterfaces([]);
    expect(hasNetworkLink()).toBe(false);
    expect(primaryLanAddress()).toBeNull();
  });
});

describe('isLoopbackAddress', () => {
  // Health paths now, and the Master-PC-only routes after it, hang off this:
  // a LAN address read as local would hand the shop's file paths and setup
  // routes to anyone on the network.
  it('accepts the three ways a local caller arrives', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('refuses a LAN address, a lookalike and a missing address', () => {
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1.evil')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe('which address the Master advertises (Connection audit M6)', () => {
  it('ranks a physical adapter above Hyper-V, WSL, VPN and mesh adapters, and a link-local address last', () => {
    mockInterfaces([
      iface('vEthernet (Default Switch)', '172.20.16.1', '255.255.240.0'),
      iface('vEthernet (WSL)', '192.168.50.1', '255.255.255.0'),
      iface('Tailscale', '100.64.0.7', '255.255.255.255'),
      iface('Ethernet 2', '169.254.10.20', '255.255.0.0'),
      iface('Wi-Fi', '10.0.0.15', '255.255.255.0'),
    ]);
    expect(listLanInterfaces().map((entry) => entry.name)[0]).toBe('Wi-Fi');
    expect(listLanInterfaces().at(-1)!.name).toBe('Ethernet 2');
    expect(primaryLanAddress()).toBe('10.0.0.15');
  });

  it('answers each asker with the address on the subnet that asker is on', () => {
    mockInterfaces([
      iface('Ethernet', '192.168.1.10', '255.255.255.0'),
      iface('Ethernet 3', '10.20.0.5', '255.255.0.0'),
    ]);
    expect(addressForPeer('192.168.1.77')).toBe('192.168.1.10');
    expect(addressForPeer('10.20.4.9')).toBe('10.20.0.5');
    expect(addressForPeer('::ffff:10.20.4.9')).toBe('10.20.0.5');
  });

  it('prefers the narrower subnet when two interfaces both contain the asker', () => {
    mockInterfaces([
      iface('Ethernet', '10.0.0.5', '255.0.0.0'),
      iface('Ethernet 2', '10.1.2.3', '255.255.255.0'),
    ]);
    expect(addressForPeer('10.1.2.99')).toBe('10.1.2.3');
  });

  it('falls back to the best-ranked address for a routed or unparsable asker, and to null with no interface', () => {
    mockInterfaces([iface('Ethernet', '192.168.1.10', '255.255.255.0')]);
    expect(addressForPeer('172.16.9.9')).toBe('192.168.1.10');
    expect(addressForPeer('fe80::1')).toBe('192.168.1.10');
    expect(addressForPeer(undefined)).toBe('192.168.1.10');
    mockInterfaces([]);
    expect(addressForPeer('192.168.1.77')).toBeNull();
  });
});
