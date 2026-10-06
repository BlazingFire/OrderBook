/**
 * `fitColumns` is the one piece of the narrow-screen work that is pure
 * arithmetic, so it is the one piece that can be tested without a DOM. The rest
 * of the responsive layout is CSS and stays a manual gate.
 *
 * The property worth pinning is not "it drops columns" — it is that it cannot
 * oscillate. Every call recomputes from the full set, so widening a window
 * brings a column straight back and a re-measure after a drop never drops a
 * second one.
 */

import { describe, expect, it } from 'vitest';

import { columnWidthPx, fitColumns } from '../../ui/src/fitColumns.js';

const ROOT = 14;

/** Four columns: two that must stay, one droppable, one dropped first. */
const COLUMNS = [
  { key: 'name', width: '20rem' },
  { key: 'status', width: '10rem', priority: 1 as const },
  { key: 'owner', width: '10rem', priority: 2 as const },
  { key: 'updated', width: '10rem', priority: 3 as const },
];

/** 20 + 10 + 10 + 10 rem at 14px = 700px for everything. */
const ALL = 50 * ROOT;
const WITHOUT_THREE = 40 * ROOT;
const WITHOUT_TWO_AND_THREE = 30 * ROOT;

describe('columnWidthPx', () => {
  it('reads rem against the live root size, so it tracks the UI scale', () => {
    expect(columnWidthPx('10rem', 14)).toBe(140);
    expect(columnWidthPx('10rem', 22)).toBe(220);
  });

  it('reads px literally', () => {
    expect(columnWidthPx('160px', 14)).toBe(160);
  });

  it('gives a flexible or absent track a readable floor rather than zero', () => {
    // Zero would make any table of `1fr` columns claim to fit in no space at
    // all, and nothing would ever drop.
    expect(columnWidthPx('1fr', 14)).toBeGreaterThan(0);
    expect(columnWidthPx(undefined, 14)).toBe(columnWidthPx('1fr', 14));
    expect(columnWidthPx('auto', 14)).toBe(columnWidthPx('1fr', 14));
    expect(columnWidthPx('50%', 14)).toBe(columnWidthPx('1fr', 14));
  });

  it('scales a flexible column with the root size, so 157 % drops columns instead of cutting them', () => {
    expect(columnWidthPx('1fr', 14)).toBeCloseTo(120);
    expect(columnWidthPx('minmax(0, 1fr)', 22)).toBeCloseTo((120 * 22) / 14);
  });
});

describe('fitColumns', () => {
  it('keeps everything when everything fits', () => {
    expect(fitColumns(COLUMNS, ALL, ROOT).map((c) => c.key)).toEqual([
      'name',
      'status',
      'owner',
      'updated',
    ]);
  });

  it('drops priority 3 first', () => {
    expect(fitColumns(COLUMNS, WITHOUT_THREE, ROOT).map((c) => c.key)).toEqual([
      'name',
      'status',
      'owner',
    ]);
  });

  it('drops priority 2 next, and never priority 1 or an absent priority', () => {
    expect(fitColumns(COLUMNS, WITHOUT_TWO_AND_THREE, ROOT).map((c) => c.key)).toEqual([
      'name',
      'status',
    ]);

    // Narrower than even those two: the survivors are the same set, and
    // `.ob-tablewrap` (`overflow: clip`) is what contains the overflow.
    expect(fitColumns(COLUMNS, 100, ROOT).map((c) => c.key)).toEqual(['name', 'status']);
  });

  it('cannot oscillate — every call starts from the full set', () => {
    const narrow = fitColumns(COLUMNS, WITHOUT_TWO_AND_THREE, ROOT);
    // Re-measuring after the drop must not drop anything further…
    expect(fitColumns(COLUMNS, WITHOUT_TWO_AND_THREE, ROOT)).toEqual(narrow);
    // …and widening brings every column straight back.
    expect(fitColumns(COLUMNS, ALL, ROOT)).toEqual(COLUMNS);
  });

  it('shows everything while the table has not been measured yet', () => {
    // A zero width is "not measured", not "no room". Treating it as no room
    // would render the narrow subset on the first frame of every table and
    // widen on the second.
    expect(fitColumns(COLUMNS, 0, ROOT)).toEqual(COLUMNS);
    expect(fitColumns(COLUMNS, ALL, 0)).toEqual(COLUMNS);
  });

  it('drops more as the UI scale grows, because the same columns need more pixels', () => {
    // 50rem at scale 22 is 1100px, so a 900px table no longer fits them all
    // even though it did at scale 14.
    expect(fitColumns(COLUMNS, 900, 14)).toHaveLength(4);
    expect(fitColumns(COLUMNS, 900, 22).length).toBeLessThan(4);
  });
});
