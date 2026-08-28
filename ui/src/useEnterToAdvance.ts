/**
 * Enter moves to the next field, and on the last one it saves.
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
 * Two exclusions, both load-bearing:
 *
 *  · `<textarea>` keeps Enter, because Enter is a newline there.
 *  · Anything inside `[data-keys-grid]` is left alone. The line grid has its own
 *    two-dimensional Enter — down a column, not on to the next control — and
 *    this walking DOM order would send the caret across the row instead.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { FOCUSABLE } from './useOverlay';

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
      // caret instead of saving.
      if (target.tagName === 'BUTTON' || target.getAttribute('role') === 'button') return;
      if (target.closest('[data-keys-grid]')) return;
      if (!container.contains(target)) return;

      const fields = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.closest('[data-keys-grid]'),
      );
      const index = fields.indexOf(target);
      if (index < 0) return;

      event.preventDefault();

      const next = fields[index + 1];
      if (next) next.focus();
      else submitRef.current?.();
    };

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [containerRef, active]);
}
