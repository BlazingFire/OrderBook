/**
 * Does `<Activity>` actually do what the keep-alive design assumes?
 *
 * Requirement 4 — a tab keeping its state when you navigate away and back —
 * rests entirely on this component, and so does the sub-nav registry, the
 * Escape arbitration in `useOverlay`, and every `revision`-keyed refetch. The
 * whole design turns on one specific behaviour: a hidden pane keeps its state
 * but **tears its effects down**. If it merely hid the DOM, every mounted
 * screen would keep its subscriptions and its polling alive and the slots
 * would fight over who owns the filter bar.
 *
 * So this is a spike, run before anything is scheduled around it, rather than
 * a promise repeated from the release notes.
 */

import { Activity, useEffect, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

// Explicit, because Testing Library's automatic cleanup hooks itself onto
// global `afterEach`, and this suite does not run with `globals: true`.
afterEach(cleanup);

/** Records mount/unmount so the test can see effect teardown from outside. */
function Pane({ id, log }: { id: string; log: string[] }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    log.push(`mount:${id}`);
    return () => {
      log.push(`unmount:${id}`);
    };
  }, [id, log]);

  return (
    <div>
      <span data-testid={`count-${id}`}>{count}</span>
      <button data-testid={`bump-${id}`} onClick={() => setCount((c) => c + 1)}>
        bump
      </button>
    </div>
  );
}

function Host({ active, log }: { active: string; log: string[] }) {
  return (
    <>
      {['a', 'b'].map((id) => (
        <Activity key={id} mode={active === id ? 'visible' : 'hidden'}>
          <Pane id={id} log={log} />
        </Activity>
      ))}
    </>
  );
}

describe('<Activity> — the assumption Stage 5 rests on', () => {
  it('exists as a stable export', () => {
    expect(Activity).toBeDefined();
  });

  it('keeps a hidden pane’s state, and tears its effects down', async () => {
    const log: string[] = [];
    const { rerender } = render(<Host active="a" log={log} />);

    // Both panes render; only the visible one has live effects.
    await act(async () => {
      screen.getByTestId('bump-a').click();
      screen.getByTestId('bump-a').click();
    });
    expect(screen.getByTestId('count-a').textContent).toBe('2');

    // Navigate away.
    await act(async () => rerender(<Host active="b" log={log} />));

    // The load-bearing claim: hiding ran the cleanup.
    expect(log).toContain('unmount:a');

    // …and the state survived it, which is the whole feature.
    await act(async () => rerender(<Host active="a" log={log} />));
    expect(screen.getByTestId('count-a').textContent).toBe('2');

    // Coming back re-ran the effect, so a screen can still refetch on show.
    expect(log.filter((entry) => entry === 'mount:a')).toHaveLength(2);
  });

  /**
   * The hidden pane's nodes stay in the document. That is what makes
   * `useOverlay` wrong today: it decides the innermost dialog with
   * `querySelectorAll('[role="dialog"]')` and takes the last one, so a hidden
   * pane's open Drawer sitting later in the screens array steals Escape from
   * the visible one.
   *
   * **jsdom cannot check the other half of this.** jsdom 25 does not implement
   * `Element.checkVisibility` at all — it is `undefined`, not merely
   * inaccurate — and `getComputedStyle().display` returns `''` for an element
   * hidden by an ancestor. So the visibility filter that fixes the bug cannot
   * be unit-tested here and was instead verified by hand in Chromium, where
   * `checkVisibility()` returns false inside a `display:none` subtree and the
   * filter picks the visible dialog. Anything asserting on visibility in this
   * environment would be asserting on a stub.
   */
  it('keeps the hidden pane in the document, which is why Escape needs a filter', () => {
    const log: string[] = [];
    render(<Host active="a" log={log} />);

    expect(screen.getByTestId('count-b')).toBeTruthy();
    expect(document.querySelectorAll('[data-testid^="count-"]')).toHaveLength(2);
  });
});
