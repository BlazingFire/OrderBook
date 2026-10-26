/**
 * The kit's own chrome comes from the message catalogue.
 *
 * Every string below used to be an English literal in `ui/src` — the sidebar's
 * name and collapse control, a dialog's Close, a toast's Dismiss, the pagers,
 * the busy mark, a Copy button, a redacted cell, an empty combobox, the sync
 * rail. Each case renders the component and checks it against the catalogue
 * entry, and the last checks the words read as they always did.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EN_MESSAGES, type MessageKey } from '@orderbook/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppShell } from '../src/AppShell.js';
import { BusyMark } from '../src/BusyMark.js';
import { Combobox } from '../src/Combobox.js';
import { LoadMorePager, NewerOlderPager } from '../src/CursorPager.js';
import { IdField } from '../src/DataDisplay.js';
import { DataTable } from '../src/DataTable.js';
import { Modal } from '../src/Modal.js';
import { ErrorState } from '../src/States.js';
import { ToastProvider, useToast } from '../src/Toast.js';

function en(key: MessageKey): string {
  const text = EN_MESSAGES[key];
  expect(text, `${key} is not in the catalogue`).toBeTruthy();
  return text;
}

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

describe('the kit reads its words from the catalogue', () => {
  it('names the sidebar, its collapse control and the sync rail', () => {
    const { rerender } = render(shell(false));
    expect(screen.getByRole('navigation').getAttribute('aria-label')).toBe(en('nav.modules'));
    expect(screen.getByRole('button', { name: en('nav.collapseSidebar') }).textContent).toContain(
      en('nav.collapse'),
    );
    expect(
      screen.getByRole('button', { name: en('sync.statusLabel').replace('{status}', 'Synced') }),
    ).toBeTruthy();

    rerender(shell(true));
    expect(screen.getByRole('button', { name: en('nav.expandSidebar') })).toBeTruthy();
  });

  it('labels a dialog’s header controls', () => {
    render(
      <Modal open onClose={() => undefined} title="Party" onToggleExpand={() => undefined}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: en('modal.close') })).toBeTruthy();
    expect(screen.getByRole('button', { name: en('modal.expand') })).toBeTruthy();
  });

  it('labels the shrink control of an expanded dialog', () => {
    render(
      <Modal open expanded onClose={() => undefined} title="Party" onToggleExpand={() => undefined}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: en('modal.shrink') })).toBeTruthy();
  });

  it('labels a toast’s dismiss button', () => {
    render(
      <ToastProvider>
        <ToastButton />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    expect(screen.getByRole('button', { name: en('toast.dismiss') })).toBeTruthy();
    // Not the word the catalogue uses for Delete: a screen reader would
    // announce the button that only closes the toast as deleting something.
    expect(en('toast.dismiss')).not.toBe(en('common.delete'));
    expect(en('toast.dismiss')).not.toBe(en('action.delete'));
  });

  it('labels both pagers', () => {
    render(
      <>
        <LoadMorePager hasMore onLoadMore={() => undefined} />
        <NewerOlderPager hasNewer hasOlder onNewer={() => undefined} onOlder={() => undefined} />
      </>,
    );
    expect(screen.getByRole('button', { name: en('common.loadMore') })).toBeTruthy();
    expect(screen.getByRole('button', { name: en('common.newer') })).toBeTruthy();
    expect(screen.getByRole('button', { name: en('common.older') })).toBeTruthy();
  });

  it('announces the busy mark, and stays silent when told to', () => {
    render(
      <>
        <BusyMark />
        <BusyMark label="" />
      </>,
    );
    expect(screen.getAllByRole('status').map((node) => node.getAttribute('aria-label'))).toEqual([
      en('common.working'),
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

    expect(screen.getByRole('button', { name: en('common.copy') })).toBeTruthy();

    const redacted = document.querySelector('.ob-redacted');
    expect(redacted?.getAttribute('aria-label')).toBe(en('table.redacted'));
    expect(redacted?.getAttribute('title')).toBe(
      en('error.forbidden.missingPermission').replace('{permission}', 'parties.view'),
    );

    fireEvent.focus(screen.getByPlaceholderText('Party'));
    expect(screen.getByText(en('common.noMatches'))).toBeTruthy();

    expect(screen.getByRole('button', { name: en('action.retryNow') })).toBeTruthy();
  });
});

describe('the kit reads as it always did', () => {
  it('reads exactly as it did before the strings moved into the catalogue', () => {
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
    expect(screen.getByRole('status', { name: 'Working' }).getAttribute('aria-label')).toBe('Working');
    // IdField renders the shared CopyButton (icon-only, named "Copy").
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(en('common.copied')).toBe('Copied');
    expect(en('common.copyFailed')).toBe('Could not copy');
    expect(en('common.clearSearch')).toBe('Clear search');
  });
});
