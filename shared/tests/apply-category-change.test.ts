/**
 * A category — the owner's Product — can be binned since catalogue v2
 * (`docs/catalogue/CATALOGUE_MODEL.md` §5). Left to the blind upsert every
 * other action takes, a `deleted` event would have kept it in a connected
 * panel's Products list, and offered it offline, until the next reconnect.
 */

import { describe, expect, it } from 'vitest';

import { applyChangeToSnapshot, type ProductCategory, type SyncSnapshot } from '../src/index.js';

const OPT: ProductCategory = {
  id: 'PC1',
  tenantId: 't1',
  name: 'One Piece Toilet',
  code: 'OPT',
  brand: 'Swisware+',
  sortOrder: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  deletedAt: null,
};

describe('a category change reaching a connected panel', () => {
  it('takes a binned category out, and puts a restored one back', () => {
    const snapshot = { categories: [OPT] } as unknown as SyncSnapshot;

    const deleted = { ...OPT, deletedAt: '2026-09-29T00:00:00.000Z' };
    expect(
      applyChangeToSnapshot(snapshot, {
        entity: 'product_category',
        action: 'deleted',
        id: OPT.id,
        payload: deleted,
      }),
    ).toBe('applied');
    expect(snapshot.categories).toEqual([]);

    expect(
      applyChangeToSnapshot(snapshot, {
        entity: 'product_category',
        action: 'restored',
        id: OPT.id,
        payload: OPT,
      }),
    ).toBe('applied');
    expect(snapshot.categories).toEqual([OPT]);
  });
});
