/**
 * Finds the Master Panel on the LAN by broadcasting on the shared UDP port and
 * collecting replies.
 *
 * Broadcasts repeat until the timeout rather than firing once, because a panel
 * often starts searching before the Master's operator has opened the "Add
 * Office Panel" screen — repeating means the panel picks up the Master as soon
 * as it starts accepting, without the user pressing anything again.
 */

import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';

import {
  DISCOVERY_BROADCAST_INTERVAL_MS,
  DISCOVERY_PORT,
  createDiscoverMessage,
  decodeDiscoveryMessage,
  encodeDiscoveryMessage,
  type HelloMessage,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { broadcastTargets } from '../lib/network.js';

const log = createLogger('discovery');

export interface DiscoveredMaster {
  masterUniqueId: string;
  companyName: string | null;
  lanIp: string;
  httpPort: number;
  acceptingPairing: boolean;
  /** Echoed back to the Master during pairing to tie the request to this search. */
  nonce: string;
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Stop as soon as a Master that is ready to pair answers. */
  requireAcceptingPairing?: boolean;
}

/**
 * Resolves with every distinct Master that answered. Normally that is exactly
 * one; more than one means two Masters are running on the same network, which
 * the UI surfaces as a choice rather than picking silently.
 */
export async function discoverMasters(options: DiscoverOptions = {}): Promise<DiscoveredMaster[]> {
  const timeoutMs = options.timeoutMs ?? config.discovery.timeoutMs;
  const nonce = randomUUID();
  const found = new Map<string, DiscoveredMaster>();

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  return new Promise<DiscoveredMaster[]>((resolve, reject) => {
    let settled = false;
    let broadcastTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (broadcastTimer) clearInterval(broadcastTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      socket.close(() => resolve([...found.values()]));
    };

    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (broadcastTimer) clearInterval(broadcastTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      socket.close();
      reject(error);
    });

    socket.on('message', (buffer) => {
      const message = decodeDiscoveryMessage(buffer);
      if (!message || message.type !== 'HELLO') return;

      const hello = message as HelloMessage;
      // Ignore replies to some other panel's search happening at the same time.
      if (hello.nonce !== nonce) return;

      found.set(hello.masterUniqueId, {
        masterUniqueId: hello.masterUniqueId,
        companyName: hello.companyName,
        lanIp: hello.lanIp,
        httpPort: hello.httpPort,
        acceptingPairing: hello.acceptingPairing,
        nonce,
      });

      log.info(
        `Found Master ${hello.masterUniqueId} at ${hello.lanIp}:${hello.httpPort} ` +
          `(accepting pairing: ${hello.acceptingPairing})`,
      );

      if (options.requireAcceptingPairing && hello.acceptingPairing) finish();
      else if (!options.requireAcceptingPairing) finish();
    });

    // Port 0: the OS picks a free source port, so several panels can search at
    // once without fighting over a fixed one.
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const payload = encodeDiscoveryMessage(createDiscoverMessage(nonce, config.hostname));

      const sendBroadcast = (): void => {
        for (const target of broadcastTargets()) {
          socket.send(payload, DISCOVERY_PORT, target, (error) => {
            if (error) log.debug(`Broadcast to ${target} failed: ${error.message}`);
          });
        }
      };

      sendBroadcast();
      broadcastTimer = setInterval(sendBroadcast, DISCOVERY_BROADCAST_INTERVAL_MS);
      timeoutTimer = setTimeout(finish, timeoutMs);
    });
  });
}
