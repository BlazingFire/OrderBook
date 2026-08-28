/**
 * Shared behaviour for Modal and Drawer: trap focus inside, restore it to the
 * trigger on close, and close on Esc — innermost overlay first (§10), decided
 * by document order rather than by event propagation (see the Escape branch
 * below for why propagation cannot do it).
 *
 * **`onClose` is held in a ref rather than listed as a dependency.** Every call
 * site passes a closure rebuilt on each render, so depending on it re-ran this
 * effect on every keystroke: the cleanup pulled focus back to the trigger
 * outside the overlay and the fresh run pushed it to the overlay's first
 * focusable — the header Close button, not the field being typed in. The caret
 * left the input after a single character, which made every drawer and modal
 * form in both panels impossible to fill in. `containerRef` is a stable
 * `useRef` object from Drawer/Modal, so the effect now runs exactly once per
 * open/close transition.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useOverlay(
  open: boolean,
  onClose: () => void,
  // `| null` because React 19 types `useRef<T>(null)` as `RefObject<T | null>`,
  // which is what every caller passes.
  containerRef: RefObject<HTMLElement | null>,
) {
  const restoreFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;

    // Anything the overlay itself already focused — a form's `autoFocus` field —
    // wins over the first focusable in DOM order, which is the Close button.
    if (!container?.contains(document.activeElement)) {
      const focusables = container?.querySelectorAll<HTMLElement>(FOCUSABLE);
      (focusables?.[0] ?? container)?.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // `stopPropagation` shields the window-level handler, but it cannot stop
        // the *other* listeners already bound to `document` itself — and the
        // outer overlay bound its one first, so it would run first and close
        // too. Deciding from document order instead lets only the topmost open
        // dialog act: a stacked Modal is either a descendant of the Drawer that
        // opened it or rendered after it in the same subtree, so in both cases
        // the innermost overlay is the last `[role="dialog"]` in the document.
        //
        // Visible ones only. Screens are now kept mounted and hidden by
        // `<Activity>`, which leaves their DOM in the document — so a hidden
        // pane's open Drawer, sitting later in the screens array, became the
        // "last dialog" and the visible overlay silently refused Escape.
        // Verified in Chromium: `checkVisibility()` is false inside a
        // `display:none` subtree. (jsdom does not implement it at all, so this
        // line cannot be unit-tested — see `ui/tests/activity-spike.test.tsx`.)
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((dialog) =>
          dialog.checkVisibility(),
        );
        if (container && dialogs[dialogs.length - 1] !== container) return;
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      // `items.length === 0` returned above, so both ends are present.
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      /*
       * Restore focus only to something still on screen.
       *
       * This cleanup now also runs when the screen is merely *hidden*, and
       * focusing an element inside a `display:none` subtree either does
       * nothing or drags focus somewhere invisible. `isConnected` catches a
       * removed node, `checkVisibility()` catches a hidden one.
       */
      const target = restoreFocus.current;
      if (target?.isConnected && target.checkVisibility()) target.focus();
      restoreFocus.current = null;
    };
  }, [open, containerRef]);
}
