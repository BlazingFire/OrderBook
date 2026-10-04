/**
 * Stock and inventory were removed in 1.4 (requirement R15). These pin that they
 * stay removed, and that a Master or cache from before the removal is tolerated.
 *
 * What is kept on purpose is append-only history: the `activity.stock.*` tokens
 * (`activity-tokens.lock.json`), `logs.entity.stock`, `logs.action.*`, and
 * `fieldSet.stock.colour`, which is the COLOUR list and unrelated to stock.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  EN_MESSAGES,
  MODULES,
  MUTATION_KINDS,
  SETTINGS,
  applyChangeToSnapshot,
  resolveCompanyFeatures,
  type CompanyFeatures,
  type DataChangedEvent,
  type SyncSnapshot,
} from '../src/index.js';

describe('the removed stock surface stays removed', () => {
  it('has no inventory setting, module, stock capability or stock mutation', () => {
    expect(Object.keys(SETTINGS).filter((key) => key.startsWith('inventory.'))).toEqual([]);
    expect(MODULES as readonly string[]).not.toContain('inventory');
    expect(CAPABILITIES.map((capability) => capability.key)).not.toContain('stock.adjust');
    expect(MUTATION_KINDS.filter((kind) => kind.startsWith('stock.'))).toEqual([]);
  });

  it('the catalogue has no inventory or stock-permission keys', () => {
    const catalogue = EN_MESSAGES;
    const retired = ['inventory.', 'setting.inventory.', 'permission.inventory.', 'permission.stock.', 'module.inventory'];
    const offenders = Object.keys(catalogue).filter((key) =>
      retired.some((prefix) => key.startsWith(prefix)),
    );
    expect(offenders).toEqual([]);
  });
});

describe('a Master from before the removal', () => {
  it('has its stray freeToSell and adjustmentNoteRequired switches ignored', () => {
    const old = {
      freeToSell: false,
      adjustmentNoteRequired: true,
      offlineSignInEnabled: false,
    } as CompanyFeatures;

    const resolved = resolveCompanyFeatures(old);

    expect(resolved.offlineSignInEnabled).toBe(false);
    expect('freeToSell' in resolved).toBe(false);
    expect('adjustmentNoteRequired' in resolved).toBe(false);
  });

  it('can still broadcast a stock change, which the snapshot ignores untouched', () => {
    const snapshot = {
      parties: [],
      products: [],
      categories: [],
      partyVariants: [],
      leads: [],
      orders: [],
    } as unknown as SyncSnapshot;
    const before = JSON.stringify(snapshot);
    const event = { entity: 'stock', action: 'updated', id: 'x', payload: null } as unknown as DataChangedEvent;

    // The `default` arm: an entity this panel does not track is ignored, not a
    // reason to refetch everything.
    expect(applyChangeToSnapshot(snapshot, event)).toBe('ignored');
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});
