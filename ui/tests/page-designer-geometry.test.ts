/**
 * The page designer's arithmetic.
 *
 * Hit-testing, snapping and alignment are where a layout tool's bugs live, and
 * they are miserable to find through a mouse: a snap that latches onto the
 * wrong edge looks like an unsteady hand. All of it is pure functions over
 * millimetres, so all of it is testable without a browser.
 */

import { describe, expect, it } from 'vitest';

import type { DocumentElement, PageGeometry } from '@orderbook/shared';
import { textStyle } from '@orderbook/shared';

import {
  align,
  applyHandle,
  clampToPage,
  distribute,
  fitToPage,
  handleAt,
  hitTest,
  MIN_SIZE_MM,
  pageFrame,
  renumber,
  reorder,
  scaleFor,
  snap,
  tidy,
  toMm,
  toPx,
  type Rect,
} from '../src/pageDesignerGeometry.js';

const A4: PageGeometry = {
  paperSize: 'A4',
  orientation: 'portrait',
  margins: { top: 18, right: 15, bottom: 18, left: 15 },
};

const PAGE: Rect = { x: 0, y: 0, w: 210, h: 297 };

function element(patch: Partial<DocumentElement> & { id: string }): DocumentElement {
  return {
    kind: 'text',
    text: patch.id,
    label: null,
    labelPlacement: 'none',
    style: textStyle(),
    x: 10,
    y: 10,
    w: 40,
    h: 10,
    z: 0,
    band: 'body',
    flow: 'fixed',
    ...patch,
  } as DocumentElement;
}

describe('page designer geometry', () => {
  it('converts between millimetres and pixels at the measured scale', () => {
    // The canvas derives its scale from the width it is given, so the same
    // layout draws correctly in a narrow preview and a wide editor.
    const scale = scaleFor(420, 210);
    expect(scale).toBe(2);
    expect(toPx(10, scale)).toBe(20);
    expect(toMm(20, scale)).toBe(10);

    // A host that has not been measured yet scales to nothing, so the page is
    // simply not drawn for that frame. Returning 1 instead would flash a page
    // at one pixel per millimetre and then jump to the real size, which is
    // worse than one frame of nothing. Neither may produce Infinity or NaN.
    expect(scaleFor(0, 210)).toBe(0);
    expect(scaleFor(420, 0)).toBe(1);
    expect(toMm(10, 0)).toBe(0);
  });

  it('frames the page and its margin box in millimetres', () => {
    const { page, margins } = pageFrame(A4);

    expect(page).toEqual({ x: 0, y: 0, w: 210, h: 297 });
    expect(margins).toEqual({ x: 15, y: 18, w: 180, h: 261 });
  });

  it('hit-tests from the top of the paint order down', () => {
    // Two overlapping boxes: the one drawn last is the one the eye sees, so it
    // is the one a click should find.
    const under = element({ id: 'under', z: 0 });
    const over = element({ id: 'over', z: 1 });

    expect(hitTest([under, over], 20, 15)).toBe('over');
    expect(hitTest([under, over], 200, 200)).toBeNull();
  });

  it('finds the grip a point is on, and the body between them', () => {
    const rect: Rect = { x: 10, y: 10, w: 40, h: 20 };

    expect(handleAt(rect, 10, 10, 1.5)).toBe('nw');
    expect(handleAt(rect, 50, 30, 1.5)).toBe('se');
    expect(handleAt(rect, 30, 10, 1.5)).toBe('n');
    expect(handleAt(rect, 10, 20, 1.5)).toBe('w');
    expect(handleAt(rect, 30, 20, 1.5)).toBe('move');
    expect(handleAt(rect, 90, 90, 1.5)).toBeNull();
  });

  it('leaves a thin element something to grab, so it can still be moved', () => {
    // A field on a real document is a few millimetres tall. With a fixed grip
    // the top and bottom zones meet in the middle and every point reports as a
    // resize — the element becomes impossible to move, only to stretch. Found
    // by dragging one in the browser and watching it refuse.
    const thin: Rect = { x: 15, y: 40, w: 90, h: 5 };

    expect(handleAt(thin, 60, 42.5, 2.4)).toBe('move');

    // The corners still work, because the clamp is a third of each side.
    expect(handleAt(thin, 15, 40, 2.4)).toBe('nw');
    expect(handleAt(thin, 105, 45, 2.4)).toBe('se');
  });

  it('resizes from the grip being held, and refuses to vanish', () => {
    const rect: Rect = { x: 10, y: 10, w: 40, h: 20 };

    expect(applyHandle(rect, 'move', 5, -5)).toEqual({ x: 15, y: 5, w: 40, h: 20 });
    expect(applyHandle(rect, 'e', 10, 0)).toMatchObject({ w: 50 });

    // Dragging the west edge moves the origin and shrinks the width together.
    expect(applyHandle(rect, 'w', 10, 0)).toMatchObject({ x: 20, w: 30 });

    // An element dragged to nothing cannot be grabbed again, which is a trap
    // rather than a feature.
    const collapsed = applyHandle(rect, 'e', -100, 0);
    expect(collapsed.w).toBe(MIN_SIZE_MM);

    const pinned = applyHandle(rect, 'w', 100, 0);
    expect(pinned.x).toBe(rect.x);
    expect(pinned.w).toBe(rect.w);
  });

  it('keeps an element on the paper', () => {
    expect(clampToPage({ x: -20, y: -20, w: 40, h: 10 }, PAGE)).toMatchObject({ x: 0, y: 0 });
    expect(clampToPage({ x: 500, y: 500, w: 40, h: 10 }, PAGE)).toMatchObject({
      x: 170,
      y: 287,
    });

    // Wider than the sheet: shrunk to fit rather than pushed off it.
    expect(clampToPage({ x: 0, y: 0, w: 400, h: 10 }, PAGE)).toMatchObject({ w: 210, x: 0 });
  });

  it('snaps to the closest competing edge, and reports the guide it used', () => {
    const { page, margins } = pageFrame(A4);
    const other: Rect = { x: 100, y: 50, w: 40, h: 20 };

    // A left edge a millimetre away from another element's left edge.
    const result = snap({ x: 101, y: 200, w: 30, h: 10 }, [other], page, margins);

    expect(result.rect.x).toBeCloseTo(100, 6);
    expect(result.guides.some((guide) => guide.axis === 'x' && guide.at === 100)).toBe(true);

    // Nothing within tolerance leaves the rect exactly where it was.
    const untouched = snap({ x: 60, y: 200, w: 30, h: 10 }, [other], page, margins);
    expect(untouched.rect.x).toBe(60);
    expect(untouched.guides.filter((guide) => guide.axis === 'x')).toHaveLength(0);
  });

  it('snaps to the margin box, which is what most layouts line up on', () => {
    const { page, margins } = pageFrame(A4);
    const result = snap({ x: 15.8, y: 200, w: 30, h: 10 }, [], page, margins);

    expect(result.rect.x).toBeCloseTo(15, 6);
  });

  it('aligns a single element against the page, and a group against itself', () => {
    // One selected element has nothing to align to but the paper, which is how
    // "centre this on the page" works without a separate command.
    const [centred] = align([{ x: 0, y: 0, w: 50, h: 10 }], 'centre', PAGE);
    expect(centred?.x).toBe(80);

    const group = align(
      [
        { x: 10, y: 0, w: 50, h: 10 },
        { x: 40, y: 20, w: 20, h: 10 },
      ],
      'left',
      PAGE,
    );
    expect(group.map((rect) => rect.x)).toEqual([10, 10]);
  });

  it('distributes three or more evenly and leaves the ends alone', () => {
    const spread = distribute(
      [
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 15, y: 0, w: 10, h: 10 },
        { x: 100, y: 0, w: 10, h: 10 },
      ],
      'x',
    );

    expect(spread[0]?.x).toBe(0);
    expect(spread[2]?.x).toBe(100);
    // First occupies [0,10] and last [100,110], leaving 80mm of free space and
    // two gaps around a 10mm element: 40 each, so the middle lands at 50.
    expect(spread[1]?.x).toBeCloseTo(50, 6);

    // Two cannot be distributed — there is no gap to even out.
    const pair = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 50, y: 0, w: 10, h: 10 },
    ];
    expect(distribute(pair, 'x')).toEqual(pair);
  });

  it('renumbers paint order from zero so it cannot drift', () => {
    // Bring-to-front by adding one to the maximum works until somebody has done
    // it four hundred times.
    const renumbered = renumber([
      element({ id: 'a', z: 900 }),
      element({ id: 'b', z: 5 }),
      element({ id: 'c', z: 40 }),
    ]);

    expect(renumbered.map((e) => [e.id, e.z])).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ]);
  });

  it('moves one element through the paint order', () => {
    const start = [
      element({ id: 'a', z: 0 }),
      element({ id: 'b', z: 1 }),
      element({ id: 'c', z: 2 }),
    ];

    const order = (elements: DocumentElement[]): string[] =>
      [...elements].sort((a, b) => a.z - b.z).map((e) => e.id);

    expect(order(reorder(start, 'a', 'front'))).toEqual(['b', 'c', 'a']);
    expect(order(reorder(start, 'c', 'back'))).toEqual(['c', 'a', 'b']);
    expect(order(reorder(start, 'a', 'forward'))).toEqual(['b', 'a', 'c']);
    expect(order(reorder(start, 'c', 'backward'))).toEqual(['a', 'c', 'b']);

    // Already at the front, and asked to go further: unchanged rather than lost.
    expect(order(reorder(start, 'c', 'forward'))).toEqual(['a', 'b', 'c']);
    expect(order(reorder(start, 'missing', 'front'))).toEqual(['a', 'b', 'c']);
  });

  it('fits a layout onto different paper without resizing the type', () => {
    const a5: PageGeometry = { ...A4, paperSize: 'A5' };
    const [fitted] = fitToPage([element({ id: 'a', x: 105, y: 148.5, w: 42, h: 20 })], A4, a5);

    // A5 is 148x210 against A4's 210x297 — a hair over 0.70 each way.
    expect(fitted?.x).toBeCloseTo(74, 0);
    expect(fitted?.w).toBeCloseTo(29.6, 0);

    // Type size is untouched: halving a body face to fit smaller paper produces
    // something nobody can read, so the operator changes it deliberately.
    expect(fitted?.kind === 'text' && fitted.style.size).toBe(8);
  });

  it('rounds to a tenth of a millimetre so a layout stops accumulating noise', () => {
    expect(tidy(12.34567)).toBe(12.3);
    expect(tidy(0.04)).toBe(0);
  });
});
