/**
 * Record identity across the offline boundary (docs/LEAD_GENERATION_FLOW.md §7).
 *
 * An Office Panel with no link to the Master still has to give a lead an id the
 * instant it is saved — staff print it, quote it on the phone, and search for it
 * later. So ids come in two shapes:
 *
 *   temporary  A3F9K2000000123   15 chars = 6-char device code + 9-digit counter
 *   permanent  LD0000000042      12 chars = 2-char entity prefix + 10-digit seq
 *
 * Only the Master mints permanent ids, and it sorts each batch it applies by
 * `(hlc, deviceCode, mutationId)` rather than arrival order. Pushes that reach
 * the Master inside the same gather window are therefore numbered by HLC
 * whichever panel sent first; pushes further apart are numbered in the order
 * they arrive, because a number already handed out is never taken back. The
 * temporary id keeps resolving forever through the `id_map` table, which is why
 * a docket printed while offline is still findable after renumbering.
 *
 * Pure string handling: no randomness, no clock, no I/O. Callers supply the
 * counter, which is what makes id assignment reproducible in tests.
 */

export const DEVICE_CODE_LENGTH = 6;
export const TEMP_ID_LENGTH = 15;
export const PERMANENT_ID_LENGTH = 12;

const TEMP_COUNTER_DIGITS = TEMP_ID_LENGTH - DEVICE_CODE_LENGTH; // 9
const PERMANENT_SEQUENCE_DIGITS = PERMANENT_ID_LENGTH - 2; // 10

/**
 * Device-code alphabet, chosen to survive being read aloud down a phone line and
 * copied off a printed docket: no 0/O, no 1/I/L, no U (which is misread as V).
 */
const DEVICE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Every record type the id scheme above covers: what an Office Panel may create
 * while offline, plus roles and users (see the note below).
 */
export const SYNCABLE_ENTITIES = [
  'lead',
  'order',
  'line_item',
  'party',
  'product',
  'product_category',
  'product_variant',
  'party_variant',
  'timeline_entry',
  'reservation',
  // Roles and users are here so their ids take this shape and the schema can
  // take one minted offline — an admin taking someone on during an outage
  // should not have to wait for the network. That half is not built: there is
  // no `role.*` or `user.*` member of `MutationKind` (mutations.ts), so both are
  // created only through the Master's own API (docs/ROLES_AND_USERS.md §15.5).
  'role',
  'user',
  // A chat message, posted through the outbox so it survives a lost link.
  'chat_message',
] as const;

export type SyncableEntity = (typeof SYNCABLE_ENTITIES)[number];

export function isSyncableEntity(value: unknown): value is SyncableEntity {
  return (SYNCABLE_ENTITIES as readonly unknown[]).includes(value);
}

/**
 * Two-character prefix per entity. Its job is to make an id self-describing in a
 * log line or a support call — "LD0000000042" says lead without a lookup.
 */
export const ENTITY_PREFIX: Record<SyncableEntity, string> = {
  lead: 'LD',
  order: 'OD',
  line_item: 'LI',
  party: 'PT',
  product: 'PR',
  product_category: 'PC',
  // `PV` was taken by party variants first; `VR` keeps the two distinct.
  product_variant: 'VR',
  party_variant: 'PV',
  timeline_entry: 'TL',
  reservation: 'RS',
  role: 'RL',
  user: 'US',
  // Posted offline through the outbox like any other write, hence the id scheme.
  chat_message: 'CM',
};

const PREFIX_TO_ENTITY: Record<string, SyncableEntity> = Object.fromEntries(
  Object.entries(ENTITY_PREFIX).map(([entity, prefix]) => [prefix, entity as SyncableEntity]),
) as Record<string, SyncableEntity>;

export function isValidDeviceCode(value: string): boolean {
  return (
    value.length === DEVICE_CODE_LENGTH &&
    [...value].every((char) => DEVICE_ALPHABET.includes(char))
  );
}

/**
 * Derive a device code from arbitrary bytes (a UUID, a MAC address, random
 * bytes). Taking it from a value the panel already has keeps the code stable
 * across restarts without another file to lose.
 */
export function deviceCodeFromSeed(seed: string): string {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  const chars: string[] = [];

  for (let i = 0; i < DEVICE_CODE_LENGTH; i += 1) {
    for (const char of `${seed}#${i}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // The modulo keeps this in range; the fallback exists only to satisfy
    // noUncheckedIndexedAccess without an assertion.
    chars.push(DEVICE_ALPHABET[hash % DEVICE_ALPHABET.length] ?? '2');
  }

  return chars.join('');
}

export function formatTemporaryId(deviceCode: string, counter: number): string {
  if (!isValidDeviceCode(deviceCode)) {
    throw new Error(`Invalid device code: "${deviceCode}"`);
  }
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`Temporary id counter must be a non-negative integer, got ${counter}`);
  }

  const encoded = String(counter).padStart(TEMP_COUNTER_DIGITS, '0');
  if (encoded.length > TEMP_COUNTER_DIGITS) {
    // A billion offline records on one panel before it ever syncs. Failing here
    // beats emitting a 16-char id that no longer round-trips.
    throw new Error(`Temporary id counter overflow: ${counter}`);
  }

  return `${deviceCode}${encoded}`;
}

export function formatPermanentId(entity: SyncableEntity, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`Permanent id sequence must be a non-negative integer, got ${sequence}`);
  }

  const encoded = String(sequence).padStart(PERMANENT_SEQUENCE_DIGITS, '0');
  if (encoded.length > PERMANENT_SEQUENCE_DIGITS) {
    throw new Error(`Permanent id sequence overflow for ${entity}: ${sequence}`);
  }

  return `${ENTITY_PREFIX[entity]}${encoded}`;
}

export function isTemporaryId(value: string): boolean {
  return (
    value.length === TEMP_ID_LENGTH &&
    isValidDeviceCode(value.slice(0, DEVICE_CODE_LENGTH)) &&
    /^\d+$/.test(value.slice(DEVICE_CODE_LENGTH))
  );
}

export function isPermanentId(value: string): boolean {
  return (
    value.length === PERMANENT_ID_LENGTH &&
    value.slice(0, 2) in PREFIX_TO_ENTITY &&
    /^\d+$/.test(value.slice(2))
  );
}

/**
 * Ordering for permanent-id assignment: HLC first (its physical time, then its
 * counter), the device code to break an exact tie, and the mutation id last so
 * the order is total even for two mutations a panel stamped with the same HLC.
 *
 * This orders one batch. It does not make numbering independent of which panel
 * reconnected first: the Master can only sort the pushes it holds at once (the
 * push gate's gather window), and ids minted for an earlier batch stay minted.
 */
export function compareForIdAssignment(
  a: { hlc: string; deviceCode: string; mutationId?: string },
  b: { hlc: string; deviceCode: string; mutationId?: string },
): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.deviceCode !== b.deviceCode) return a.deviceCode < b.deviceCode ? -1 : 1;
  const am = a.mutationId ?? '';
  const bm = b.mutationId ?? '';
  if (am !== bm) return am < bm ? -1 : 1;
  return 0;
}
