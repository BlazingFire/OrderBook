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
import { primaryLanAddress } from '../lib/network.js';
import { isAcceptingPairing } from '../services/panel.service.js';
import { getIdentity } from '../services/setup.service.js';

const log = createLogger('discovery');

export interface DiscoveryResponder {
  stop(): Promise<void>;
}

export async function startDiscoveryResponder(): Promise<DiscoveryResponder> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (buffer, remote) => {
    void handleMessage(socket, buffer, remote);
  });

  socket.on('error', (error) => {
    log.error('Discovery socket error', error);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(DISCOVERY_PORT, () => {
      socket.setBroadcast(true);
      socket.off('error', reject);
      resolve();
    });
  });

  log.info(`Listening for office panels on UDP ${DISCOVERY_PORT}`);

  return {
    stop: () =>
      new Promise<void>((resolve) => {
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
    lanIp: primaryLanAddress() ?? '127.0.0.1',
    httpPort: config.http.port,
    acceptingPairing: isAcceptingPairing(),
  });

  socket.send(encodeDiscoveryMessage(reply), remote.port, remote.address, (error) => {
    if (error) log.warn(`Failed to reply to ${remote.address}`, error);
    else log.debug(`Replied to discovery from ${message.hostname} (${remote.address})`);
  });
}
