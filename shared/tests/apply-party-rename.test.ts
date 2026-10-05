/**
 * A party renamed on the Master reaches every lead and order a panel holds.
 *
 * The Master reads a record's party name live, but a `party` change event carries only the
 * party. Folding it in used to leave the old name on every lead and order of that party
 * until the record itself changed.
 */

import { describe, expect, it } from 'vitest';

import {
  applyChangeToSnapshot,
  type DataChangedEvent,
  type Lead,
  type Order,
  type Party,
  type SyncSnapshot,
} from '../src/index.js';

const party = (id: string, name: string) => ({ id, name }) as Party;
const lead = (id: string, partyId: string, partyName: string) =>
  ({ id, partyId, partyName, items: [{ productName: 'Slate 600x600' }] }) as unknown as Lead;
const order = (id: string, partyId: string, partyName: string) =>
  ({ id, partyId, partyName }) as unknown as Order;

function snapshot(): SyncSnapshot {
  return {
    parties: [party('p1', 'Sharma Tiles'), party('p2', 'Other Co')],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [lead('l1', 'p1', 'Sharma Tiles'), lead('l2', 'p2', 'Other Co')],
    orders: [order('o1', 'p1', 'Sharma Tiles'), order('o2', 'p2', 'Other Co')],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: {} as SyncSnapshot['dashboard'],
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-10-05T00:00:00.000Z',
  };
}

const partyChanged = (
  name: string,
  action: DataChangedEvent['action'] = 'updated',
): DataChangedEvent => ({
  entity: 'party',
  action,
  id: 'p1',
  payload: party('p1', name),
});

describe('a party rename', () => {
  it('updates the party name on its leads and orders, and only those', () => {
    const view = snapshot();

    expect(applyChangeToSnapshot(view, partyChanged('Sharma Ceramics'))).toBe('applied');

    expect(view.parties.find((p) => p.id === 'p1')?.name).toBe('Sharma Ceramics');
    expect(view.leads.map((l) => l.partyName)).toEqual(['Sharma Ceramics', 'Other Co']);
    expect(view.orders.map((o) => o.partyName)).toEqual(['Sharma Ceramics', 'Other Co']);
  });

  it('leaves the lines’ snapshotted product names alone', () => {
    const view = snapshot();
    applyChangeToSnapshot(view, partyChanged('Sharma Ceramics'));
    expect(view.leads[0]?.items[0]?.productName).toBe('Slate 600x600');
  });

  it('also follows a restored party, and does not copy rows that already match', () => {
    const view = snapshot();
    const untouched = view.leads[1];

    applyChangeToSnapshot(view, partyChanged('Sharma Ceramics', 'restored'));

    expect(view.leads[0]?.partyName).toBe('Sharma Ceramics');
    expect(view.leads[1]).toBe(untouched);
  });

  it('is what a snapshot-taking panel would hold', () => {
    const replayed = snapshot();
    applyChangeToSnapshot(replayed, partyChanged('Sharma Ceramics'));

    const fresh = snapshot();
    fresh.parties = [party('p1', 'Sharma Ceramics'), party('p2', 'Other Co')];
    fresh.leads = [lead('l1', 'p1', 'Sharma Ceramics'), lead('l2', 'p2', 'Other Co')];
    fresh.orders = [order('o1', 'p1', 'Sharma Ceramics'), order('o2', 'p2', 'Other Co')];

    expect(replayed).toEqual(fresh);
  });
});
