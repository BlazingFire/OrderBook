/**
 * The kit's own chrome speaks the reader's language.
 *
 * Every string below used to be an English literal in `ui/src` — the sidebar's
 * name and collapse control, a dialog's Close, a toast's Dismiss, the pagers,
 * the busy mark, a Copy button, a redacted cell, an empty combobox, the sync
 * rail — so a Hindi panel read English on exactly the controls both panels
 * share. Each case renders the component under `hi` and checks it against the
 * catalogue, and the last checks English still reads as it did.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HI_MESSAGES, type MessageKey } from '@orderbook/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppShell } from '../src/AppShell.js';
import { BusyMark } from '../src/BusyMark.js';
import { Combobox } from '../src/Combobox.js';
import { LoadMorePager, NewerOlderPager } from '../src/CursorPager.js';
import { IdField } from '../src/DataDisplay.js';
import { DataTable } from '../src/DataTable.js';
import { Modal } from '../src/Modal.js';
import { ErrorState } from '../src/States.js';
import { ToastProvider, useToast } from '../src/Toast.js';

const hi = (key: MessageKey): string => HI_MESSAGES[key];

beforeAll(() => {
  // jsdom implements neither. `useOverlay` calls the first when a Modal
  // closes, and DataTable measures itself with the second; neither is what
  // this file is about, so both are the plainest stand-ins that let them run.
  Element.prototype.checkVisibility ??= () => true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => window.localStorage.setItem('ob.locale', 'hi'));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function shell(collapsed: boolean) {
  return (
    <AppShell
      groups={[
        { label: 'Work', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }] },
      ]}
      activeId="dashboard"
      onNavigate={() => undefined}
      collapsed={collapsed}
      onToggleCollapsed={() => undefined}
      topbar={null}
      footer={null}
      rail="synced"
      railLabel="Synced"
      onRailClick={() => undefined}
    >
      <div />
    </AppShell>
  );
}

function ToastButton() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.push('Saved')}>
      push
    </button>
  );
}

describe('the kit in Hindi', () => {
  it('names the sidebar, its collapse control and the sync rail', () => {
    const { rerender } = render(shell(false));
    expect(screen.getByRole('navigation').getAttribute('aria-label')).toBe(hi('nav.modules'));
    expect(screen.getByRole('button', { name: hi('nav.collapseSidebar') }).textContent).toContain(
      hi('nav.collapse'),
    );
    expect(
      screen.getByRole('button', { name: hi('sync.statusLabel').replace('{status}', 'Synced') }),
    ).toBeTruthy();

    rerender(shell(true));
    expect(screen.getByRole('button', { name: hi('nav.expandSidebar') })).toBeTruthy();
  });

  it('labels a dialog’s header controls', () => {
    render(
      <Modal open onClose={() => undefined} title="Party" onToggleExpand={() => undefined}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: hi('modal.close') })).toBeTruthy();
    expect(screen.getByRole('button', { name: hi('modal.expand') })).toBeTruthy();
  });

  it('labels the shrink control of an expanded dialog', () => {
    render(
      <Modal open expanded onClose={() => undefined} title="Party" onToggleExpand={() => undefined}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: hi('modal.shrink') })).toBeTruthy();
  });

  it('labels a toast’s dismiss button', () => {
    render(
      <ToastProvider>
        <ToastButton />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    expect(screen.getByRole('button', { name: hi('toast.dismiss') })).toBeTruthy();
  });

  it('labels both pagers', () => {
    render(
      <>
        <LoadMorePager hasMore onLoadMore={() => undefined} />
        <NewerOlderPager hasNewer hasOlder onNewer={() => undefined} onOlder={() => undefined} />
      </>,
    );
    expect(screen.getByRole('button', { name: hi('common.loadMore') })).toBeTruthy();
    expect(screen.getByRole('button', { name: hi('common.newer') })).toBeTruthy();
    expect(screen.getByRole('button', { name: hi('common.older') })).toBeTruthy();
  });

  it('announces the busy mark, and stays silent when told to', () => {
    render(
      <>
        <BusyMark />
        <BusyMark label="" />
      </>,
    );
    expect(screen.getAllByRole('status').map((node) => node.getAttribute('aria-label'))).toEqual([
      hi('common.working'),
    ]);
  });

  it('labels the Copy button, a redacted cell, an empty combobox and a retry', () => {
    render(
      <>
        <IdField value="c0ffee" />
        <DataTable
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (row: { id: string }) => row.id,
              redactedReason: () => 'parties.view',
            },
          ]}
          rows={[{ id: 'p1' }]}
          rowKey={(row) => row.id}
        />
        <Combobox options={[]} onSelect={() => undefined} placeholder="Party" />
        <ErrorState title="Could not load" onAction={() => undefined} />
      </>,
    );

    expect(screen.getByRole('button', { name: hi('common.copy') })).toBeTruthy();

    const redacted = document.querySelector('.ob-redacted');
    expect(redacted?.getAttribute('aria-label')).toBe(hi('table.redacted'));
    expect(redacted?.getAttribute('title')).toBe(
      hi('table.redactedReason').replace('{permission}', 'parties.view'),
    );

    fireEvent.focus(screen.getByPlaceholderText('Party'));
    expect(screen.getByText(hi('common.noMatches'))).toBeTruthy();

    expect(screen.getByRole('button', { name: hi('action.retryNow') })).toBeTruthy();
  });
});

describe('the kit in English', () => {
  it('reads exactly as it did before the strings moved into the catalogue', () => {
    window.localStorage.setItem('ob.locale', 'en');
    render(
      <>
        {shell(false)}
        <Modal open onClose={() => undefined} title="Party" onToggleExpand={() => undefined}>
          <p>body</p>
        </Modal>
        <LoadMorePager hasMore onLoadMore={() => undefined} />
        <NewerOlderPager hasNewer hasOlder onNewer={() => undefined} onOlder={() => undefined} />
        <BusyMark />
        <IdField value="c0ffee" />
      </>,
    );

    expect(screen.getByRole('navigation').getAttribute('aria-label')).toBe('Modules');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' }).textContent).toContain(
      'Collapse',
    );
    expect(screen.getByRole('button', { name: 'Sync status: Synced' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open full width' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Newer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Older' })).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Working');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
