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

import { Component, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScreenHost, lazyScreen, liveBudget, type ScreenSpec } from '../src/ScreenHost.js';
import { SubNavProvider, useSubNav } from '../src/SubNavSlot.js';
import { t } from '../src/i18n.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  // Back to what jsdom reports: nothing.
  delete (navigator as { deviceMemory?: number }).deviceMemory;
});

function reportMemory(gigabytes: number): void {
  Object.defineProperty(navigator, 'deviceMemory', { value: gigabytes, configurable: true });
}

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

describe('ScreenHost on a small machine', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  /** A screen that holds a sidebar entry while `open` is set. */
  function Holding({ id, open }: { id: string; open: boolean }) {
    useSubNav(
      id,
      open
        ? {
            parentId: id,
            items: [{ id: `${id}.open`, label: 'Open', icon: 'edit' }],
            activeId: `${id}.open`,
          }
        : null,
    );
    return <Screen id={id} log={[]} />;
  }

  function host(activeId: string, holding: string | null = null) {
    const screens: ScreenSpec[] = [...ids, 'addLead', 'settings'].map((id) => ({
      id,
      render: () => <Holding id={id} open={id === holding} />,
    }));
    return (
      <SubNavProvider>
        <ScreenHost screens={screens} activeId={activeId} />
      </SubNavProvider>
    );
  }

  async function visit(
    rerender: (ui: ReactElement) => void,
    order: string[],
    holding: string | null = null,
  ) {
    for (const id of order) await act(async () => rerender(host(id, holding)));
  }

  it('keeps four screens alive when the browser does not report its memory', () => {
    // `navigator.deviceMemory` exists only in a secure context, and the Master
    // is opened over plain LAN http — so "unknown" must mean "small".
    expect(liveBudget()).toBe(4);
    reportMemory(4);
    expect(liveBudget()).toBe(4);
    reportMemory(8);
    expect(liveBudget()).toBe(8);
  });

  it('evicts the screen visited longest ago past the budget', async () => {
    const { rerender } = render(host('a'));
    await act(async () => typeInto('filter-a', 'morbi'));

    await visit(rerender, ['b', 'c', 'd', 'e']);
    expect(screen.queryByTestId('filter-a')).toBeNull();

    // Coming back starts it fresh.
    await visit(rerender, ['a']);
    expect((screen.getByTestId('filter-a') as HTMLInputElement).value).toBe('');
  });

  it('counts a return visit as recent, so the screen in use is not the one evicted', async () => {
    const { rerender } = render(host('a'));
    await act(async () => typeInto('filter-a', 'morbi'));
    await visit(rerender, ['b', 'c', 'a', 'd', 'e']);
    expect((screen.getByTestId('filter-a') as HTMLInputElement).value).toBe('morbi');
    expect(screen.queryByTestId('filter-b')).toBeNull();
  });

  it('keeps eight on a machine that reports more than 4 GB', async () => {
    reportMemory(8);
    const { rerender } = render(host('a'));
    await act(async () => typeInto('filter-a', 'morbi'));
    await visit(rerender, ['b', 'c', 'd', 'e']);
    await visit(rerender, ['a']);
    expect((screen.getByTestId('filter-a') as HTMLInputElement).value).toBe('morbi');
  });

  it('never evicts a screen holding a sidebar entry', async () => {
    const { rerender } = render(host('a', 'a'));
    await act(async () => typeInto('filter-a', 'half a draft'));
    await visit(rerender, ['b', 'c', 'd', 'e'], 'a');
    expect((screen.getByTestId('filter-a') as HTMLInputElement).value).toBe('half a draft');
  });

  it('never evicts New Order', async () => {
    const { rerender } = render(host('addLead'));
    await act(async () => typeInto('filter-addLead', 'morbi'));
    await visit(rerender, ['a', 'b', 'c', 'd', 'e']);
    expect((screen.getByTestId('filter-addLead') as HTMLInputElement).value).toBe('morbi');
  });

  it('never evicts Settings, whose unsaved drafts live in its rows', async () => {
    const { rerender } = render(host('settings'));
    await act(async () => typeInto('filter-settings', '45'));
    await visit(rerender, ['a', 'b', 'c', 'd', 'e']);
    expect((screen.getByTestId('filter-settings') as HTMLInputElement).value).toBe('45');
  });
});

describe('ScreenHost rendering', () => {
  it('does not re-render a hidden screen when the shell re-renders', async () => {
    const calls = { leads: 0, orders: 0 };
    const specsCounting = (): ScreenSpec[] =>
      (['leads', 'orders'] as const).map((id) => ({
        id,
        render: () => {
          calls[id] += 1;
          return <div data-testid={`pane-${id}`} />;
        },
      }));

    const { rerender } = render(<ScreenHost screens={specsCounting()} activeId="leads" />);
    await act(async () => rerender(<ScreenHost screens={specsCounting()} activeId="orders" />));
    const hiddenRenders = calls.leads;

    // New closures every time, as a real shell hands over.
    await act(async () => rerender(<ScreenHost screens={specsCounting()} activeId="orders" />));
    await act(async () => rerender(<ScreenHost screens={specsCounting()} activeId="orders" />));
    expect(calls.leads).toBe(hiddenRenders);

    // And it catches up the moment it is shown.
    await act(async () => rerender(<ScreenHost screens={specsCounting()} activeId="leads" />));
    expect(calls.leads).toBeGreaterThan(hiddenRenders);
  });

  it('shows the loading mark while a lazy screen arrives, then the screen', async () => {
    let arrive!: () => void;
    const loaded = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const Lazy = lazyScreen(
      () => loaded.then(() => ({ LogsScreen: ({ title }: { title: string }) => <h2>{title}</h2> })),
      'LogsScreen',
    );

    render(
      <ScreenHost
        screens={[{ id: 'logs', render: () => <Lazy title="Activity log" /> }]}
        activeId="logs"
      />,
    );
    expect(screen.getByText(t('common.loading'))).toBeTruthy();

    await act(async () => arrive());
    expect(await screen.findByText('Activity log')).toBeTruthy();
    expect(screen.queryByText(t('common.loading'))).toBeNull();
  });

  describe('a lazy screen whose chunk is gone (a tab left open across an update)', () => {
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      override render() {
        return this.state.failed ? <p>boundary</p> : this.props.children;
      }
    }

    const renderMissing = (): void => {
      const Lazy = lazyScreen<'LogsScreen', object>(
        () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
        'LogsScreen',
      );
      render(
        <Boundary>
          <ScreenHost screens={[{ id: 'logs', render: () => <Lazy /> }]} activeId="logs" />
        </Boundary>,
      );
    };

    it('reloads once, staying on the loading mark rather than the error screen', async () => {
      // jsdom does not implement reload; it only reports that it was asked.
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderMissing();
      await vi.waitFor(() => expect(sessionStorage.getItem('ob.chunkReload')).toBeTruthy());
      expect(screen.queryByText('boundary')).toBeNull();
      expect(screen.getByText(t('common.loading'))).toBeTruthy();
    });

    it('sends a second failure within a minute to the screen’s error boundary, not another reload', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      sessionStorage.setItem('ob.chunkReload', String(Date.now()));
      renderMissing();
      // The screen's own boundary answers (Try again, Reload), so the rest of the window stays up.
      expect(await screen.findByTestId('screen-crash')).toBeTruthy();
    });

    it('reloads again for a later update, though no lazy screen cleared the mark', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const stale = String(Date.now() - 5 * 60_000);
      sessionStorage.setItem('ob.chunkReload', stale);
      renderMissing();
      await vi.waitFor(() => expect(sessionStorage.getItem('ob.chunkReload')).not.toBe(stale));
      expect(screen.queryByText('boundary')).toBeNull();
    });
  });
});
