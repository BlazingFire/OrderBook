/**
 * Requirement 4: a tab keeps what you left in it.
 *
 * Before this, both panels rendered exactly one screen — a `switch (tab)`
 * returning a single element — so navigating away unmounted the outgoing
 * screen and threw away its filters, its scroll position, its open drawer and
 * its half-typed form. Coming back re-fetched everything and started over.
 *
 * These tests pin the three behaviours the shell now depends on: state
 * survives a round trip, hiding runs effect cleanups (so a hidden screen holds
 * no live subscriptions), and the reset nonce genuinely remounts.
 */

import { useEffect, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ScreenHost, type ScreenSpec } from '../src/ScreenHost.js';

afterEach(cleanup);

/** Stands in for a real screen: some local state, and a live subscription. */
function Screen({ id, log }: { id: string; log: string[] }) {
  const [filter, setFilter] = useState('');

  useEffect(() => {
    log.push(`subscribe:${id}`);
    return () => {
      log.push(`unsubscribe:${id}`);
    };
  }, [id, log]);

  return (
    <div>
      <input
        data-testid={`filter-${id}`}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
    </div>
  );
}

function specs(log: string[]): ScreenSpec[] {
  return ['leads', 'orders'].map((id) => ({ id, render: () => <Screen id={id} log={log} /> }));
}

function typeInto(testId: string, value: string): void {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as object,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ScreenHost', () => {
  it('keeps a screen’s state across a tab round trip', async () => {
    const log: string[] = [];
    const { rerender } = render(<ScreenHost screens={specs(log)} activeId="leads" />);

    await act(async () => typeInto('filter-leads', 'morbi'));
    expect((screen.getByTestId('filter-leads') as HTMLInputElement).value).toBe('morbi');

    await act(async () => rerender(<ScreenHost screens={specs(log)} activeId="orders" />));
    await act(async () => rerender(<ScreenHost screens={specs(log)} activeId="leads" />));

    // The whole point: the filter is still there.
    expect((screen.getByTestId('filter-leads') as HTMLInputElement).value).toBe('morbi');
  });

  it('tears down a hidden screen’s subscriptions', async () => {
    const log: string[] = [];
    const { rerender } = render(<ScreenHost screens={specs(log)} activeId="leads" />);
    await act(async () => rerender(<ScreenHost screens={specs(log)} activeId="orders" />));

    // A hidden screen must not keep polling, listening or holding the filter
    // bar. This is what a hand-rolled `display:none` wrapper would not do.
    expect(log).toContain('unsubscribe:leads');
    expect(log).toContain('subscribe:orders');
  });

  it('only mounts a screen once it has been visited', () => {
    const log: string[] = [];
    render(<ScreenHost screens={specs(log)} activeId="leads" />);

    // Nothing fetches for a tab nobody has opened.
    expect(screen.queryByTestId('filter-orders')).toBeNull();
    expect(log).not.toContain('subscribe:orders');
  });

  it('renders the first visit in the same frame, with no blank pane', () => {
    const log: string[] = [];
    render(<ScreenHost screens={specs(log)} activeId="orders" />);

    // `visited` is updated during render rather than in an effect; an effect
    // would commit one frame with no pane at all — a visible flash on the
    // first visit to each of the fourteen master tabs.
    expect(screen.getByTestId('filter-orders')).toBeTruthy();
  });

  it('remounts a screen when its reset nonce changes, and leaves others alone', async () => {
    const log: string[] = [];
    const { rerender } = render(<ScreenHost screens={specs(log)} activeId="leads" />);

    await act(async () => typeInto('filter-leads', 'morbi'));
    await act(async () => rerender(<ScreenHost screens={specs(log)} activeId="orders" />));
    await act(async () => typeInto('filter-orders', 'rajkot'));
    await act(async () =>
      rerender(<ScreenHost screens={specs(log)} activeId="orders" resetNonce={{ orders: 1 }} />),
    );

    // Reset clears exactly the screen it was asked to.
    expect((screen.getByTestId('filter-orders') as HTMLInputElement).value).toBe('');

    await act(async () =>
      rerender(<ScreenHost screens={specs(log)} activeId="leads" resetNonce={{ orders: 1 }} />),
    );
    expect((screen.getByTestId('filter-leads') as HTMLInputElement).value).toBe('morbi');
  });
});
