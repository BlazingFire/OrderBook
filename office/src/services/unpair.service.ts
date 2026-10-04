/**
 * Unpair this PC from its Master, on purpose.
 *
 * Without this the only way to point an Office at a different Master (or to stop it
 * knocking on one that is gone) was developer mode, which erases every file. This
 * clears the pairing, the cached snapshot and the sync cursor, and the people cached
 * for offline sign-in, because all of it is the old Master's.
 *
 * **Work that was never sent is not thrown away without being asked.** If anything
 * is waiting in the outbox the call refuses (`pending_changes`, with the count) until
 * the caller says, a second time, what to do with it: `keep` or `discard`. Kept, those
 * changes are still this PC's: paired again to the same Master they are sent; paired
 * to a different one they are set aside by `adoptMaster()`, never sent there.
 */

import { createLogger } from '../lib/logger.js';
import { masterConnection } from '../realtime/master-connection.js';
import { resetLocalStore } from '../sync/local-store.js';
import { pending, pendingCount, settle } from '../sync/outbox.store.js';
import { clearCredentials, loadCredentials } from './credentials.store.js';
import { dropCachedData, recordCacheOwner, rememberLastPanel } from './master-binding.js';
import * as userSession from './user-session.service.js';

const log = createLogger('unpair');

export class UnpairError extends Error {
  constructor(
    readonly code: 'pending_changes' | 'not_paired',
    readonly count = 0,
  ) {
    super(
      code === 'pending_changes'
        ? `${count} change(s) have not been sent`
        : 'This PC is not paired',
    );
    this.name = 'UnpairError';
  }
}

/** How long to wait for the Master to acknowledge `panel:leave`: this is a courtesy, never a reason to hang. */
const LEAVE_ACK_MS = 3_000;

export interface UnpairResult {
  ok: true;
  /** The Master was told this PC is leaving (it marks the row removed, so nothing stale is left behind). */
  notifiedMaster: boolean;
  /** Unsent changes left on this PC for the next pairing. */
  keptChanges: number;
  discardedChanges: number;
}

export async function unpair(
  options: { pending?: 'keep' | 'discard' } = {},
): Promise<UnpairResult> {
  const credentials = await loadCredentials();
  if (!credentials) throw new UnpairError('not_paired');

  const waiting = await pendingCount();
  if (waiting > 0 && !options.pending) throw new UnpairError('pending_changes', waiting);

  /*
   * Tell the Master first, while the link is up and this panel's own socket has
   * proven who it is: it marks the row removed ("left") instead of leaving an active
   * row that is merely offline, and pairing this PC again then reuses the row. Only a
   * courtesy: not connected, a Master older than protocol 9 (`updateNeeded`), no
   * answer in a few seconds, or a refusal all just mean "leave locally", and the
   * saved id and secret still let the Master recognise this PC next time.
   */
  let notified = false;
  try {
    await masterConnection.commandWithin(LEAVE_ACK_MS)('panel:leave');
    notified = true;
  } catch (error) {
    log.info(
      `The Master was not told this PC is leaving (${error instanceof Error ? error.message : 'no answer'})`,
    );
  }

  // The in-memory snapshot goes first: closing the link flushes a pending write of it.
  userSession.resetSession();
  resetLocalStore();
  masterConnection.disconnect();

  await clearCredentials();
  await rememberLastPanel(credentials.panelId, credentials.panelSecret);
  await dropCachedData();

  let discarded = 0;
  if (waiting > 0 && options.pending === 'discard') {
    const all = await pending();
    await settle(all.map((mutation) => mutation.mutationId));
    discarded = all.length;
  }
  const kept = waiting - discarded;
  // Work that stays must still know whose it is; with nothing left, nothing does.
  await recordCacheOwner(kept > 0 ? credentials.masterUniqueId : null);

  masterConnection.markUnpaired();
  log.warn(
    `Unpaired from Master ${credentials.masterUniqueId}: ${kept} unsent change(s) kept, ${discarded} discarded`,
  );
  return { ok: true, notifiedMaster: notified, keptChanges: kept, discardedChanges: discarded };
}
