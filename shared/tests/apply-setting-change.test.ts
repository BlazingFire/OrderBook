/**
 * A company switch has to reach a panel more than once.
 *
 * Until 2026-09-18 it did not. `'setting'` was not a `ChangedEntity` at all, so
 * `writeSetting` published nothing and a panel learned a switch exactly once —
 * on its first snapshot. A connected panel never saw a flip, and a panel that
 * reconnected with a usable cursor took a delta, which carries no `features`
 * either. `inventory.freeToSell` shipped with that: an administrator turned it
 * off, the Settings screen agreed, and every panel went on showing reserved and
 * free stock until somebody restarted it.
 *
 * The repair is one list. `'setting'` is a `SNAPSHOT_FORCING_ENTITY`, which
 * buys both halves at once: the live path refreshes, and the reconnect path
 * refuses to build a delta.
 */

import { describe, expect, it } from 'vitest';

import {
  REPLAYABLE_ENTITIES,
  SNAPSHOT_FORCING_ENTITIES,
  applyChangeToSnapshot,
  type DataChangedEvent,
  type SyncSnapshot,
} from '../src/index.js';

/** Only the fields `applyChangeToSnapshot` can touch need to be real. */
function emptySnapshot(): SyncSnapshot {
  return {
    parties: [],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [],
    orders: [],
    stock: [],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: {} as SyncSnapshot['dashboard'],
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-09-18T00:00:00.000Z',
  };
}

function settingChanged(key: string): DataChangedEvent {
  return { entity: 'setting', action: 'updated', id: key, payload: null };
}

describe('a company switch reaching a connected panel', () => {
  it('forces a fresh snapshot rather than being folded in or ignored', () => {
    // 'ignored' is what today's tree answers, because the `default` arm catches
    // an entity it does not know — which is right for a genuinely unknown
    // entity from a newer Master, and wrong for this one.
    expect(applyChangeToSnapshot(emptySnapshot(), settingChanged('inventory.freeToSell'))).toBe(
      'refresh',
    );
  });

  it('answers the same for every key, since the payload is never read', () => {
    for (const key of ['security.offlineSignInEnabled', 'inventory.freeToSell', 'leads.quietAfterDays']) {
      expect(applyChangeToSnapshot(emptySnapshot(), settingChanged(key))).toBe('refresh');
    }
  });

  it('changes nothing in the snapshot on its way past', () => {
    // A refresh replaces the whole snapshot from the Master. Mutating this copy
    // first would be a half-applied change that survives if the refetch fails.
    const snapshot = emptySnapshot();
    applyChangeToSnapshot(snapshot, settingChanged('inventory.freeToSell'));
    expect(snapshot).toEqual(emptySnapshot());
  });

  it('is not replayable, which would drop it on the floor', () => {
    // `delta.service.ts` filters PANEL_IRRELEVANT first, then refuses the delta
    // if anything left is not REPLAYABLE. Listing 'setting' as replayable would
    // let a reconnecting panel take a delta that carries no `features` at all.
    expect(REPLAYABLE_ENTITIES).not.toContain('setting');
    expect(SNAPSHOT_FORCING_ENTITIES).toContain('setting');
  });
});
