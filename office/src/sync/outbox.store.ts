/**
 * The durable outbox (docs/LEAD_GENERATION_FLOW.md §2, §4).
 *
 * When staff press Save, the mutation lands here and the local view updates —
 * that is what makes "saves instantly, syncs within seconds" true rather than
 * aspirational. The Master is told later, whenever the link is up.
 *
 * Written as a whole file under a temp-then-rename, not appended to. An append
 * is faster but can leave a torn final record if the PC loses power mid-write,
 * and a torn record in the outbox is a lost sale. Rename is atomic on both NTFS
 * and POSIX filesystems, so the file a reader sees is always a complete one.
 *
 * The queue is small by nature — it drains within seconds of the link
 * returning — so rewriting it costs nothing worth optimising.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { IsoTimestamp, Mutation, MutationKind, MutationResult } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { createLogger } from '../lib/logger.js';
import { stamp } from './clock.js';
import { deviceCode } from './device.js';

const log = createLogger('outbox');

let cached: Mutation[] | null = null;
/** Serialises writes: two concurrent saves must not both rewrite the file. */
let writeChain: Promise<void> = Promise.resolve();

export interface EnqueueRequest {
  kind: MutationKind;
  entity: Mutation['entity'];
  entityId: string;
  payload: Record<string, unknown>;
  fields?: string[];
  baseFieldHlc?: Record<string, string>;
  actorUserId?: string | null;
}

export async function enqueue(request: EnqueueRequest): Promise<Mutation> {
  const mutation: Mutation = {
    // Client-generated, so a batch that is pushed twice is recognised as the
    // same batch rather than applied again.
    mutationId: randomUUID(),
    kind: request.kind,
    entity: request.entity,
    entityId: request.entityId,
    hlc: await stamp(),
    deviceCode: await deviceCode(),
    payload: request.payload,
    fields: request.fields ?? Object.keys(request.payload),
    baseFieldHlc: request.baseFieldHlc ?? {},
    actorUserId: request.actorUserId ?? null,
    createdAt: new Date().toISOString(),
  };

  await mutate((pending) => [...pending, mutation]);
  log.info(`Queued ${mutation.kind} for ${mutation.entityId} (${(await load()).length} pending)`);

  return mutation;
}

export async function pending(): Promise<Mutation[]> {
  return [...(await load())];
}

export async function pendingCount(): Promise<number> {
  return (await load()).length;
}

/** Drop mutations the Master has acknowledged — applied, merged or refused. */
export async function settle(mutationIds: string[]): Promise<void> {
  if (mutationIds.length === 0) return;

  const done = new Set(mutationIds);
  await mutate((current) => current.filter((mutation) => !done.has(mutation.mutationId)));
}

/**
 * Payload keys that may carry a record id this panel minted offline. Kept in
 * step with `PAYLOAD_ID_KEYS` in `master/src/services/sync.service.ts`, which
 * resolves the same references on the receiving end.
 */
const PAYLOAD_ID_KEYS = ['partyId', 'ownerId', 'productId'] as const;

/**
 * Rewrite every queued mutation that still refers to a temporary id.
 *
 * A panel can queue "create lead X" and "move lead X to Quoted" before either
 * reaches the Master. Once X has a permanent id, the still-queued follow-ups
 * have to point at it — otherwise the Master resolves them through `id_map`,
 * which works, but leaves the panel's own queue describing a record by a name
 * nothing else uses.
 *
 * References *inside* a payload are rewritten too, not just `entityId`: a lead
 * queued against a party this panel created carries the party's temporary id as
 * `payload.partyId`, and leaving it pointing at a settled id makes the panel's
 * own queue disagree with what it already knows about the record.
 */
export async function remapIds(mapping: Map<string, string>): Promise<void> {
  if (mapping.size === 0) return;

  const remap = (value: unknown): unknown =>
    typeof value === 'string' ? (mapping.get(value) ?? value) : value;

  await mutate((current) =>
    current.map((mutation) => {
      const payload: Record<string, unknown> = { ...mutation.payload };
      let changed = false;

      for (const key of PAYLOAD_ID_KEYS) {
        if (!(key in payload)) continue;
        const next = remap(payload[key]);
        if (next !== payload[key]) {
          payload[key] = next;
          changed = true;
        }
      }

      if (Array.isArray(payload.items)) {
        const items = payload.items.map((item) => {
          if (typeof item !== 'object' || item === null) return item;
          const line = item as Record<string, unknown>;
          if (!('productId' in line)) return item;
          const next = remap(line.productId);
          if (next === line.productId) return item;
          changed = true;
          return { ...line, productId: next };
        });
        if (changed) payload.items = items;
      }

      const permanent = mapping.get(mutation.entityId);
      if (!permanent && !changed) return mutation;

      return {
        ...mutation,
        ...(permanent ? { entityId: permanent } : {}),
        ...(changed ? { payload } : {}),
      };
    }),
  );
}

async function load(): Promise<Mutation[]> {
  if (cached) return cached;

  const file = paths().outboxFile;

  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('The file does not hold a list of changes');
    cached = parsed as Mutation[];
  } catch (error) {
    // Absent means nothing queued, and is not worth a line. Unreadable is
    // reported but not fatal — a panel that refused to start because of a
    // corrupt queue would be worse than one that starts empty and can take new
    // work. Reported loudly, though: the next save rewrites this file, so the
    // log is the only trace that the queue ever held anything.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error(
        `Could not read the queued changes in ${file}; starting with an empty queue, so what it held will not reach the Master`,
        error,
      );
    }
    cached = [];
  }

  return cached;
}

function mutate(update: (current: Mutation[]) => Mutation[]): Promise<void> {
  writeChain = writeChain.then(async () => {
    const next = update(await load());
    cached = next;
    revision += 1;
    await persist(next);
  });

  return writeChain;
}

/**
 * Bumped on every write to the queue.
 *
 * The merged view is the snapshot with the outbox laid over it, so a memo of
 * that view has to invalidate when either half moves. This is the outbox half.
 */
let revision = 0;

export function outboxRevision(): number {
  return revision;
}

async function persist(mutations: Mutation[]): Promise<void> {
  await fs.mkdir(path.dirname(paths().outboxFile), { recursive: true });

  const temporary = `${paths().outboxFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(mutations, null, 2), { mode: 0o600 });
  await fs.rename(temporary, paths().outboxFile);
}

/**
 * Writes the Master refused, kept after they have left the queue.
 *
 * `settle()` drops applied, merged **and refused** mutations alike — which is
 * correct for the queue, because a refusal is recorded permanently on the
 * Master and re-pushing it earns the same answer forever. What was wrong is
 * that the refusal then existed only in a module-level variable on the panel
 * server, reassigned on *every* successful flush including empty ones. With a
 * batch size of 100, a 500-row push lost four batches of refusals out of five,
 * and a restart lost all of them. Meanwhile the optimistic record vanished
 * with the queue entry it was derived from.
 *
 * So: refusals move here, to their own file, and stay until somebody has seen
 * them. A salesperson whose lead was thrown away can be told, and can still be
 * told tomorrow morning.
 */
export interface RefusedWrite {
  mutation: Mutation;
  result: MutationResult;
  refusedAt: IsoTimestamp;
}

/** Bounded: this is a record for a person to read, not an audit log. */
const MAX_REFUSALS = 200;

let refusalsCache: RefusedWrite[] | null = null;
let refusalChain: Promise<void> = Promise.resolve();

export async function refusals(): Promise<RefusedWrite[]> {
  return [...(await loadRefusals())];
}

export async function recordRefusals(entries: RefusedWrite[]): Promise<void> {
  if (entries.length === 0) return;

  refusalChain = refusalChain.then(async () => {
    const current = await loadRefusals();
    // Newest first, and deduplicated by mutation id: a replay that earns the
    // same permanent refusal must not stack a second copy of it.
    const seen = new Set(entries.map((entry) => entry.result.mutationId));
    const next = [...entries, ...current.filter((entry) => !seen.has(entry.result.mutationId))];
    refusalsCache = next.slice(0, MAX_REFUSALS);
    await persistRefusals(refusalsCache);
  });

  return refusalChain;
}

/** Called once somebody has actually been shown them. Empty clears everything. */
export async function clearRefusals(mutationIds?: string[]): Promise<void> {
  refusalChain = refusalChain.then(async () => {
    const current = await loadRefusals();
    const drop = mutationIds ? new Set(mutationIds) : null;
    refusalsCache = drop ? current.filter((entry) => !drop.has(entry.result.mutationId)) : [];
    await persistRefusals(refusalsCache);
  });

  return refusalChain;
}

async function loadRefusals(): Promise<RefusedWrite[]> {
  if (refusalsCache) return refusalsCache;

  try {
    const raw = await fs.readFile(paths().refusalsFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    refusalsCache = Array.isArray(parsed) ? (parsed as RefusedWrite[]) : [];
  } catch {
    refusalsCache = [];
  }

  return refusalsCache;
}

async function persistRefusals(entries: RefusedWrite[]): Promise<void> {
  await fs.mkdir(path.dirname(paths().refusalsFile), { recursive: true });

  const temporary = `${paths().refusalsFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
  await fs.rename(temporary, paths().refusalsFile);
}

/** Test seam. */
export function resetOutboxCache(): void {
  revision += 1;
  cached = null;
  refusalsCache = null;
  writeChain = Promise.resolve();
  refusalChain = Promise.resolve();
}
