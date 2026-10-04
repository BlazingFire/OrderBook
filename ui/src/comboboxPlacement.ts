/**
 * Where a combobox's list goes: below the field when there is room for it, above
 * when there is more room there, and never taller than the room it has.
 *
 * Pure, so the arithmetic is tested without a layout engine. The component measures
 * the field and the box that would clip the list (the dialog body, the table, the
 * window) and asks this.
 *
 * Why it exists. The list is `position: absolute` inside the field's wrapper, so
 * inside a scrolling dialog body a field near the bottom pushed the list past the
 * body's edge: the body grew a scrollbar, or the list was cut. `max-height: 40vh`
 * is a guess about the window, not about the room.
 */

export interface Span {
  top: number;
  bottom: number;
}

export interface ListboxPlacement {
  side: 'below' | 'above';
  /** Room on that side in pixels, or null when nothing could be measured (no layout). */
  room: number | null;
}

/** Below this the list is not worth opening on that side. */
const USEFUL_MIN = 144;
/** Never squeeze the list under this, even when both sides are tight (about three rows). */
const FLOOR = 96;
const GAP = 8;

export function placeListbox(field: Span, bounds: Span, wanted: number): ListboxPlacement {
  // jsdom, or a hidden subtree: every rectangle is zero. Leave the CSS defaults alone.
  if (bounds.bottom - bounds.top <= 0) return { side: 'below', room: null };

  const below = bounds.bottom - field.bottom - GAP;
  const above = field.top - bounds.top - GAP;

  if (below >= Math.min(wanted, USEFUL_MIN) || below >= above) {
    return { side: 'below', room: Math.max(Math.min(wanted, below), FLOOR) };
  }
  return { side: 'above', room: Math.max(Math.min(wanted, above), FLOOR) };
}

/**
 * The box that clips a list opened inside `element`: the nearest ancestor that scrolls or
 * clips vertically, narrowed to the window. Falls back to the window itself.
 */
export function clippingSpan(element: HTMLElement): Span {
  const window_ = { top: 0, bottom: element.ownerDocument.defaultView?.innerHeight ?? 0 };
  let node = element.parentElement;

  while (node && node !== element.ownerDocument.body) {
    const overflow = element.ownerDocument.defaultView?.getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') {
      const box = node.getBoundingClientRect();
      return { top: Math.max(box.top, window_.top), bottom: Math.min(box.bottom, window_.bottom) };
    }
    node = node.parentElement;
  }

  return window_;
}
