/**
 * 1.5.9's one-time reset, seen from an Office (`shared/src/domain/release-reset.ts`).
 *
 * Once the Master's administrator has confirmed the reset, every snapshot carries its `epoch`.
 * The first time this Office sees an epoch it has not seen before, it drops the orders, leads
 * and catalogue edits still waiting in its outbox — they were made against the catalogue the
 * reset deleted — and keeps party edits and chat. Called before the outbox is sent, so nothing
 * stale reaches the Master. Recorded on disk, so it happens once per epoch, across restarts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { isDroppedByReleaseReset } from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { pending, settle } from './outbox.store.js';

const log = createLogger('release-reset');

interface Seen {
  epoch: string;
  dropped: number;
  at: string;
}

const seenFile = () => path.join(config.dataDir, 'release-reset.json');

export async function readSeenReset(): Promise<Seen | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(seenFile(), 'utf8')) as Partial<Seen>;
    return typeof parsed.epoch === 'string'
      ? { epoch: parsed.epoch, dropped: Number(parsed.dropped) || 0, at: String(parsed.at ?? '') }
      : null;
  } catch {
    return null;
  }
}

/** Drops the unsent orders a new reset epoch makes meaningless; the number dropped (0 if none). */
export async function applyResetEpoch(epoch: string | null | undefined): Promise<number> {
  if (!epoch) return 0;
  const seen = await readSeenReset();
  if (seen?.epoch === epoch) return 0;

  const stale = (await pending()).filter((mutation) => isDroppedByReleaseReset(mutation.kind));
  if (stale.length > 0) await settle(stale.map((mutation) => mutation.mutationId));

  const record: Seen = { epoch, dropped: stale.length, at: new Date().toISOString() };
  await fs.mkdir(path.dirname(seenFile()), { recursive: true });
  await fs.writeFile(seenFile(), JSON.stringify(record), 'utf8');
  if (stale.length > 0) {
    log.warn(`The Master's catalogue reset was confirmed: ${stale.length} unsent orders were dropped`);
  }
  return stale.length;
}
