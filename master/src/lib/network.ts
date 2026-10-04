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

function toInt(address: string): number | null {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

/**
 * The address of this PC that the asker can reach: the one on the interface whose
 * subnet contains the asker's address. A Master on two networks (office LAN and a
 * second adapter) used to answer everybody with its single top-ranked address, so
 * a panel on the other network was told an address it could not reach. Falls back
 * to the best-ranked address when no interface shares a subnet (a routed asker,
 * or an address that is not IPv4), and to null when there is no interface at all.
 */
export function addressForPeer(
  peerAddress: string | null | undefined,
  interfaces: readonly LanInterface[] = listLanInterfaces(),
): string | null {
  const peer = peerAddress ? toInt(peerAddress.replace(/^::ffff:/, '')) : null;
  if (peer !== null) {
    // Most specific subnet first, so a /24 inside a /16 wins; ties keep the ranked order.
    let best: { entry: LanInterface; bits: number } | null = null;
    for (const entry of interfaces) {
      const address = toInt(entry.address);
      const mask = toInt(entry.netmask);
      if (address === null || mask === null || mask === 0) continue;
      if (((address & mask) >>> 0) !== ((peer & mask) >>> 0)) continue;
      const bits = mask.toString(2).split('1').length - 1;
      if (!best || bits > best.bits) best = { entry, bits };
    }
    if (best) return best.entry.address;
  }
  return interfaces[0]?.address ?? null;
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

/** The names this PC answers to in a `Host` or `Origin` header. */
const MASTER_PC_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function namesThisPc(value: string | string[] | undefined, isOrigin: boolean): boolean {
  if (typeof value !== 'string') return false;
  try {
    return MASTER_PC_HOSTNAMES.has(new URL(isOrigin ? value : `http://${value}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a request or socket handshake came from a program on the Master PC
 * itself, which is what setup, restore, the master key and a Server Master's
 * session all trust.
 *
 * The address is read off the socket, never `X-Forwarded-For`, since nothing
 * proxies the Master. That alone is not enough: a web page open in a browser
 * on the Master PC also connects from loopback. So the `Host` header must name
 * this PC too, which turns away a page that reached the Master through a
 * hostile name re-pointed at 127.0.0.1, and an `Origin`, when there is one,
 * must as well, which turns away a form posted from another site. The Master's
 * own window is always `http://localhost:<port>`, so it passes both.
 */
export function isOnMasterPc(
  remoteAddress: string | null | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!isLoopbackAddress(remoteAddress) || !namesThisPc(headers.host, false)) return false;
  return headers.origin === undefined || namesThisPc(headers.origin, true);
}

export function isLoopback(req: Request): boolean {
  return isOnMasterPc(req.socket.remoteAddress, req.headers);
}

/**
 * The address to resolve a session against: the caller's own when it is on
 * the Master PC, otherwise null, so a Server Master's session does not count.
 * The session code reads the address for nothing but that check.
 */
export function masterPcAddress(
  remoteAddress: string | null | undefined,
  headers: Record<string, string | string[] | undefined>,
): string | null {
  return isOnMasterPc(remoteAddress, headers) ? (remoteAddress ?? null) : null;
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
/** Adapter names that are a virtual switch, a tunnel or a container bridge, not the shop's network. */
const VIRTUAL_ADAPTER = /docker|veth|br-|vethernet|hyper-v|default switch|wsl|vbox|virtualbox|vmnet|vmware|vpn|tailscale|zerotier|hamachi|tap-|tap |tun|wireguard|npcap|loopback|bluetooth|teredo|isatap/;

function rankInterface(entry: LanInterface): number {
  const name = entry.name.toLowerCase();
  // 169.254.x.x is what Windows gives an adapter that found no DHCP server: nobody can reach it.
  if (entry.address.startsWith('169.254.')) return 200;
  if (VIRTUAL_ADAPTER.test(name)) return 100;
  if (entry.address.startsWith('192.168.')) return 10;
  if (entry.address.startsWith('10.')) return 20;
  if (entry.address.startsWith('172.')) return 30;
  return 50;
}
