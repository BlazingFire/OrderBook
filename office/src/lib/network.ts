/**
 * LAN address helpers for the Office Panel. Broadcast addresses drive
 * discovery; link state drives the connection screen's router indicator.
 */

import { networkInterfaces } from 'node:os';

export interface LanInterface {
  name: string;
  address: string;
  netmask: string;
  broadcastAddress: string;
}

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

  return result;
}

/** True when this PC is on a network at all — the red/green dot on screen one. */
export function hasNetworkLink(): boolean {
  return listLanInterfaces().length > 0;
}

/**
 * Subnet-directed broadcast addresses, plus the global 255.255.255.255.
 * Some drivers and switch configurations drop one form but pass the other, so
 * discovery sends to all of them rather than guessing which will work.
 */
export function broadcastTargets(): string[] {
  const targets = new Set<string>(['255.255.255.255']);
  for (const entry of listLanInterfaces()) targets.add(entry.broadcastAddress);
  return [...targets];
}

function computeBroadcastAddress(address: string, netmask: string): string {
  const addressOctets = address.split('.').map(Number);
  const maskOctets = netmask.split('.').map(Number);

  if (addressOctets.length !== 4 || maskOctets.length !== 4) return '255.255.255.255';

  return addressOctets
    .map((octet, index) => (octet & (maskOctets[index] ?? 0)) | (~(maskOctets[index] ?? 0) & 0xff))
    .join('.');
}
