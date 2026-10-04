/**
 * Answers Office Panel discovery broadcasts so nobody has to type an IP.
 *
 * Listens on the shared UDP port and replies unicast to whoever asked. The
 * reply advertises whether the Master is currently accepting new panels, which
 * lets the Office Panel show "found, but not accepting yet" instead of
 * silently failing.
 */

import dgram from 'node:dgram';

import {
  DISCOVERY_PORT,
  createHelloMessage,
  decodeDiscoveryMessage,
  encodeDiscoveryMessage,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { addressForPeer } from '../lib/network.js';
import { toErrorMessage } from '../lib/errors.js';
import { isAutoPairingOpen } from '../services/panel.service.js';
import { getIdentity } from '../services/setup.service.js';

const log = createLogger('discovery');

export interface DiscoveryResponder {
  stop(): Promise<void>;
}

/** Whether panels can find this Master on their own right now, and if not, why. */
export interface DiscoveryStatus {
  listening: boolean;
  port: number;
  /** The socket error that stopped it, in the system's words; null while listening. */
  reason: string | null;
}

let status: DiscoveryStatus = { listening: false, port: DISCOVERY_PORT, reason: null };

export function discoveryStatus(): DiscoveryStatus {
  return status;
}

/** How long to wait before trying the port again after it could not be bound. */
const RETRY_MS = 30_000;

function bindOnce(onLaterError: (error: Error) => void): Promise<dgram.Socket> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (buffer, remote) => {
    void handleMessage(socket, buffer, remote);
  });
  return new Promise<dgram.Socket>((resolve, reject) => {
    socket.once('error', (error) => {
      socket.close();
      reject(error);
    });
    socket.bind(DISCOVERY_PORT, () => {
      socket.setBroadcast(true);
      socket.removeAllListeners('error');
      socket.on('error', onLaterError);
      resolve(socket);
    });
  });
}

/**
 * Starts answering discovery broadcasts. **Never rejects**: the UDP port being taken
 * (another program, a second Master, a Windows-reserved range) used to abort the whole
 * Master's boot, although discovery is only a convenience and pairing by address and
 * password works without it. The Master now starts, says so in `discoveryStatus()`
 * (the Add Office Panel screen shows it), and tries the port again every 30 seconds.
 */
export async function startDiscoveryResponder(): Promise<DiscoveryResponder> {
  let socket: dgram.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const retryLater = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void attempt(), RETRY_MS);
    timer.unref?.();
  };

  // A socket that bound and then failed (the adapter went away, the network changed) is as
  // dead as one that never bound: close it, say so, and bind a fresh one later.
  const onLaterError = (error: Error): void => {
    log.error('Discovery socket error', error);
    status = { listening: false, port: DISCOVERY_PORT, reason: toErrorMessage(error) };
    const dead = socket;
    socket = null;
    try {
      dead?.close();
    } catch {
      // already closed
    }
    retryLater();
  };

  const attempt = async (): Promise<void> => {
    try {
      socket = await bindOnce(onLaterError);
      if (stopped) {
        socket.close();
        socket = null;
        return;
      }
      status = { listening: true, port: DISCOVERY_PORT, reason: null };
      log.info(`Listening for office panels on UDP ${DISCOVERY_PORT}`);
    } catch (error) {
      status = { listening: false, port: DISCOVERY_PORT, reason: toErrorMessage(error) };
      log.warn(
        `Cannot listen on UDP ${DISCOVERY_PORT} (${status.reason}); panels must be paired by address until it is free. Trying again in ${RETRY_MS / 1000} s.`,
      );
      retryLater();
    }
  };
  await attempt();

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        if (timer) clearTimeout(timer);
        status = { listening: false, port: DISCOVERY_PORT, reason: null };
        if (!socket) return resolve();
        socket.close(() => resolve());
      }),
  };
}

async function handleMessage(
  socket: dgram.Socket,
  buffer: Buffer,
  remote: dgram.RemoteInfo,
): Promise<void> {
  const message = decodeDiscoveryMessage(buffer);
  if (!message || message.type !== 'DISCOVER') return;

  const identity = await getIdentity();
  if (!identity) {
    // Setup has not run yet, so there is nothing to pair with. Staying silent
    // is correct: the panel keeps searching instead of pairing with a
    // half-configured Master.
    log.debug(`Ignoring discovery from ${remote.address}: setup not complete`);
    return;
  }

  const reply = createHelloMessage({
    nonce: message.nonce,
    masterUniqueId: identity.masterUniqueId,
    companyName: identity.companyName,
    // The address on the network the asker is on, not one address for everybody.
    lanIp: addressForPeer(remote.address) ?? '127.0.0.1',
    httpPort: config.http.port,
    // The same question `pairPanel` will ask, not just the window — advertising
    // `true` while the setting is off would have a panel select this Master and
    // then be refused, with the Master's own screen waiting for it forever.
    acceptingPairing: await isAutoPairingOpen(identity.tenantId),
  });

  socket.send(encodeDiscoveryMessage(reply), remote.port, remote.address, (error) => {
    if (error) log.warn(`Failed to reply to ${remote.address}`, error);
    else log.debug(`Replied to discovery from ${message.hostname} (${remote.address})`);
  });
}
