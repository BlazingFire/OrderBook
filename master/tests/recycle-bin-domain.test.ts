/**
 * The Recycle Bin's pure invariants — the cursor, `suggestRestoredName`'s
 * determinism, `PARENT_LINKS`, and `visibleBinScopes`. Deliberately
 * database-free: the cursor is the one piece a silent `describe.skipIf` skip
 * would hide, and it is exercised here with no cluster in front of it.
 */

import { describe, expect, it } from 'vitest';

import { RECYCLE_BIN_ENTITIES, RESTORE_PERMISSION } from '@orderbook/shared';

import {
  PARENT_LINKS,
  assertParentsLive,
  decodeBinCursor,
  encodeBinCursor,
  suggestRestoredName,
  visibleBinScopes,
} from '../src/domain/recycle-bin.js';
import { ConflictError, ValidationError } from '../src/lib/errors.js';

describe('the Bin cursor', () => {
  it('round-trips at microsecond precision', () => {
    const payload = {
      deletedAt: '2026-08-24T10:15:30.123456Z',
      entityType: 'lead' as const,
      id: 'LD0000000042',
    };
    expect(decodeBinCursor(encodeBinCursor(payload))).toEqual(payload);
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeBinCursor('not-a-cursor')).toThrow(ValidationError);
  });

  it('rejects a cursor naming an unknown entity type', () => {
    const cursor = Buffer.from(
      JSON.stringify({ deletedAt: '2026-01-01T00:00:00.000000Z', entityType: 'not_a_thing', id: '1' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeBinCursor(cursor)).toThrow(ValidationError);
  });
});

describe('suggestRestoredName', () => {
  it('offers "(restored)" first', async () => {
    const suggestion = await suggestRestoredName('Sharma Tiles', () => false);
    expect(suggestion).toBe('Sharma Tiles (restored)');
  });

  it('escalates deterministically past every taken name', async () => {
    const taken = new Set(['Sharma Tiles (restored)', 'Sharma Tiles (restored 2)', 'Sharma Tiles (restored 3)']);
    const suggestion = await suggestRestoredName('Sharma Tiles', (candidate) => taken.has(candidate));
    expect(suggestion).toBe('Sharma Tiles (restored 4)');
  });

  it('is deterministic — the same taken set always yields the same suggestion', async () => {
    const taken = new Set(['X (restored)']);
    const isTaken = (candidate: string): boolean => taken.has(candidate);
    const first = await suggestRestoredName('X', isTaken);
    const second = await suggestRestoredName('X', isTaken);
    expect(first).toBe(second);
  });
});

describe('PARENT_LINKS', () => {
  it('names a parent for every entity that has one', () => {
    expect(PARENT_LINKS.lead).toEqual(['party']);
    expect(PARENT_LINKS.order).toEqual(['party', 'lead']);
    expect(PARENT_LINKS.user).toEqual(['role']);
    // A sub product lives in its product (category) since catalogue v2.
    expect(PARENT_LINKS.product).toEqual(['product_category']);
  });

  it('names no parent for entities with none', () => {
    expect(PARENT_LINKS.party).toBeUndefined();
    expect(PARENT_LINKS.product_category).toBeUndefined();
    expect(PARENT_LINKS.role).toBeUndefined();
  });
});

describe('assertParentsLive', () => {
  it('passes quietly when every parent is live', () => {
    expect(() =>
      assertParentsLive([{ entityType: 'party', id: 'PT1', label: 'Sharma Tiles', isLive: true }]),
    ).not.toThrow();
  });

  it('passes quietly with no parents at all', () => {
    expect(() => assertParentsLive([])).not.toThrow();
  });

  it('throws ConflictError naming every still-deleted parent', () => {
    expect.assertions(3);
    try {
      assertParentsLive([
        { entityType: 'party', id: 'PT1', label: 'Sharma Tiles', isLive: false },
        { entityType: 'lead', id: 'LD1', label: 'LD1', isLive: true },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      const details = (error as ConflictError).details as { blockedBy: Array<{ entityType: string }> };
      expect(details.blockedBy).toHaveLength(1);
      expect(details.blockedBy[0]).toMatchObject({ entityType: 'party', reason: 'parent_deleted' });
    }
  });
});

describe('visibleBinScopes — filter, do not refuse', () => {
  const restorePermissionOf = (type: (typeof RECYCLE_BIN_ENTITIES)[number]): string => RESTORE_PERMISSION[type];

  it('returns every entity type when none are requested and all keys are held', () => {
    const held = new Set(Object.values(RESTORE_PERMISSION));
    const visible = visibleBinScopes(undefined, restorePermissionOf, held, RECYCLE_BIN_ENTITIES);
    expect(visible.sort()).toEqual([...RECYCLE_BIN_ENTITIES].sort());
  });

  it('returns an empty array — not a throw — for an actor holding no delete keys', () => {
    const visible = visibleBinScopes(undefined, restorePermissionOf, new Set(), RECYCLE_BIN_ENTITIES);
    expect(visible).toEqual([]);
  });

  it('intersects a requested subset with the held keys', () => {
    const held = new Set(['parties.delete']);
    const visible = visibleBinScopes(['party', 'product'], restorePermissionOf, held, RECYCLE_BIN_ENTITIES);
    expect(visible).toEqual(['party']);
  });

  it('drops a type the actor holds no key for even when explicitly requested', () => {
    const held = new Set<string>();
    const visible = visibleBinScopes(['role'], restorePermissionOf, held, RECYCLE_BIN_ENTITIES);
    expect(visible).toEqual([]);
  });
});
