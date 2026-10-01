/**
 * LAN address helpers. Both the discovery responder and the first-run setup
 * screen need to know which addresses this PC is actually reachable at.
 */

import { networkInterfaces } from 'node:os';

import type { Request } from 'express';

export interface LanInterface {
  name: string;
  address: string;
  netmask: string;
  /** Subnet-directed broadcast address, e.g. 192.168.1.255. */
  broadcastAddress: string;
}

/**
 * IPv4 interfaces excluding loopback. Ordered with the most likely LAN
 * interface first so callers that want "the" IP can take the first entry.
 */
export function listLanInterfaces(): LanInterface[] {
  const result: LanInterface[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      result.push({
        name,
        address: address.address,
        netmask: address.netmask,
        broadcastAddress: computeBroadcastAddress(address.address, address.netmask),
      });
    }
  }

  return result.sort((a, b) => rankInterface(a) - rankInterface(b));
}

export function listLanAddresses(): string[] {
  return listLanInterfaces().map((entry) => entry.address);
}

export function primaryLanAddress(): string | null {
  return listLanInterfaces()[0]?.address ?? null;
}

/**
 * Whether a socket's remote address is this PC itself.
 *
 * The three spellings a Node server sees for a local caller: IPv4, IPv6, and
 * IPv4 mapped into IPv6 on a dual-stack socket. Exact matches only, so a
 * missing address (a socket already torn down) is never local.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Whether a request came from a program on the Master PC itself.
 *
 * Read off the socket rather than any header, because `X-Forwarded-For` is
 * whatever the caller chose to write and nothing proxies the Master.
 */
export function isLoopback(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

/** True when this PC has any non-loopback IPv4 address — the "is it on the network" check. */
export function hasNetworkLink(): boolean {
  return listLanInterfaces().length > 0;
}

function computeBroadcastAddress(address: string, netmask: string): string {
  const addressOctets = address.split('.').map(Number);
  const maskOctets = netmask.split('.').map(Number);

  if (addressOctets.length !== 4 || maskOctets.length !== 4) return '255.255.255.255';

  return addressOctets
    .map((octet, index) => (octet & (maskOctets[index] ?? 0)) | (~(maskOctets[index] ?? 0) & 0xff))
    .join('.');
}

/**
 * Prefer real private LAN ranges over virtual adapters (Docker, WSL, VPN),
 * which otherwise shadow the interface the router actually reaches.
 */
function rankInterface(entry: LanInterface): number {
  const name = entry.name.toLowerCase();
  if (name.includes('docker') || name.includes('veth') || name.includes('br-')) return 100;
  if (name.startsWith('vbox') || name.includes('vmnet') || name.includes('vpn')) return 90;
  if (entry.address.startsWith('192.168.')) return 10;
  if (entry.address.startsWith('10.')) return 20;
  if (entry.address.startsWith('172.')) return 30;
  return 50;
}
