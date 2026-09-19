/**
 * The change ring, and the partition it depends on.
 *
 * The second half is the one that matters. A delta is only safe if every
 * `ChangedEntity` has been deliberately placed in exactly one bucket —
 * replayable, snapshot-forcing, or irrelevant to a panel — and the way that
 * goes wrong is not a bug in this file, it is somebody adding a fifteenth
 * entity and nobody noticing. `party_variant` is the case that made the point:
 * it is in the snapshot, `applyChange` has no case for it, and a replayed one
 * would be dropped on the floor with staff quoting from stale prices and no
 * error anywhere.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  PANEL_IRRELEVANT_ENTITIES,
  REPLAYABLE_ENTITIES,
  SNAPSHOT_FORCING_ENTITIES,
  type ChangedEntity,
  type DataChangedEvent,
} from '@orderbook/shared';

import { BOOT_ID, currentSeq, record, resetChangeRing, since } from '../src/realtime/change-ring.js';

function change(id: string): DataChangedEvent {
  return { entity: 'lead', action: 'updated', id, payload: { id } };
}

describe('the change ring', () => {
  beforeEach(resetChangeRing);

  it('hands out monotonic sequence numbers and stamps them on the event', () => {
    const first = change('LD1');
    const second = change('LD2');

    expect(record(first)).toBe(1);
    expect(record(second)).toBe(2);

    // Stamped in place, so every recipient sees the same number the ring holds.
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(currentSeq()).toBe(2);
  });

  it('answers with everything after the cursor', () => {
    for (const id of ['LD1', 'LD2', 'LD3']) record(change(id));

    expect(since(1)?.map((event) => event.id)).toEqual(['LD2', 'LD3']);
    expect(since(3)).toEqual([]);
  });

  it('answers null rather than a short list once it has evicted something', () => {
    // Well past the ring's capacity, so the early entries are gone.
    for (let i = 0; i < 2_500; i += 1) record(change(`LD${i}`));

    // A cursor from before the eviction cannot be answered honestly: the ring
    // no longer holds the rows in between, and a short list would look like a
    // complete one.
    expect(since(1)).toBeNull();

    // A recent cursor is still fine.
    expect(since(currentSeq() - 5)).toHaveLength(5);
  });

  it('answers null for a cursor from the future', () => {
    record(change('LD1'));
    // A panel holding a sequence this process never issued — a Master that was
    // restored from a backup, say. "Cannot prove it" is the same answer.
    expect(since(99)).toBeNull();
  });

  it('mints a boot id, so a cursor cannot outlive the ring it names', () => {
    expect(BOOT_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('every changed entity is in exactly one bucket', () => {
  /**
   * Deliberately written out rather than derived from the three exports: the
   * point is to fail when somebody adds a fourteenth entity, and a list derived
   * from the same source it is checking would just agree with itself.
   */
  const EVERY_ENTITY: ChangedEntity[] = [
    'lead',
    'order',
    'party',
    'product',
    'product_category',
    'party_variant',
    'office_panel',
    'stock',
    'reservation',
    'pipeline',
    'option_list',
    'custom_field',
    'sync_conflict',
    'role',
    'user',
    'catalog',
  ];

  const buckets = [REPLAYABLE_ENTITIES, SNAPSHOT_FORCING_ENTITIES, PANEL_IRRELEVANT_ENTITIES];

  it.each(EVERY_ENTITY)('%s is in one bucket and only one', (entity) => {
    const memberships = buckets.filter((bucket) => bucket.includes(entity));
    expect(memberships).toHaveLength(1);
  });

  it('has no bucket entry that is not a real entity', () => {
    for (const bucket of buckets) {
      for (const entity of bucket) expect(EVERY_ENTITY).toContain(entity);
    }
  });

  it('covers the whole union, so a new entity fails here rather than silently replaying', () => {
    const covered = new Set(buckets.flatMap((bucket) => [...bucket]));
    expect([...covered].sort()).toEqual([...EVERY_ENTITY].sort());
  });
});
