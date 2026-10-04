/**
 * The two ways an Office Panel joins a Master.
 *
 * Auto: broadcast, find a Master that is accepting, pair with it.
 * Manual: the operator types the address and pairing password from the
 * Master's setup screen — used when broadcast traffic is blocked.
 *
 * Both end by storing the same credentials, so everything downstream is
 * identical regardless of how the panel was paired.
 *
 * **Every way this can fail has a code and a message key.** The screen shows the
 * key in the person's own language, and the English sentence beside it is only for
 * the log and for a client that has no key. A refusal is never the Master's own
 * English text passed through: the Master's refusals are recognised (by their
 * message key or status) and turned into ours.
 */

import {
  ADDRESS_MESSAGE_PARAMS,
  PAIRING_ENDPOINT,
  parseMasterAddress,
  standing,
  t as translate,
  type MessageKey,
  type MessageParams,
  type PairingRequest,
  type PairingSuccess,
  type VersionStanding,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { appVersion } from '../lib/app-version.js';
import { createLogger } from '../lib/logger.js';
import { hasNetworkLink } from '../lib/network.js';
import { discoverMasters, type DiscoveredMaster } from '../discovery/client.js';
import { saveCredentials, type StoredCredentials } from './credentials.store.js';
import { masterProves } from '../realtime/master-connection.js';
import { previousPanel } from './master-binding.js';

const log = createLogger('pairing');

/** How long one pairing request may take. A Master hashes the secret, so not instant. */
const PAIRING_TIMEOUT_MS = 10_000;
/** How long the "Test connection" request may take: it only reads a small public page. */
const TEST_TIMEOUT_MS = 5_000;

export type PairingErrorCode =
  | 'no_master_found'
  | 'not_accepting'
  | 'auto_pairing_off'
  | 'multiple_masters'
  | 'network_unavailable'
  | 'cancelled'
  | 'invalid_address'
  | 'invalid_port'
  | 'timeout'
  | 'unreachable'
  | 'connection_refused'
  | 'host_not_found'
  | 'not_a_master'
  | 'wrong_password'
  | 'rate_limited'
  | 'different_master'
  | 'setup_incomplete'
  | 'refused';

/** A Master that answered a search, as the screen needs to name it. */
export interface FoundMaster {
  masterUniqueId: string;
  companyName: string | null;
  address: string;
  acceptingPairing: boolean;
}

export class PairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    readonly messageKey: MessageKey,
    readonly params: MessageParams = {},
    /** Who did answer, when the search found somebody but pairing could not go on. */
    readonly found: FoundMaster[] = [],
  ) {
    super(translate('en', messageKey, params as never));
    this.name = 'PairingError';
  }
}

/** `Could not reach` style failures: another address of the same Master may still work. */
const TRY_NEXT: ReadonlySet<PairingErrorCode> = new Set([
  'timeout',
  'unreachable',
  'connection_refused',
  'host_not_found',
]);

const NETWORK_ERROR_CODES: Record<string, PairingErrorCode> = {
  ECONNREFUSED: 'connection_refused',
  ENOTFOUND: 'host_not_found',
  EAI_AGAIN: 'host_not_found',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ENETDOWN: 'unreachable',
  ECONNRESET: 'unreachable',
  ETIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
};

/**
 * What a failed `fetch` means, in the words a person can act on. `timedOut` is the
 * caller's own timer, which surfaces as a bare abort that looks like any other.
 */
export function classifyFetchFailure(
  error: unknown,
  host: string,
  port: number,
  timedOut: boolean,
  seconds: number,
): PairingError {
  const address = `${host}:${port}`;
  if (timedOut)
    return new PairingError('timeout', 'connection.error.timeout', { address, seconds });

  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: string } | null)?.code ?? '';
  const mapped = NETWORK_ERROR_CODES[code];
  if (mapped === 'connection_refused') {
    return new PairingError('connection_refused', 'connection.error.connectionRefused', {
      address,
      port,
    });
  }
  if (mapped === 'host_not_found') {
    return new PairingError('host_not_found', 'connection.error.hostNotFound', { host });
  }
  if (mapped === 'timeout')
    return new PairingError('timeout', 'connection.error.timeout', { address, seconds });
  return new PairingError('unreachable', 'connection.error.unreachable', { address });
}

/**
 * The Master said no. Recognised by its stable message key, not by its wording
 * (the wording is the Master's English); anything unrecognised is a plain refusal.
 */
export function describeRefusal(
  status: number,
  body: unknown,
  retryAfter?: string | null,
): PairingError {
  const detail = (body ?? {}) as {
    error?: string;
    messageKey?: string;
    params?: { seconds?: number | string };
    details?: { seconds?: number | string; retryAfterSeconds?: number | string };
  };
  // The wait, from wherever the Master put it: its details, its message params, the Retry-After header.
  const wait =
    Number(detail.details?.retryAfterSeconds) ||
    Number(detail.details?.seconds) ||
    Number(detail.params?.seconds) ||
    Number(retryAfter) ||
    60;
  if (detail.error === 'rate_limited') {
    return new PairingError('rate_limited', 'connection.error.rateLimited', { seconds: wait });
  }

  switch (detail.messageKey) {
    case 'error.unauthorized.incorrectPairingPassword':
      return new PairingError('wrong_password', 'connection.error.wrongPassword');
    case 'error.unauthorized.differentMaster':
      return new PairingError('different_master', 'connection.error.differentMaster');
    case 'error.unauthorized.pairingAutoOff':
      return new PairingError('auto_pairing_off', 'connection.error.autoPairingOff');
    case 'error.unauthorized.pairingNotAccepting':
      return new PairingError('not_accepting', 'connection.error.notAccepting');
    case 'validation.panel.setupIncomplete':
      return new PairingError('setup_incomplete', 'connection.error.setupIncomplete');
    case 'error.rateLimited':
      return new PairingError('rate_limited', 'connection.error.rateLimited', { seconds: wait });
  }
  // The limiter may answer before it has a key to give.
  if (status === 429)
    return new PairingError('rate_limited', 'connection.error.rateLimited', { seconds: wait });
  return new PairingError('refused', 'connection.error.refused');
}

/** One AbortSignal for the caller's Cancel and this request's own timer, and which fired. */
function withTimeout(
  ms: number,
  cancel?: AbortSignal,
): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, ms);
  timer.unref?.();
  const onCancel = (): void => controller.abort();
  if (cancel?.aborted) controller.abort();
  else cancel?.addEventListener('abort', onCancel, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => fired,
    done: () => {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onCancel);
    },
  };
}

export interface PairAutomaticallyOptions {
  /** How long one pairing request may take; only a test changes it. */
  timeoutMs?: number;
  panelName?: string;
  /** When several Masters answer: the one the person chose in the list. */
  masterUniqueId?: string;
  signal?: AbortSignal;
}

export async function pairAutomatically(
  options: PairAutomaticallyOptions = {},
): Promise<StoredCredentials> {
  if (!hasNetworkLink())
    throw new PairingError('network_unavailable', 'connection.error.networkUnavailable');

  const masters = await search({ requireAcceptingPairing: true, signal: options.signal });
  if (options.signal?.aborted) throw new PairingError('cancelled', 'connection.error.cancelled');

  if (masters.length === 0) throw new PairingError('no_master_found', 'connection.error.noMaster');

  const accepting = masters.filter((master) => master.acceptingPairing);
  if (accepting.length === 0) {
    throw new PairingError(
      'not_accepting',
      'connection.error.notAccepting',
      {},
      describeFound(masters),
    );
  }

  const chosen = options.masterUniqueId
    ? accepting.find((master) => master.masterUniqueId === options.masterUniqueId)
    : accepting.length === 1
      ? accepting[0]
      : undefined;

  if (!chosen) {
    // The id the person picked has stopped answering: the same as finding nobody.
    if (options.masterUniqueId)
      throw new PairingError('no_master_found', 'connection.error.noMaster');
    throw new PairingError(
      'multiple_masters',
      'connection.error.multipleMasters',
      {},
      describeFound(masters),
    );
  }

  return requestPairing(
    chosen.addresses.length > 0 ? chosen.addresses : [chosen.lanIp],
    chosen.httpPort,
    {
      mode: 'auto',
      panelName: options.panelName ?? config.panelName,
      hostname: config.hostname,
      nonce: chosen.nonce,
    },
    options.signal,
    options.timeoutMs,
    chosen.masterUniqueId,
  );
}

export async function pairManually(input: {
  host: string;
  port: number | string;
  pairingPassword: string;
  masterUniqueId?: string;
  panelName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<StoredCredentials> {
  const address = readAddress(input.host, input.port);
  return requestPairing(
    [address.host],
    address.port,
    {
      mode: 'manual',
      panelName: input.panelName ?? config.panelName,
      hostname: config.hostname,
      pairingPassword: input.pairingPassword,
      masterUniqueId: input.masterUniqueId,
    },
    input.signal,
    input.timeoutMs,
    input.masterUniqueId,
  );
}

/** Scans the network without pairing, so the UI can show what it found. */
export async function scanForMasters(signal?: AbortSignal): Promise<DiscoveredMaster[]> {
  if (!hasNetworkLink())
    throw new PairingError('network_unavailable', 'connection.error.networkUnavailable');
  return search({ timeoutMs: 4000, signal });
}

/** The two things that can go wrong before any request: no network, or the socket dying. */
async function search(options: Parameters<typeof discoverMasters>[0]): Promise<DiscoveredMaster[]> {
  try {
    return await discoverMasters(options);
  } catch (error) {
    log.warn('The search for Masters failed', error);
    throw new PairingError('network_unavailable', 'connection.error.networkUnavailable');
  }
}

const describeFound = (masters: DiscoveredMaster[]): FoundMaster[] =>
  masters.map((master) => ({
    masterUniqueId: master.masterUniqueId,
    companyName: master.companyName,
    address: `${master.addresses[0] ?? master.lanIp}:${master.httpPort}`,
    acceptingPairing: master.acceptingPairing,
  }));

function readAddress(
  hostInput: string,
  portInput: number | string | undefined,
): { host: string; port: number } {
  const parsed = parseMasterAddress(hostInput, portInput);
  if (parsed.ok) return parsed;
  throw parsed.problem === 'invalid_port'
    ? new PairingError('invalid_port', 'connection.error.invalidPort', ADDRESS_MESSAGE_PARAMS)
    : new PairingError(
        'invalid_address',
        'connection.error.invalidAddress',
        ADDRESS_MESSAGE_PARAMS,
      );
}

export interface ConnectionTestResult {
  host: string;
  port: number;
  /** The Master's own version. */
  version: string;
  /** `starting`: it answers but has not finished starting (a database coming up). */
  status: 'ok' | 'starting';
  /** This PC's version. */
  mine: string;
  /** This PC compared with the Master: `behind` = this PC is older. */
  standing: VersionStanding;
}

/**
 * "Test connection": is there a Master Panel at this address, and is it the same
 * version as this PC? Reads the Master's public health page, which every 1.x Master
 * has, so it also works against an older one. Nothing is sent that pairs.
 */
export async function testConnection(input: {
  host: string;
  port: number | string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ConnectionTestResult> {
  const { host, port } = readAddress(input.host, input.port);
  const url = `http://${host}:${port}/api/health`;
  const limit = input.timeoutMs ?? TEST_TIMEOUT_MS;
  const guard = withTimeout(limit, input.signal);

  let response: Response;
  try {
    response = await fetch(url, { signal: guard.signal });
  } catch (error) {
    if (input.signal?.aborted) throw new PairingError('cancelled', 'connection.error.cancelled');
    log.debug(`Test of ${url} failed`, error);
    throw classifyFetchFailure(error, host, port, guard.timedOut(), limit / 1000);
  } finally {
    guard.done();
  }

  const body = (await response.json().catch(() => null)) as {
    panel?: string;
    version?: unknown;
    status?: string;
  } | null;

  if (!response.ok || body?.panel !== 'master' || typeof body.version !== 'string') {
    throw new PairingError('not_a_master', 'connection.error.notAMaster', {
      address: `${host}:${port}`,
    });
  }

  const mine = appVersion();
  return {
    host,
    port,
    version: body.version,
    status: body.status === 'starting' ? 'starting' : 'ok',
    mine,
    standing: standing(mine, body.version),
  };
}

/**
 * Asks each address in turn: the first that answers decides. An address that did not
 * answer at all (no route, refused, timed out) is skipped for the next; a Master that
 * answered and said no is final, because another address of the same Master would
 * say the same.
 */
async function requestPairing(
  hosts: readonly string[],
  port: number,
  request: PairingRequest,
  cancel?: AbortSignal,
  timeoutMs: number = PAIRING_TIMEOUT_MS,
  targetMasterId?: string,
): Promise<StoredCredentials> {
  let firstFailure: PairingError | null = null;

  for (const host of hosts) {
    try {
      return await requestPairingAt(host, port, request, cancel, timeoutMs, targetMasterId);
    } catch (error) {
      if (!(error instanceof PairingError) || !TRY_NEXT.has(error.code)) throw error;
      firstFailure ??= error;
      log.warn(
        `Pairing at ${host}:${port} failed (${error.code}); trying the next address if there is one`,
      );
    }
  }

  throw (
    firstFailure ??
    new PairingError('unreachable', 'connection.error.unreachable', {
      address: `${hosts[0]}:${port}`,
    })
  );
}

/**
 * What to say about this PC's earlier row, so the same PC coming back gets it (and its
 * history) from the Master instead of a second one. The request travels over plain HTTP
 * to whoever answered, so nothing is sent to a Master this PC has no reason to trust:
 *  - the secret only after that host has **proved** it holds this PC's old secret (the
 *    `/api/panel/prove` challenge: only the Master that issued it can answer); and
 *  - the id only when the Master's own identity (from its announcement, or as the person
 *    entered it) is the one the id belonged to.
 * Anything else sends neither.
 */
async function previousPanelFields(
  host: string,
  port: number,
  targetMasterId: string | undefined,
): Promise<{ previousPanelId?: string; previousPanelSecret?: string }> {
  const previous = await previousPanel().catch(() => null);
  if (!previous) return {};

  if (
    previous.secret &&
    (await masterProves(host, port, { panelId: previous.id, panelSecret: previous.secret }))
  )
    return { previousPanelId: previous.id, previousPanelSecret: previous.secret };

  if (previous.masterUniqueId && targetMasterId === previous.masterUniqueId)
    return { previousPanelId: previous.id };
  return {};
}

async function requestPairingAt(
  host: string,
  port: number,
  request: PairingRequest,
  cancel: AbortSignal | undefined,
  timeoutMs: number,
  targetMasterId: string | undefined,
): Promise<StoredCredentials> {
  const url = `http://${host}:${port}${PAIRING_ENDPOINT}`;
  const guard = withTimeout(timeoutMs, cancel);
  const previousFields = await previousPanelFields(host, port, targetMasterId);

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, ...previousFields }),
      signal: guard.signal,
    });
    text = await response.text();
  } catch (error) {
    if (cancel?.aborted) throw new PairingError('cancelled', 'connection.error.cancelled');
    log.warn(`Could not reach ${url}`, error);
    throw classifyFetchFailure(error, host, port, guard.timedOut(), timeoutMs / 1000);
  } finally {
    guard.done();
  }

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: another web server answered on that port.
  }

  if (!response.ok) {
    // No pairing route, or not JSON: another web server is answering on that port.
    if (body === null || response.status === 404)
      throw new PairingError('not_a_master', 'connection.error.notAMaster', {
        address: `${host}:${port}`,
      });
    throw describeRefusal(response.status, body, response.headers.get('retry-after'));
  }

  const success = body as Partial<PairingSuccess> | null;
  if (!success || typeof success.panelId !== 'string' || typeof success.panelSecret !== 'string') {
    throw new PairingError('not_a_master', 'connection.error.notAMaster', {
      address: `${host}:${port}`,
    });
  }

  const credentials: StoredCredentials = {
    panelId: success.panelId,
    panelSecret: success.panelSecret,
    masterUniqueId: String(success.masterUniqueId ?? ''),
    masterHost: host,
    masterPort: port,
    companyName: success.companyName ?? null,
    pairedAt: new Date().toISOString(),
  };

  await saveCredentials(credentials);
  return credentials;
}
