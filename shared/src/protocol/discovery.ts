/**
 * UDP discovery protocol used by an Office Panel to find the Master Panel on
 * the local network without anyone typing an IP address.
 *
 * Scope: discovery only. Once an Office Panel knows the Master's address it
 * switches to HTTP for the actual pairing handshake (see `pairing.ts`), so no
 * secret ever travels over a broadcast packet.
 *
 * Flow:
 *   Office  --DISCOVER (broadcast)-->  every host on the subnet
 *   Master  --HELLO (unicast reply)-->  the Office Panel that asked
 */

/** Fixed UDP port both sides agree on. Chosen from the unassigned range. */
export const DISCOVERY_PORT = 45789;

/** Guards against parsing unrelated UDP traffic that lands on our port. */
export const DISCOVERY_MAGIC = 'ORDERBOOK';

/** Bumped only on a breaking change to the packet shape. */
export const DISCOVERY_PROTOCOL_VERSION = 1;

/** How often the Office Panel re-broadcasts while waiting for a Master. */
export const DISCOVERY_BROADCAST_INTERVAL_MS = 1_500;

export interface DiscoverMessage {
  magic: typeof DISCOVERY_MAGIC;
  version: number;
  type: 'DISCOVER';
  /** Random per-attempt value; echoed in HELLO so replies can be matched. */
  nonce: string;
  hostname: string;
}

export interface HelloMessage {
  magic: typeof DISCOVERY_MAGIC;
  version: number;
  type: 'HELLO';
  nonce: string;
  masterUniqueId: string;
  companyName: string | null;
  /** Where the Office Panel should send its HTTP pairing request. */
  lanIp: string;
  httpPort: number;
  /**
   * True only while an operator has the Master's "Add Office Panel" screen
   * open. Auto-pairing is refused otherwise, so a panel cannot silently join
   * without someone at the Master authorizing it.
   */
  acceptingPairing: boolean;
}

/**
 * Proof that the Master at a newly discovered address is the one this panel
 * paired with, asked for before the panel sends its secret there.
 *
 * Both sides derive the same 32-byte proof key: HMAC-SHA256 keyed by the panel
 * secret (its UTF-8 text) over MASTER_PROOF_CONTEXT. The Office sends a random
 * hex nonce to `POST /api/panel/prove`; the Master answers HMAC-SHA256 keyed by
 * the proof key's bytes over `masterProofMessage`, in hex. (The Master stores
 * the key as hex, `office_panels.master_proof_key`, and decodes it before use.)
 * Only a Master that once saw this panel's secret can answer, and the secret
 * itself never crosses the wire.
 */
export const MASTER_PROOF_CONTEXT = 'orderbook/master-proof/v1';

/**
 * What the proof covers: the nonce and the address the request reached. The
 * Office uses the address it contacted, the Master the address the connection
 * arrived at, so a device that relays the nonce to the real Master gets back
 * an answer for the real Master's address, not its own, and is refused.
 */
export function masterProofMessage(nonce: string, host: string, port: number): string {
  return `${nonce}|${host}:${port}`;
}

export interface MasterProofRequest {
  panelId: string;
  /** Random, hex, made fresh for each attempt. */
  nonce: string;
}

export interface MasterProofResponse {
  /** HMAC-SHA256(proofKey, masterProofMessage(...)), hex. */
  proof: string;
}

export type DiscoveryMessage = DiscoverMessage | HelloMessage;

export function createDiscoverMessage(nonce: string, hostname: string): DiscoverMessage {
  return {
    magic: DISCOVERY_MAGIC,
    version: DISCOVERY_PROTOCOL_VERSION,
    type: 'DISCOVER',
    nonce,
    hostname,
  };
}

export function createHelloMessage(
  params: Omit<HelloMessage, 'magic' | 'version' | 'type'>,
): HelloMessage {
  return {
    magic: DISCOVERY_MAGIC,
    version: DISCOVERY_PROTOCOL_VERSION,
    type: 'HELLO',
    ...params,
  };
}

export function encodeDiscoveryMessage(message: DiscoveryMessage): Buffer {
  return Buffer.from(JSON.stringify(message), 'utf8');
}

/**
 * Returns null for anything that isn't a well-formed message of our protocol —
 * stray UDP traffic on this port is expected and must never throw.
 */
export function decodeDiscoveryMessage(buffer: Buffer): DiscoveryMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (candidate.magic !== DISCOVERY_MAGIC) return null;
  if (candidate.version !== DISCOVERY_PROTOCOL_VERSION) return null;
  if (typeof candidate.nonce !== 'string') return null;

  if (candidate.type === 'DISCOVER' && typeof candidate.hostname === 'string') {
    return candidate as unknown as DiscoverMessage;
  }

  if (
    candidate.type === 'HELLO' &&
    typeof candidate.masterUniqueId === 'string' &&
    typeof candidate.lanIp === 'string' &&
    typeof candidate.httpPort === 'number' &&
    typeof candidate.acceptingPairing === 'boolean'
  ) {
    return candidate as unknown as HelloMessage;
  }

  return null;
}
