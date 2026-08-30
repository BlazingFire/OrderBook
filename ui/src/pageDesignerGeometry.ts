/**
 * The page designer's arithmetic, with no React in it.
 *
 * Everything here is a pure function over millimetres, which is what the stored
 * layout speaks. The canvas converts to pixels once, at the edge, using a scale
 * it derives from the width it has been given — so the same layout draws
 * correctly in a 300px preview pane and a 1200px editor without any of this
 * knowing which it is in.
 *
 * Kept separate from the components because hit-testing, snapping and alignment
 * are where the bugs live, and a bug in arithmetic is much easier to find in a
 * unit test than through a mouse.
 */

import type { DocumentElement, PageGeometry } from '@orderbook/shared';
import { pageSizeMm } from '@orderbook/shared';

/** A rectangle in millimetres, which is every element's shape. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How many screen pixels one millimetre is worth.
 *
 * Derived from the space available rather than fixed, because the same canvas
 * has to serve a narrow preview beside a form and a full-width editor.
 */
export const scaleFor = (availablePx: number, pageWidthMm: number): number =>
  pageWidthMm > 0 ? availablePx / pageWidthMm : 1;

export const toPx = (mm: number, scale: number): number => mm * scale;
export const toMm = (px: number, scale: number): number => (scale > 0 ? px / scale : 0);

/** The page and its margin box, in millimetres, for the canvas to draw. */
export function pageFrame(geometry: PageGeometry): { page: Rect; margins: Rect } {
  const size = pageSizeMm(geometry.paperSize, geometry.orientation);

  return {
    page: { x: 0, y: 0, w: size.width, h: size.height },
    margins: {
      x: geometry.margins.left,
      y: geometry.margins.top,
      w: size.width - geometry.margins.left - geometry.margins.right,
      h: size.height - geometry.margins.top - geometry.margins.bottom,
    },
  };
}

export const rectOf = (element: DocumentElement): Rect => ({
  x: element.x,
  y: element.y,
  w: element.w,
  h: element.h,
});

/** Rounded to the tenth of a millimetre. Finer than anybody can place by hand,
 *  and it keeps a stored layout from accumulating float noise on every drag. */
export const tidy = (mm: number): number => Math.round(mm * 10) / 10;

export const tidyRect = (rect: Rect): Rect => ({
  x: tidy(rect.x),
  y: tidy(rect.y),
  w: tidy(rect.w),
  h: tidy(rect.h),
});

/**
 * Which element is under a point.
 *
 * Searched from the top of the paint order down, so a box drawn over another
 * picks up the click — the same answer the eye gives.
 */
export function hitTest(elements: readonly DocumentElement[], x: number, y: number): string | null {
  const ordered = [...elements].sort((a, b) => b.z - a.z);

  for (const element of ordered) {
    const inside =
      x >= element.x &&
      x <= element.x + element.w &&
      y >= element.y &&
      y <= element.y + Math.max(element.h, 1);

    if (inside) return element.id;
  }

  return null;
}

/** The eight resize grips plus the body. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

/**
 * Which grip a point is on, or `move` for the body, or null for outside.
 *
 * `grip` arrives in millimetres so the caller can keep the grab area a constant
 * number of *pixels* whatever the zoom — a 2mm grip is unusably small in a
 * thumbnail and comically large in a zoomed editor.
 */
export function handleAt(rect: Rect, x: number, y: number, grip: number): Handle | null {
  const nearLeft = Math.abs(x - rect.x) <= grip;
  const nearRight = Math.abs(x - (rect.x + rect.w)) <= grip;
  const nearTop = Math.abs(y - rect.y) <= grip;
  const nearBottom = Math.abs(y - (rect.y + rect.h)) <= grip;

  if (nearTop && nearLeft) return 'nw';
  if (nearTop && nearRight) return 'ne';
  if (nearBottom && nearLeft) return 'sw';
  if (nearBottom && nearRight) return 'se';

  const withinX = x >= rect.x - grip && x <= rect.x + rect.w + grip;
  const withinY = y >= rect.y - grip && y <= rect.y + rect.h + grip;

  if (nearTop && withinX) return 'n';
  if (nearBottom && withinX) return 's';
  if (nearLeft && withinY) return 'w';
  if (nearRight && withinY) return 'e';

  if (withinX && withinY) return 'move';
  return null;
}

/** The smallest an element may be dragged to. Below this it cannot be grabbed
 *  again, which is a trap rather than a feature. */
export const MIN_SIZE_MM = 3;

/** Apply a drag of `dx`/`dy` millimetres to a rect, for the grip being held. */
export function applyHandle(rect: Rect, handle: Handle, dx: number, dy: number): Rect {
  if (handle === 'move') return { ...rect, x: rect.x + dx, y: rect.y + dy };

  const next = { ...rect };

  if (handle.includes('w')) {
    const width = rect.w - dx;
    if (width >= MIN_SIZE_MM) {
      next.x = rect.x + dx;
      next.w = width;
    }
  }

  if (handle.includes('e')) next.w = Math.max(rect.w + dx, MIN_SIZE_MM);

  if (handle.includes('n')) {
    const height = rect.h - dy;
    if (height >= MIN_SIZE_MM) {
      next.y = rect.y + dy;
      next.h = height;
    }
  }

  if (handle.includes('s')) next.h = Math.max(rect.h + dy, MIN_SIZE_MM);

  return next;
}

/** Keep a rect on the paper. A layout whose elements have wandered off the
 *  sheet is refused on save, so the canvas never lets one get there. */
export function clampToPage(rect: Rect, page: Rect): Rect {
  const w = Math.min(rect.w, page.w);
  const h = Math.min(rect.h, page.h);

  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, 0), page.w - w),
    y: Math.min(Math.max(rect.y, 0), page.h - h),
  };
}

export interface Guide {
  axis: 'x' | 'y';
  /** Millimetres along that axis. */
  at: number;
}

/** How close, in millimetres, an edge has to come before it snaps. */
export const SNAP_MM = 1.5;

/**
 * Snap a dragged rect to the edges and centres of everything around it.
 *
 * Returns the adjusted rect and the guides that matched, so the canvas can draw
 * the lines it snapped to — a snap nobody can see reads as the drag being
 * inaccurate.
 */
export function snap(
  rect: Rect,
  others: readonly Rect[],
  page: Rect,
  margins: Rect,
  tolerance = SNAP_MM,
): { rect: Rect; guides: Guide[] } {
  const targetsX = [
    0,
    page.w,
    page.w / 2,
    margins.x,
    margins.x + margins.w,
    ...others.flatMap((other) => [other.x, other.x + other.w / 2, other.x + other.w]),
  ];
  const targetsY = [
    0,
    page.h,
    page.h / 2,
    margins.y,
    margins.y + margins.h,
    ...others.flatMap((other) => [other.y, other.y + other.h / 2, other.y + other.h]),
  ];

  const guides: Guide[] = [];
  const next = { ...rect };

  // Left, centre and right all compete; the closest match wins, so dragging a
  // box towards a column of others latches onto whichever edge you meant.
  const best = (
    edges: Array<{ value: number; shift: number }>,
    targets: number[],
  ): { at: number; delta: number } | null => {
    let found: { at: number; delta: number } | null = null;

    for (const edge of edges) {
      for (const target of targets) {
        const delta = target - edge.value;
        if (Math.abs(delta) > tolerance) continue;
        if (found && Math.abs(delta) >= Math.abs(found.delta)) continue;
        found = { at: target, delta: delta + edge.shift };
      }
    }

    return found;
  };

  const x = best(
    [
      { value: rect.x, shift: 0 },
      { value: rect.x + rect.w / 2, shift: 0 },
      { value: rect.x + rect.w, shift: 0 },
    ],
    targetsX,
  );
  if (x) {
    next.x = rect.x + x.delta;
    guides.push({ axis: 'x', at: x.at });
  }

  const y = best(
    [
      { value: rect.y, shift: 0 },
      { value: rect.y + rect.h / 2, shift: 0 },
      { value: rect.y + rect.h, shift: 0 },
    ],
    targetsY,
  );
  if (y) {
    next.y = rect.y + y.delta;
    guides.push({ axis: 'y', at: y.at });
  }

  return { rect: next, guides };
}

export type AlignEdge = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** Line a selection up. With one element selected the page is the reference,
 *  which is how "centre this on the page" works without a separate command. */
export function align(rects: readonly Rect[], edge: AlignEdge, page: Rect): Rect[] {
  if (rects.length === 0) return [];

  const reference =
    rects.length === 1
      ? page
      : {
          x: Math.min(...rects.map((r) => r.x)),
          y: Math.min(...rects.map((r) => r.y)),
          w: Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x)),
          h: Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y)),
        };

  return rects.map((rect) => {
    switch (edge) {
      case 'left':
        return { ...rect, x: reference.x };
      case 'right':
        return { ...rect, x: reference.x + reference.w - rect.w };
      case 'centre':
        return { ...rect, x: reference.x + (reference.w - rect.w) / 2 };
      case 'top':
        return { ...rect, y: reference.y };
      case 'bottom':
        return { ...rect, y: reference.y + reference.h - rect.h };
      case 'middle':
        return { ...rect, y: reference.y + (reference.h - rect.h) / 2 };
    }
  });
}

/** Even gaps between three or more, leaving the outermost two where they are. */
export function distribute(rects: readonly Rect[], axis: 'x' | 'y'): Rect[] {
  if (rects.length < 3) return [...rects];

  const size = axis === 'x' ? ('w' as const) : ('h' as const);
  const ordered = [...rects].sort((a, b) => a[axis] - b[axis]);

  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const span = last[axis] - first[axis];
  const occupied = ordered.slice(1, -1).reduce((sum, rect) => sum + rect[size], 0);
  const gap = (span - first[size] - occupied) / (ordered.length - 1);

  let cursor = first[axis] + first[size] + gap;

  return ordered.map((rect, index) => {
    if (index === 0 || index === ordered.length - 1) return rect;
    const placed = { ...rect, [axis]: cursor };
    cursor += rect[size] + gap;
    return placed;
  });
}

/**
 * Renumber paint order from zero after a reorder.
 *
 * Without this the numbers drift — bring-to-front by adding one to the maximum
 * works until somebody has done it four hundred times, and comparing a stored
 * layout against another becomes noise.
 */
export function renumber(elements: readonly DocumentElement[]): DocumentElement[] {
  return [...elements]
    .sort((a, b) => a.z - b.z)
    .map((element, index) => ({ ...element, z: index }));
}

export type ZMove = 'front' | 'forward' | 'backward' | 'back';

export function reorder(
  elements: readonly DocumentElement[],
  id: string,
  move: ZMove,
): DocumentElement[] {
  const ordered = [...elements].sort((a, b) => a.z - b.z);
  const index = ordered.findIndex((element) => element.id === id);
  if (index < 0) return [...elements];

  const [moved] = ordered.splice(index, 1);
  if (!moved) return [...elements];

  const target =
    move === 'front'
      ? ordered.length
      : move === 'back'
        ? 0
        : move === 'forward'
          ? Math.min(index + 1, ordered.length)
          : Math.max(index - 1, 0);

  ordered.splice(target, 0, moved);

  return ordered.map((element, position) => ({ ...element, z: position }));
}

/**
 * Scale a layout onto different paper.
 *
 * The answer to "I designed this on A4 and now I want A5". Positions and sizes
 * scale by the ratio of the two pages; type sizes do not, because halving a
 * body face to fit smaller paper produces something nobody can read. The
 * operator asks for this explicitly — nothing does it silently on a paper
 * change, which would move a design without saying so.
 */
export function fitToPage(
  elements: readonly DocumentElement[],
  from: PageGeometry,
  to: PageGeometry,
): DocumentElement[] {
  const before = pageSizeMm(from.paperSize, from.orientation);
  const after = pageSizeMm(to.paperSize, to.orientation);

  const sx = after.width / before.width;
  const sy = after.height / before.height;

  return elements.map((element) => ({
    ...element,
    x: tidy(element.x * sx),
    y: tidy(element.y * sy),
    w: tidy(element.w * sx),
    h: tidy(element.h * sy),
  }));
}
