/**
 * Keeps every screen you have visited alive, so coming back to a tab shows
 * what you left rather than a fresh one.
 *
 * The panels used to render exactly one screen — a `switch (tab)` returning a
 * single element — so navigating away unmounted it and threw away everything
 * it held: filters, scroll position, an open drawer, a half-typed form, a
 * pagination cursor. The Access screen alone carries 41 `useState`s and the
 * Fields screen 50. Coming back re-fetched all of it and started over.
 *
 * `<Activity mode="hidden">` is what makes this affordable. It keeps the
 * component's state and its DOM but **runs its effect cleanups**, so a hidden
 * screen has no live subscriptions, no timers and no polling — and the four
 * slot providers (filter bar, keyboard commands, sub-nav, topbar actions) see it
 * withdraw exactly as if it had unmounted. A hand-rolled `display:none`
 * wrapper would have kept every hidden screen fully live, which is worse than
 * the problem it solves. See `ui/tests/activity-spike.test.tsx` for the
 * behaviour actually verified.
 *
 * Two consequences are load-bearing and handled elsewhere:
 *  · a hidden pane's DOM is still in the document, so `useOverlay` filters its
 *    `[role="dialog"]` query by visibility, or a hidden screen's open dialog
 *    steals Escape from the visible one;
 *  · effect teardown no longer means "gone for good", so `useSubNav` keeps a
 *    registry per screen rather than clearing itself on cleanup.
 */

import { Activity, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface ScreenSpec {
  id: string;
  render: () => ReactNode;
}

export function ScreenHost({
  screens,
  activeId,
  resetNonce = {},
}: {
  screens: ScreenSpec[];
  activeId: string;
  /** Bump a screen's entry to remount it — see `ResetSlot`. */
  resetNonce?: Record<string, number>;
}) {
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([activeId]));

  /*
   * Updated during render, not in an effect.
   *
   * An effect would commit a frame in which the newly-selected screen is not
   * in `visited` and therefore renders nothing — a blank flash on the first
   * visit to each of the fourteen master tabs and nine office ones. React
   * re-renders before painting when state is set during render, so this
   * costs a render pass and no frame.
   */
  if (!visited.has(activeId) && screens.some((screen) => screen.id === activeId)) {
    setVisited(new Set(visited).add(activeId));
  }

  return (
    <>
      {screens
        .filter((screen) => visited.has(screen.id))
        .map((screen) => (
          <Activity
            // The nonce is part of the key, so bumping it is a remount and
            // therefore a total reset with no per-screen cooperation.
            key={`${screen.id}:${resetNonce[screen.id] ?? 0}`}
            mode={screen.id === activeId ? 'visible' : 'hidden'}
          >
            <ScreenPane active={screen.id === activeId}>{screen.render()}</ScreenPane>
          </Activity>
        ))}
    </>
  );
}

/**
 * One screen's scroll container, which remembers where it was.
 *
 * `<Activity>` preserves state but not the DOM's own scroll offset, and the
 * ref survives the hide — so the position is captured on the way out and put
 * back on the way in.
 */
function ScreenPane({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const wasActive = useRef(active);

  if (wasActive.current !== active) {
    if (active) {
      // Restore after this commit paints, or the element is still hidden and
      // assigning `scrollTop` silently does nothing.
      queueMicrotask(() => {
        if (ref.current) ref.current.scrollTop = offset.current;
      });
    } else if (ref.current) {
      offset.current = ref.current.scrollTop;
    }
    wasActive.current = active;
  }

  return (
    <div className="ob-pane" ref={ref}>
      {children}
    </div>
  );
}
