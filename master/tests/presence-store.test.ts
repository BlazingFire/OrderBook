/**
 * The in-memory presence store (rule 3): who has which record open, debounced
 * into one push per burst, with tabs expiring after the TTL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRESENCE_DEBOUNCE_MS,
  createPresenceStore,
  type PresenceChange,
  type PresenceStore,
} from '../src/realtime/presence-store.js';

const LEAD = { tenantId: 'T1', recordKind: 'lead' as const, recordId: 'LD0000000001', partyId: 'PT1' };
const OTHER = { ...LEAD, recordId: 'LD0000000002' };

const viewer = (userId: string, tier: 'office' | 'server_master' = 'office') => ({
  userId,
  displayName: `Name ${userId}`,
  avatar: null,
  tier,
});

describe('the presence store', () => {
  let clock: number;
  let store: PresenceStore;
  let changes: PresenceChange[];

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    store = createPresenceStore({ now: () => clock });
    changes = [];
    store.onChange((change) => changes.push(change));
  });
  afterEach(() => {
    store.clear();
    vi.useRealTimers();
  });

  const flush = () => vi.advanceTimersByTime(PRESENCE_DEBOUNCE_MS);

  it('answers a beat with everyone on the record, and the Server Master tier rides along', () => {
    store.beat('panel:P1:a', LEAD, viewer('U1'), false);
    const view = store.beat('admin:U2:b', LEAD, viewer('U2', 'server_master'), true);

    expect(view.entries.map((entry) => [entry.userId, entry.editing, entry.tier])).toEqual([
      ['U1', false, 'office'],
      ['U2', true, 'server_master'],
    ]);
  });

  it('gathers a burst into one push, sent only to the people on the record', () => {
    store.beat('panel:P1:a', LEAD, viewer('U1'), false);
    store.beat('admin:U2:b', LEAD, viewer('U2'), false);
    store.beat('admin:U2:b', LEAD, viewer('U2'), true);
    expect(changes).toHaveLength(0);

    flush();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ tenantId: 'T1', recordId: LEAD.recordId, partyId: 'PT1' });
    expect(changes[0]!.userIds.sort()).toEqual(['U1', 'U2']);
    expect(changes[0]!.presence.entries.find((entry) => entry.userId === 'U2')?.editing).toBe(true);
  });

  it('tells a beat still in flight that its tab left or its connection dropped meanwhile', () => {
    const ticket = store.ticket();
    store.leave('admin:U1:a');
    store.dropPrefix('panel:P1:');

    expect(store.leftSince('admin:U1:a', ticket)).toBe(true);
    expect(store.leftSince('admin:U1:ab', ticket)).toBe(false);
    expect(store.leftSince('panel:P1:x', ticket)).toBe(true);
    expect(store.leftSince('panel:P10:x', ticket)).toBe(false);
    // A beat that started after the leave is a fresh open, not a ghost.
    expect(store.leftSince('admin:U1:a', store.ticket())).toBe(false);
  });

  it('does not push for a beat that changes nothing', () => {
    store.beat('panel:P1:a', LEAD, viewer('U1'), false);
    flush();
    changes = [];

    clock += 10_000;
    store.beat('panel:P1:a', LEAD, viewer('U1'), false);
    flush();

    expect(changes).toHaveLength(0);
  });

  it('shows two tabs of one person as one entry, editing if either tab is', () => {
    store.beat('admin:U1:a', LEAD, viewer('U1'), false);
    clock += 1_000;
    const view = store.beat('admin:U1:b', LEAD, viewer('U1'), true);

    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ userId: 'U1', editing: true });
    // The earlier tab's time is when they arrived.
    expect(view.entries[0]!.since).toBe(new Date(1_000_000).toISOString());
  });

  it('moves a tab that opens another record off the first one', () => {
    store.beat('admin:U1:a', LEAD, viewer('U1'), false);
    store.beat('admin:U2:a', LEAD, viewer('U2'), false);
    flush();
    changes = [];

    store.beat('admin:U1:a', OTHER, viewer('U1'), false);
    flush();

    const first = changes.find((change) => change.recordId === LEAD.recordId);
    expect(first?.presence.entries.map((entry) => entry.userId)).toEqual(['U2']);
    expect(store.viewerOn('admin:U1:a', LEAD)).toBeNull();
    expect(store.viewerOn('admin:U1:a', OTHER)?.userId).toBe('U1');
  });

  it('drops a tab that stops beating after the TTL, noticed on the next beat', () => {
    store.beat('panel:P1:a', LEAD, viewer('U1'), false);
    store.beat('admin:U2:b', LEAD, viewer('U2'), false);
    flush();
    changes = [];

    clock += 29_000;
    store.beat('admin:U2:b', LEAD, viewer('U2'), false);
    flush();
    expect(changes).toHaveLength(0);

    clock += 2_000;
    const view = store.beat('admin:U2:b', LEAD, viewer('U2'), false);
    flush();

    expect(view.entries.map((entry) => entry.userId)).toEqual(['U2']);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.userIds).toEqual(['U2']);
  });

  it('drops every tab of a connection by prefix, and nobody else’s', () => {
    store.beat('panel:P1:a', LEAD, viewer('U1'), false);
    store.beat('panel:P1:b', OTHER, viewer('U1'), false);
    store.beat('panel:P10:a', LEAD, viewer('U3'), false);
    store.beat('admin:U2:a', LEAD, viewer('U2'), false);
    flush();
    changes = [];

    store.dropPrefix('panel:P1:');
    flush();

    expect(store.viewerOn('panel:P1:a', LEAD)).toBeNull();
    expect(store.viewerOn('panel:P1:b', OTHER)).toBeNull();
    expect(store.viewerOn('panel:P10:a', LEAD)?.userId).toBe('U3');
    const lead = changes.find((change) => change.recordId === LEAD.recordId);
    expect(lead?.userIds.sort()).toEqual(['U2', 'U3']);
    // Nobody is left on the other record, so nobody is told.
    expect(changes.find((change) => change.recordId === OTHER.recordId)).toBeUndefined();
  });

  it('carries a save to the people on the record once, on the next push only', () => {
    store.beat('admin:U2:a', LEAD, viewer('U2'), true);
    flush();
    changes = [];

    const write = { userId: 'U1', displayName: 'Ravi', at: new Date(clock).toISOString(), action: 'updated' as const };
    store.noteWrite(LEAD, write);
    flush();
    expect(changes[0]!.presence.lastWrite).toEqual(write);

    store.beat('admin:U3:a', LEAD, viewer('U3'), false);
    flush();
    expect(changes[1]!.presence.lastWrite).toBeUndefined();
  });

  it('ignores a save on a record nobody has open', () => {
    store.noteWrite(LEAD, { userId: 'U1', displayName: 'Ravi', at: new Date(clock).toISOString(), action: 'updated' });
    flush();
    expect(changes).toHaveLength(0);
  });

  it('starts a fresh entry when another person beats on the same key', () => {
    store.beat('panel:P1:a', LEAD, viewer('U1'), false);
    clock += 5_000;
    const view = store.beat('panel:P1:a', LEAD, viewer('U4'), false);

    expect(view.entries.map((entry) => entry.userId)).toEqual(['U4']);
    expect(view.entries[0]!.since).toBe(new Date(clock).toISOString());
  });
});
