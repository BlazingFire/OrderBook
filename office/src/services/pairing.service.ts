/**
 * The two ways an Office Panel joins a Master.
 *
 * Auto: broadcast, find a Master that is accepting, pair with it.
 * Manual: the operator types the address and pairing password from the
 * Master's setup screen — used when broadcast traffic is blocked.
 *
 * Both end by storing the same credentials, so everything downstream is
 * identical regardless of how the panel was paired.
 */

import { PAIRING_ENDPOINT, type PairingRequest, type PairingSuccess } from '@orderbook/shared';

import { config } from '../config/index.js';
import { timeoutSignal } from '../lib/legacy-globals.js';
import { createLogger } from '../lib/logger.js';
import { discoverMasters, type DiscoveredMaster } from '../discovery/client.js';
import { saveCredentials, type StoredCredentials } from './credentials.store.js';

const log = createLogger('pairing');

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function pairAutomatically(panelName?: string): Promise<StoredCredentials> {
  const masters = await discoverMasters({ requireAcceptingPairing: true });

  if (masters.length === 0) {
    throw new PairingError(
      'No Master Panel answered. Check that the Master Panel PC is on and connected to the same WiFi or LAN.',
      'no_master_found',
    );
  }

  const accepting = masters.filter((master) => master.acceptingPairing);

  if (accepting.length === 0) {
    throw new PairingError(
      'Found the Master Panel, but it is not accepting new panels. Open "Add Office Panel" on the Master and try again.',
      'not_accepting',
    );
  }

  if (accepting.length > 1) {
    throw new PairingError(
      'More than one Master Panel answered. Use Manual Connection to choose which one to join.',
      'multiple_masters',
    );
  }

  const master = accepting[0] as DiscoveredMaster;
  return requestPairing(master.lanIp, master.httpPort, {
    mode: 'auto',
    panelName: panelName ?? config.panelName,
    hostname: config.hostname,
    nonce: master.nonce,
  });
}

export async function pairManually(input: {
  host: string;
  port: number;
  pairingPassword: string;
  masterUniqueId?: string;
  panelName?: string;
}): Promise<StoredCredentials> {
  return requestPairing(input.host, input.port, {
    mode: 'manual',
    panelName: input.panelName ?? config.panelName,
    hostname: config.hostname,
    pairingPassword: input.pairingPassword,
    masterUniqueId: input.masterUniqueId,
  });
}

/** Scans the network without pairing, so the UI can show what it found. */
export async function scanForMasters(): Promise<DiscoveredMaster[]> {
  return discoverMasters({ timeoutMs: 4000 });
}

async function requestPairing(
  host: string,
  port: number,
  request: PairingRequest,
): Promise<StoredCredentials> {
  const url = `http://${host}:${port}${PAIRING_ENDPOINT}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: timeoutSignal(10_000),
    });
  } catch (error) {
    log.warn(`Could not reach ${url}`, error);
    throw new PairingError(
      `Could not reach the Master Panel at ${host}:${port}. Check the address and that both PCs are on the same network.`,
      'unreachable',
    );
  }

  const body = (await response.json().catch(() => null)) as (PairingSuccess & { message?: string }) | null;

  if (!response.ok || !body || !('panelId' in body)) {
    throw new PairingError(body?.message ?? 'The Master Panel refused this pairing request.', 'refused');
  }

  const credentials: StoredCredentials = {
    panelId: body.panelId,
    panelSecret: body.panelSecret,
    masterUniqueId: body.masterUniqueId,
    masterHost: host,
    masterPort: port,
    companyName: body.companyName,
    pairedAt: new Date().toISOString(),
  };

  await saveCredentials(credentials);
  return credentials;
}
