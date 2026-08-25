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

import type { Mutation, MutationKind } from '@orderbook/shared';

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
 * Rewrite every queued mutation that still refers to a temporary id.
 *
 * A panel can queue "create lead X" and "move lead X to Quoted" before either
 * reaches the Master. Once X has a permanent id, the still-queued follow-ups
 * have to point at it — otherwise the Master resolves them through `id_map`,
 * which works, but leaves the panel's own queue describing a record by a name
 * nothing else uses.
 */
export async function remapIds(mapping: Map<string, string>): Promise<void> {
  if (mapping.size === 0) return;

  await mutate((current) =>
    current.map((mutation) => {
      const permanent = mapping.get(mutation.entityId);
      return permanent ? { ...mutation, entityId: permanent } : mutation;
    }),
  );
}

export async function clearOutbox(): Promise<void> {
  await mutate(() => []);
}

async function load(): Promise<Mutation[]> {
  if (cached) return cached;

  try {
    const raw = await fs.readFile(paths().outboxFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cached = Array.isArray(parsed) ? (parsed as Mutation[]) : [];
  } catch {
    // Absent means nothing queued. Unreadable is reported but not fatal — a
    // panel that refused to start because of a corrupt queue would be worse
    // than one that starts empty and can take new work.
    cached = [];
  }

  return cached;
}

function mutate(update: (current: Mutation[]) => Mutation[]): Promise<void> {
  writeChain = writeChain.then(async () => {
    const next = update(await load());
    cached = next;
    await persist(next);
  });

  return writeChain;
}

async function persist(mutations: Mutation[]): Promise<void> {
  await fs.mkdir(path.dirname(paths().outboxFile), { recursive: true });

  const temporary = `${paths().outboxFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(mutations, null, 2), { mode: 0o600 });
  await fs.rename(temporary, paths().outboxFile);
}

/** Test seam. */
export function resetOutboxCache(): void {
  cached = null;
  writeChain = Promise.resolve();
}
