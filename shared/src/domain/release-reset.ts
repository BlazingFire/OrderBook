/**
 * 1.5.9's one-time reset (owner, 2026-11-19): every order, lead, sub product, main product and
 * product photo is deleted, once an administrator has read the written warning and confirmed;
 * users, parties, settings and option lists stay, and order numbers carry on. A full backup is
 * written first. Nothing is deleted at install: the Master runs on the migrated data until then.
 *
 * Once done, the snapshot carries the reset's `epoch`; an Office that has not seen it drops the
 * orders and catalogue edits it still holds unsent (they were made against the old catalogue)
 * and keeps everything else in its queue.
 */

/** Which release's reset this is; one row per company in `release_resets`. */
export const RELEASE_RESET_VERSION = '1.5.9';

/** `none`: nothing to delete here (a fresh install, or the row is missing). */
export type ReleaseResetState = 'pending' | 'done' | 'none';

export interface ReleaseResetStatus {
  release: string;
  state: ReleaseResetState;
  /** What the reset removes, counted now (binned rows included). Zero once done. */
  removes: {
    newOrders: number;
    finalOrders: number;
    subProducts: number;
    mainProducts: number;
    photos: number;
  };
  /** What it keeps, so the warning can say so with numbers. */
  keeps: { parties: number; users: number };
  /** Once done: where the backup taken before the reset was written. */
  backupPath: string | null;
  confirmedAt: string | null;
}

/** The tick box and the person's own password. */
export interface ReleaseResetConfirmInput {
  understood: boolean;
  confirmPassword: string;
}

export interface ReleaseResetResult {
  ok: true;
  backupPath: string;
  removed: { newOrders: number; finalOrders: number; subProducts: number; mainProducts: number };
}

/**
 * The queued Office mutations the reset makes meaningless: orders, leads and catalogue edits.
 * Party edits and chat messages are kept.
 */
export function isDroppedByReleaseReset(kind: string): boolean {
  return (
    kind.startsWith('lead.') ||
    kind.startsWith('order.') ||
    kind.startsWith('product.') ||
    kind.startsWith('partyVariant.')
  );
}
