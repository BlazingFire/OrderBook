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

/**
 * How long to keep listening after the first qualifying reply, before
 * deciding the search is done.
 *
 * Resolving on the very first HELLO meant a second reply — a genuine second
 * Master, or a rogue device on the LAN answering every DISCOVER with a forged
 * one — could never even be read: the socket was already closed by the time
 * it arrived. `pairAutomatically`'s own "more than one Master answered, use
 * Manual Connection" refusal existed to catch exactly that case and could
 * only ever fire if two replies happened to already be queued in the same
 * tick. A short window after the first reply gives a second responder on the
 * same LAN a real chance to be heard before this panel commits to pairing
 * with whichever one spoke first.
 */
const SETTLE_MS = 500;

export interface DiscoveredMaster {
  masterUniqueId: string;
  companyName: string | null;
  lanIp: string;
  httpPort: number;
  acceptingPairing: boolean;
  /** Echoed back to the Master during pairing to tie the request to this search. */
  nonce: string;
  /**
   * True when a second reply for the same `masterUniqueId` came from a
   * different address. The id is announced in the clear, so anything on the
   * LAN can repeat it; a panel looking for its Master at a new address must not
   * pick between two claimants.
   */
  conflictingAddress?: boolean;
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
    let settleTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (broadcastTimer) clearInterval(broadcastTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      socket.close(() => resolve([...found.values()]));
    };

    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (broadcastTimer) clearInterval(broadcastTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      socket.close();
      reject(error);
    });

    socket.on('message', (buffer) => {
      const message = decodeDiscoveryMessage(buffer);
      if (!message || message.type !== 'HELLO') return;

      const hello = message as HelloMessage;
      // Ignore replies to some other panel's search happening at the same time.
      if (hello.nonce !== nonce) return;

      // Repeated broadcasts bring repeated replies from the same address, which
      // still update the entry (pairing may have opened since). A reply from a
      // different address only marks the first one as contested.
      const earlier = found.get(hello.masterUniqueId);
      if (earlier && (earlier.lanIp !== hello.lanIp || earlier.httpPort !== hello.httpPort)) {
        earlier.conflictingAddress = true;
        log.warn(
          `Master ${hello.masterUniqueId} answered from ${earlier.lanIp}:${earlier.httpPort} ` +
            `and from ${hello.lanIp}:${hello.httpPort}`,
        );
        return;
      }

      found.set(hello.masterUniqueId, {
        masterUniqueId: hello.masterUniqueId,
        companyName: hello.companyName,
        lanIp: hello.lanIp,
        httpPort: hello.httpPort,
        acceptingPairing: hello.acceptingPairing,
        nonce,
        ...(earlier?.conflictingAddress ? { conflictingAddress: true } : {}),
      });

      log.info(
        `Found Master ${hello.masterUniqueId} at ${hello.lanIp}:${hello.httpPort} ` +
          `(accepting pairing: ${hello.acceptingPairing})`,
      );

      const qualifies = options.requireAcceptingPairing ? hello.acceptingPairing : true;
      // Only the *first* qualifying reply starts the settle window — a second
      // one just adds to `found` before it fires.
      if (qualifies && !settleTimer) settleTimer = setTimeout(finish, SETTLE_MS);
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
