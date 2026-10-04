/**
 * Where a combobox's list opens: below when there is room, above when that side has more,
 * never taller than the room it has, and left to the CSS when nothing can be measured.
 */

import { describe, expect, it } from 'vitest';

import { placeListbox } from '../src/comboboxPlacement.js';

const WANTED = 274;

describe('placeListbox', () => {
  it('opens below with the full height when there is plenty of room', () => {
    expect(placeListbox({ top: 100, bottom: 136 }, { top: 0, bottom: 768 }, WANTED)).toEqual({
      side: 'below',
      room: WANTED,
    });
  });

  it('limits the list to the room below when that is all there is but still usable', () => {
    // 36 px field near the bottom of a 400 px dialog body: 400 - 150 - 8 = 242 below.
    expect(placeListbox({ top: 114, bottom: 150 }, { top: 0, bottom: 400 }, WANTED)).toEqual({
      side: 'below',
      room: 242,
    });
  });

  it('flips above when the bottom is cramped and the top is roomier', () => {
    const placed = placeListbox({ top: 380, bottom: 416 }, { top: 0, bottom: 440 }, WANTED);
    expect(placed.side).toBe('above');
    // 380 - 0 - 8 = 372 above, capped at what the list wants.
    expect(placed.room).toBe(WANTED);
  });

  it('stays below when both sides are tight but below is the larger', () => {
    const placed = placeListbox({ top: 20, bottom: 56 }, { top: 0, bottom: 150 }, WANTED);
    expect(placed.side).toBe('below');
    // 150 - 56 - 8 = 86, lifted to the floor so three rows still fit.
    expect(placed.room).toBe(96);
  });

  it('lifts the above side to the floor too when it is the roomier of two tight sides', () => {
    // below 110 - 96 - 8 = 6, above 60 - 0 - 8 = 52: above wins, and 52 is lifted to 96.
    const placed = placeListbox({ top: 60, bottom: 96 }, { top: 0, bottom: 110 }, WANTED);
    expect(placed).toEqual({ side: 'above', room: 96 });
  });

  it('never goes under the floor, even with no room on either side', () => {
    expect(placeListbox({ top: 0, bottom: 36 }, { top: 0, bottom: 40 }, WANTED).room).toBe(96);
  });

  it('leaves the CSS defaults alone when nothing has a size (no layout)', () => {
    expect(placeListbox({ top: 0, bottom: 0 }, { top: 0, bottom: 0 }, WANTED)).toEqual({
      side: 'below',
      room: null,
    });
  });
});
