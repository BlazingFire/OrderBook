/**
 * Enter moves to the next field, and on the last one it saves. Escape walks
 * back one field, for screens that opt into it with `useEscapeToPrevious`.
 *
 * The shop's people came from a spreadsheet and an accounting package, and both
 * work this way. In a browser it normally does not, because Enter only means
 * anything inside a `<form>` — and `grep -rn "<form"` returns three hits across
 * both web apps. Every drawer and editor is bare `FormField`s.
 *
 * So this takes a **container ref, not a form**. Nothing gains a `<form>`
 * element to make it work: adding one would bring native submission, native
 * validation bubbles and a second Enter path with it, for a behaviour that is
 * four lines without.
 *
 * The walk is over **fields**, not over everything focusable. A row of Save,
 * Cancel and "use suggested" buttons sits between the last input and the end of
 * a form, and Enter over a button is a click — so walking into one both stopped
 * the advance dead and left the last field unable to reach `onSubmit`. Buttons
 * stay reachable by Tab, which is what Tab is for. A button that genuinely is a
 * step in the flow can opt back in with `data-field`; the New Lead screen marks
 * its "Change party" button that way, so Escape from the source select lands on
 * the party again after a party has been chosen and the search box it replaced
 * is gone.
 *
 * Two exclusions, both load-bearing:
 *
 *  · `<textarea>` keeps Enter, because Enter is a newline there.
 *  · Anything inside `[data-keys-grid]` is left alone. The line grid has its own
 *    two-dimensional Enter — down a column, not on to the next control — and
 *    this walking DOM order would send the caret across the row instead.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * What Enter and Escape step through: controls that hold a value, plus anything
 * a screen has explicitly marked as a step.
 */
const FIELDS = [
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[data-field]:not([disabled])',
].join(',');

function fieldsIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FIELDS)].filter(
    (element) => !element.closest('[data-keys-grid]'),
  );
}

/**
 * True once the native dropdown is actually open.
 *
 * `showPicker` is Chromium 121 and later, which every packaged panel is; jsdom
 * does not implement it at all. Both failures land here as `false`, and Enter
 * falls through to the plain advance rather than trapping the caret on a select
 * whose list never appeared.
 */
function openPicker(select: HTMLSelectElement): boolean {
  try {
    select.showPicker();
    return true;
  } catch {
    return false;
  }
}

export function useEnterToAdvance(
  containerRef: RefObject<HTMLElement | null>,
  /** What the last field's Enter runs. Usually the screen's save. */
  onSubmit?: () => void,
  /**
   * Re-attach when this flips.
   *
   * A dialog renders nothing while closed, so the ref is null on the first run
   * and the effect has nothing to bind to. Callers inside one pass their `open`
   * flag; everything else leaves it alone.
   */
  active: boolean = true,
): void {
  /*
   * The handler is held in a ref rather than listed as a dependency.
   *
   * Every call site passes a closure rebuilt on each render, so depending on it
   * would tear down and rebind a listener on every keystroke — the same defect
   * `useOverlay` documents, where the rebuild pulled focus out of the field
   * being typed in.
   */
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  /**
   * The select whose dropdown this hook has already opened.
   *
   * A select is two things behind one Enter: a list to open, and a field to
   * leave. The first Enter opens it, and the native popup then owns the arrow
   * keys, its own Enter and its own Escape — the page sees none of them while
   * it is up. The next Enter the page does see is therefore the one after the
   * popup closed, whether an option was taken or not, and that one advances.
   * Without this a select would be a dead end that reopens for ever.
   */
  const opened = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    const container = active ? containerRef.current : null;
    if (!container) return;

    // An arrow const, not a hoisted declaration: TypeScript only keeps the
    // `container` null-check above through a closure created after it.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      // A chord is somebody's shortcut, not a field advance.
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.tagName === 'TEXTAREA') return;
      // A button's Enter is a click. Intercepting it would make Save move the
      // caret instead of saving — and would stop a `data-field` button from
      // doing the thing it was put in the walk to do.
      if (target.tagName === 'BUTTON' || target.getAttribute('role') === 'button') return;
      if (target.closest('[data-keys-grid]')) return;
      if (!container.contains(target)) return;

      const fields = fieldsIn(container);
      const index = fields.indexOf(target);
      if (index < 0) return;

      event.preventDefault();

      if (target instanceof HTMLSelectElement && opened.current !== target && openPicker(target)) {
        opened.current = target;
        return;
      }
      opened.current = null;

      const next = fields[index + 1];
      if (next) next.focus();
      else submitRef.current?.();
    };

    // Leaving a select and coming back gives it a fresh first Enter, so a
    // person who stepped back with Escape can open the same list again.
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target !== opened.current) opened.current = null;
    };

    /*
     * On `document`, not on the container, and this is the whole reason the
     * hook works on a screen at all.
     *
     * React 17 and later attach one delegated listener to the app's root, so a
     * field's own `onKeyDown` runs when the event reaches that root — *above*
     * the container. A listener on the container therefore runs first and beats
     * the field to its own key: on New Lead that meant Enter walked past the
     * party search box instead of choosing the party highlighted in its list,
     * and `defaultPrevented` never had a chance to say so. From `document` the
     * order is right, and the existing check honours it. Same reason
     * `useOverlay` binds Escape where it does.
     */
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [containerRef, active]);
}

/**
 * Escape steps back one field — the other half of Enter's walk.
 *
 * Opt-in, and deliberately not folded into `useEnterToAdvance`, because inside
 * a Drawer or Modal Escape already means *close* (`useOverlay`). Consuming it
 * there to move a caret would take away the only key that dismisses a dialog.
 * A full screen has no such meaning for it, so screens ask for this and drawers
 * do not.
 *
 * On the first field Escape is left alone, so whatever is above it — an open
 * suggestion list, an overlay, the palette — still gets the key.
 */
export function useEscapeToPrevious(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean = true,
): void {
  useEffect(() => {
    const container = active ? containerRef.current : null;
    if (!container) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[data-keys-grid]')) return;
      if (!container.contains(target)) return;
      // A dialog rendered inside the container still owns Escape — closing it
      // is the only thing that key does there. Walking a caret back instead
      // would leave the overlay with no way out.
      if (target.closest('[role="dialog"]') !== container.closest('[role="dialog"]')) return;

      const fields = fieldsIn(container);
      const index = fields.indexOf(target);
      if (index <= 0) return;

      // `preventDefault` is how `useOverlay` and `KeyboardProvider` — also on
      // `document`, also running after this — are told the key was spent.
      event.preventDefault();
      fields[index - 1]?.focus();
    };

    // `document` for the same reason as above: a control with its own Escape,
    // such as a suggestion list closing itself, has to be heard first.
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [containerRef, active]);
}
