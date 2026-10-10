/**
 * The notification bell (`NotificationBell.tsx`) and `formatElapsed`, the
 * duration both panels' link notices are written with.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserNotification } from '@orderbook/shared';

import { formatElapsed } from '../src/format.js';
import { t } from '../src/i18n.js';
import { NotificationBell, type NotificationTransport } from '../src/NotificationBell.js';

afterEach(cleanup);

const OFFLINE: UserNotification = {
  id: 'n-1',
  kind: 'panel.offlineLong',
  params: { panel: 'Counter' },
  link: { kind: 'panel', id: 'panel-1' },
  createdAt: '2026-10-03T09:00:00.000Z',
  readAt: null,
};

const READ: UserNotification = {
  ...OFFLINE,
  id: 'n-2',
  params: { panel: 'Godown' },
  readAt: '2026-10-03T09:30:00.000Z',
};

function transport(
  items: UserNotification[] = [OFFLINE, READ],
  unreadCount = 1,
): NotificationTransport & { list: ReturnType<typeof vi.fn>; markRead: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => ({ items, unreadCount })),
    markRead: vi.fn(async () => ({ unreadCount: 0 })),
  };
}

const bell = (count: number) =>
  screen.getByRole('button', {
    name: count > 0 ? t('notification.unreadLabel', { count }) : t('notification.title'),
  });

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openBell(count: number): Promise<void> {
  await act(async () => {
    fireEvent.click(bell(count));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the notification bell', () => {
  it('shows the unread count, and lists newest-first notices as sentences', async () => {
    render(<NotificationBell transport={transport()} revision={0} />);
    await settle();

    expect(bell(1).textContent).toContain('1');
    await openBell(1);

    expect(screen.getByText(t('notification.panel.offlineLong', { panel: 'Counter' }))).toBeTruthy();
    expect(screen.getByText(t('notification.panel.offlineLong', { panel: 'Godown' }))).toBeTruthy();
  });

  it('marks everything read', async () => {
    const source = transport();
    render(<NotificationBell transport={source} revision={0} />);
    await settle();
    await openBell(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('notification.markAllRead') }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(source.markRead).toHaveBeenCalledWith({ all: true });
    expect(bell(0)).toBeTruthy();
  });

  it('opening a notice marks it read and follows its link', async () => {
    const source = transport();
    const onOpen = vi.fn();
    render(<NotificationBell transport={source} revision={0} onOpen={onOpen} />);
    await settle();
    await openBell(1);

    await act(async () => {
      fireEvent.click(screen.getByText(t('notification.panel.offlineLong', { panel: 'Counter' })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(source.markRead).toHaveBeenCalledWith({ ids: ['n-1'] });
    expect(onOpen).toHaveBeenCalledWith({ kind: 'panel', id: 'panel-1' });
    // It closed on the way.
    expect(screen.queryByRole('region', { name: t('notification.title') })).toBeNull();
  });

  it('does not mark an already-read notice again', async () => {
    const source = transport();
    render(<NotificationBell transport={source} revision={0} />);
    await settle();
    await openBell(1);

    await act(async () => {
      fireEvent.click(screen.getByText(t('notification.panel.offlineLong', { panel: 'Godown' })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(source.markRead).not.toHaveBeenCalled();
  });

  it('closes on Escape and on a click elsewhere', async () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <NotificationBell transport={transport()} revision={0} />
      </>,
    );
    await settle();
    const list = () => screen.queryByRole('region', { name: t('notification.title') });

    await openBell(1);
    expect(list()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(list()).toBeNull();

    await openBell(1);
    act(() => {
      fireEvent.mouseDown(screen.getByText('elsewhere'));
    });
    expect(list()).toBeNull();
  });

  it('says the list may be stale when it cannot be read, and keeps what it had', async () => {
    const source = transport();
    const view = render(<NotificationBell transport={source} revision={0} />);
    await settle();

    source.list.mockRejectedValue(new Error('unavailable'));
    view.rerender(<NotificationBell transport={source} revision={1} />);
    await settle();
    await openBell(1);

    expect(screen.getByText(t('notification.offlineNote'))).toBeTruthy();
    expect(screen.getByText(t('notification.panel.offlineLong', { panel: 'Counter' }))).toBeTruthy();
  });

  it('says so when there is nothing', async () => {
    render(<NotificationBell transport={transport([], 0)} revision={0} />);
    await settle();
    await openBell(0);

    expect(screen.getByText(t('notification.empty'))).toBeTruthy();
  });

  it("counts the panel's own notices and lists them first", async () => {
    render(
      <NotificationBell
        transport={transport([], 0)}
        revision={0}
        local={[{ id: 'local:offlineLong', text: 'No link for an hour', createdAt: OFFLINE.createdAt }]}
      />,
    );
    await settle();
    await openBell(1);

    expect(screen.getByText('No link for an hour')).toBeTruthy();
    expect(screen.queryByText(t('notification.empty'))).toBeNull();
  });

  it('reads the list again when the revision moves and when it is opened', async () => {
    const source = transport();
    const view = render(<NotificationBell transport={source} revision={0} />);
    await settle();
    expect(source.list).toHaveBeenCalledTimes(1);

    view.rerender(<NotificationBell transport={source} revision={1} />);
    await settle();
    expect(source.list).toHaveBeenCalledTimes(2);

    // A new transport object with the same behaviour is not a reason to read.
    view.rerender(<NotificationBell transport={{ ...source }} revision={1} />);
    await settle();
    expect(source.list).toHaveBeenCalledTimes(2);

    await openBell(1);
    expect(source.list).toHaveBeenCalledTimes(3);
  });
});

describe('the drawer (Notification kit)', () => {
  const FAILED: UserNotification = {
    id: 'b-1',
    kind: 'backup.autoFailed',
    params: {},
    link: null,
    createdAt: OFFLINE.createdAt,
    readAt: null,
  };

  it('filters by category, and turns the badge red while a needs-action notice is unread', async () => {
    const view = render(<NotificationBell transport={transport([OFFLINE, FAILED], 2)} revision={0} />);
    await settle();
    expect(view.container.querySelector('.ob-bell-badge--action')).not.toBeNull();
    await openBell(2);

    fireEvent.click(screen.getByRole('button', { name: `${t('notification.category.backup')} 1` }));
    expect(screen.getByText(t('notification.backup.autoFailed'))).toBeTruthy();
    expect(screen.queryByText(t('notification.panel.offlineLong', { panel: 'Counter' }))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `${t('notification.filter.all')} 2` }));
    expect(screen.getByText(t('notification.panel.offlineLong', { panel: 'Counter' }))).toBeTruthy();
  });

  it("offers the link's own action", async () => {
    const onOpen = vi.fn();
    render(<NotificationBell transport={transport()} revision={0} onOpen={onOpen} />);
    await settle();
    await openBell(1);

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: t('notification.open.panel') })[0]!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ kind: 'panel', id: 'panel-1' });
  });
});

describe('the Chatroom\'s notices', () => {
  const at = '2026-10-03T09:00:00.000Z';
  const notices: UserNotification[] = [
    { id: 'c-1', kind: 'chat.mention', params: { name: 'Bina', room: 'Dispatch desk' }, link: { kind: 'chat', id: 'room-1', messageId: 'CM1' }, createdAt: at, readAt: null },
    { id: 'c-2', kind: 'task.assigned', params: { name: 'Bina', room: 'Dispatch desk' }, link: { kind: 'chat', id: 'room-1' }, createdAt: at, readAt: null },
    { id: 'c-3', kind: 'task.done', params: { name: 'Chetan', room: 'Godown' }, link: { kind: 'chat', id: 'room-2' }, createdAt: at, readAt: null },
    { id: 'c-4', kind: 'access.requested', params: { name: 'Bina', capability: 'chat.tasks' }, link: { kind: 'role', id: 'RL1' }, createdAt: at, readAt: null },
  ];

  it('reads each kind as a sentence, with the requested right worded in the reader\'s language', async () => {
    render(<NotificationBell transport={transport(notices, 4)} revision={0} />);
    await settle();
    await openBell(4);

    expect(screen.getByText(t('notification.chat.mention', { name: 'Bina', room: 'Dispatch desk' }))).toBeTruthy();
    expect(screen.getByText(t('notification.task.assigned', { name: 'Bina', room: 'Dispatch desk' }))).toBeTruthy();
    expect(screen.getByText(t('notification.task.done', { name: 'Chetan', room: 'Godown' }))).toBeTruthy();
    expect(
      screen.getByText(t('notification.access.requested', { name: 'Bina', capability: t('permission.chat.tasks') })),
    ).toBeTruthy();
  });

  it('hands a chat or role link to the panel', async () => {
    const onOpen = vi.fn();
    render(<NotificationBell transport={transport(notices, 4)} revision={0} onOpen={onOpen} />);
    await settle();
    await openBell(4);

    await act(async () => {
      fireEvent.click(screen.getByText(t('notification.chat.mention', { name: 'Bina', room: 'Dispatch desk' })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onOpen).toHaveBeenCalledWith({ kind: 'chat', id: 'room-1', messageId: 'CM1' });
  });
});

describe('formatElapsed', () => {
  const MINUTE = 60_000;

  it('reads minutes under an hour, and hours with the minutes left over', () => {
    expect(formatElapsed(42 * MINUTE)).toBe(t('time.minutes.short', { count: 42 }));
    expect(formatElapsed(60 * MINUTE)).toBe(t('time.hours.short', { count: 1 }));
    expect(formatElapsed(65 * MINUTE + 30_000)).toBe(
      `${t('time.hours.short', { count: 1 })} ${t('time.minutes.short', { count: 5 })}`,
    );
  });

  it('never reads a negative or broken span', () => {
    expect(formatElapsed(-5 * MINUTE)).toBe(t('time.minutes.short', { count: 0 }));
    expect(formatElapsed(Number.NaN)).toBe(t('time.minutes.short', { count: 0 }));
  });
});
