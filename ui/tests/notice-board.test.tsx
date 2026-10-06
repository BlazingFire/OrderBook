/**
 * The notice board screens (Oct 7, U4 U5): the reading view, the Dashboard card, the management view
 * and the Master's wrappers around them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentType } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notice, NoticeInput, NoticeReaders, NoticeUpdate } from '@orderbook/shared';

import { configureUi } from '../src/config.js';
import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { boardNotices, NoticeBoardView } from '../src/NoticeBoardView.js';
import { cardNotices, NoticeDashboardCard } from '../src/NoticeDashboardCard.js';
import { manageOrder, NoticeManageView } from '../src/NoticeManageView.js';
import { installBrowserStubs, json, routeFetch } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(cleanup);

function notice(id: string, over: Partial<Notice> = {}): Notice {
  return {
    id,
    tenantId: 't1',
    title: `Notice ${id}`,
    body: `Body of ${id}`,
    priority: 'normal',
    pinned: false,
    showUntil: null,
    audience: { kind: 'all' },
    authorId: 'u1',
    authorName: 'Asha Rao',
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    version: 1,
    ...over,
  };
}

const READ = { readByMe: true };
const UNREAD = { readByMe: false };

describe('the order of the board', () => {
  it('puts pinned first, then important, then newest, and leaves out what has expired', () => {
    const list = [
      notice('old', { createdAt: '2026-10-01T00:00:00.000Z' }),
      notice('new', { createdAt: '2026-10-06T00:00:00.000Z' }),
      notice('imp', { priority: 'important', createdAt: '2026-10-02T00:00:00.000Z' }),
      notice('pin', { pinned: true, createdAt: '2026-09-01T00:00:00.000Z' }),
      notice('gone', { showUntil: '2026-10-03' }),
    ];
    expect(boardNotices(list, '2026-10-07').map((n) => n.id)).toEqual(['pin', 'imp', 'new', 'old']);
    // The last day is still a day it is shown.
    expect(boardNotices([notice('last', { showUntil: '2026-10-07' })], '2026-10-07')).toHaveLength(1);
  });

  it('lists on the Dashboard only the important and pinned ones, unread first, at most the limit', () => {
    const list = [
      notice('plain', UNREAD),
      notice('imp-read', { priority: 'important', ...READ }),
      notice('pin-unread', { pinned: true, ...UNREAD }),
      notice('imp-unread', { priority: 'important', ...UNREAD }),
      notice('imp-old', { priority: 'important', showUntil: '2026-10-01', ...UNREAD }),
    ];
    const ids = cardNotices(list, '2026-10-07', 3).map((n) => n.id);
    expect(ids).toEqual(['pin-unread', 'imp-unread', 'imp-read']);
    expect(ids).not.toContain('plain');
    expect(ids).not.toContain('imp-old');
    expect(cardNotices(list, '2026-10-07', 1)).toHaveLength(1);
  });
});

describe('NoticeBoardView', () => {
  function board(over: Partial<Parameters<typeof NoticeBoardView>[0]> = {}) {
    const marked: string[][] = [];
    const all = vi.fn();
    render(
      <NoticeBoardView
        notices={[notice('a', UNREAD), notice('b', { priority: 'important', ...READ })]}
        unreadCount={1}
        online
        onMarkRead={(ids) => void marked.push(ids)}
        onMarkAllRead={all}
        today="2026-10-07"
        {...over}
      />,
    );
    return { marked, all };
  }

  it('shows each notice with its text, who wrote it, what is unread and what is important', () => {
    board();
    expect(screen.getByText('Notice a')).toBeTruthy();
    expect(screen.getByText('Body of a')).toBeTruthy();
    expect(screen.getAllByText(/Asha Rao/).length).toBe(2);
    expect(screen.getByText(t('notices.priority.important'))).toBeTruthy();
    expect(screen.getByText(t('notices.board.unread', { count: 1 }))).toBeTruthy();
    // Only the unread one offers Mark as read.
    expect(screen.getAllByRole('button', { name: t('notices.board.markRead') })).toHaveLength(1);
  });

  it('marks one notice read, and all of them', async () => {
    const { marked, all } = board();
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markRead') }));
    await waitFor(() => expect(marked).toEqual([['a']]));
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markAllRead') }));
    await waitFor(() => expect(all).toHaveBeenCalledTimes(1));
  });

  it('says so, and will not mark anything, when the Master cannot be reached', () => {
    const { marked } = board({ online: false });
    expect(screen.getByText(t('notices.board.offlineNote'))).toBeTruthy();
    const mark = screen.getByRole('button', { name: t('notices.board.markRead') }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('notices.board.markAllRead') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(mark);
    expect(marked).toEqual([]);
  });

  it('says the board is up to date, and that it is empty', () => {
    board({ notices: [notice('r', READ)], unreadCount: 0 });
    expect(screen.getByText(t('notices.board.upToDate'))).toBeTruthy();
    cleanup();
    board({ notices: [], unreadCount: 0 });
    expect(screen.getByText(t('notices.board.emptyTitle'))).toBeTruthy();
  });

  it('keeps a notice past its last day off the board when the screen was left open overnight', () => {
    board({ notices: [notice('stale', { showUntil: '2026-10-06', ...READ })], unreadCount: 0 });
    expect(screen.queryByText('Notice stale')).toBeNull();
  });

  it('shows plain text only: markup in a notice is text, not elements', () => {
    board({ notices: [notice('x', { title: '<b>Bold</b>', body: '<img src=x onerror=alert(1)>', ...READ })], unreadCount: 0 });
    expect(screen.getByText('<b>Bold</b>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('h2 b')).toBeNull();
  });

  it('folds a long text behind Show more', () => {
    board({ notices: [notice('long', { body: 'word '.repeat(200), ...READ })], unreadCount: 0 });
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.showMore') }));
    expect(screen.getByRole('button', { name: t('notices.board.showLess') })).toBeTruthy();
  });

  it('shows a failed mark-as-read above the list, which stays', () => {
    board({ actionError: 'Master said no' });
    expect(screen.getByText('Master said no')).toBeTruthy();
    expect(screen.getByText('Notice a')).toBeTruthy();
  });
});

describe('NoticeDashboardCard', () => {
  it('draws nothing when there is nothing important or pinned', () => {
    const { container } = render(<NoticeDashboardCard notices={[notice('plain', UNREAD)]} onOpen={() => undefined} />);
    expect(container.textContent).toBe('');
  });

  it('lists the important and pinned notices, counts the unread ones, and opens the board', () => {
    const open = vi.fn();
    render(
      <NoticeDashboardCard
        notices={[notice('i', { priority: 'important', ...UNREAD }), notice('p', { pinned: true, ...READ }), notice('plain', UNREAD)]}
        today="2026-10-07"
        onOpen={open}
      />,
    );
    expect(screen.getByText('Notice i')).toBeTruthy();
    expect(screen.getByText('Notice p')).toBeTruthy();
    expect(screen.queryByText('Notice plain')).toBeNull();
    expect(screen.getByText(t('notices.card.unreadCount', { count: 2 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('notices.card.open') }));
    expect(open).toHaveBeenCalled();
  });
});

describe('NoticeManageView', () => {
  const ROLES = [
    { id: 'r1', name: 'Sales' },
    { id: 'r2', name: 'Dispatch' },
  ];

  function manage(over: Partial<Parameters<typeof NoticeManageView>[0]> = {}) {
    const created: NoticeInput[] = [];
    const updated: Array<[string, NoticeUpdate]> = [];
    const deleted: string[] = [];
    const props = {
      notices: [
        notice('a', { pinned: true, version: 3, readCount: 2, audienceSize: 5 }),
        notice('b', {
          audience: { kind: 'roles' as const, roleIds: ['r1'] },
          audienceRoleNames: ['Sales'],
          showUntil: '2026-10-01',
          expired: true,
          readCount: 0,
          audienceSize: 2,
          updatedAt: '2026-10-04T10:00:00.000Z',
        }),
      ],
      roles: ROLES,
      onCreate: async (input: NoticeInput) => void created.push(input),
      onUpdate: async (id: string, update: NoticeUpdate) => void updated.push([id, update]),
      onDelete: async (id: string) => void deleted.push(id),
      loadReaders: async (id: string): Promise<NoticeReaders> => ({
        noticeId: id,
        readers: [
          { userId: 'u1', displayName: 'Asha Rao', readAt: '2026-10-06T09:00:00.000Z' },
          { userId: 'u2', displayName: 'Bela Shah', readAt: null },
        ],
      }),
      today: '2026-10-07',
      ...over,
    };
    render(
      <ConfirmProvider>
        <NoticeManageView {...props} />
      </ConfirmProvider>,
    );
    return { created, updated, deleted };
  }

  it('orders by latest edit and shows audience, end date, who has read and what has expired', () => {
    expect(manageOrder([notice('1', { updatedAt: '2026-10-01T00:00:00.000Z' }), notice('2', { updatedAt: '2026-10-03T00:00:00.000Z' })]).map((n) => n.id)).toEqual(['2', '1']);
    manage();
    expect(screen.getByText(t('notices.manage.audienceAll'))).toBeTruthy();
    expect(screen.getByText(t('notices.manage.audienceRoles', { roles: 'Sales' }))).toBeTruthy();
    expect(screen.getByText(t('notices.expired'))).toBeTruthy();
    expect(screen.getByText(t('notices.manage.reads', { read: 2, total: 5 }))).toBeTruthy();
    expect(screen.getByText(t('notices.pinned'))).toBeTruthy();
  });

  it('refuses a notice with no title before sending it, and sends a good one as written', async () => {
    const { created } = manage();
    fireEvent.click(screen.getByRole('button', { name: t('notices.manage.new') }));
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.save') }));
    expect(await screen.findByText(t('notices.problem.title_required'))).toBeTruthy();
    expect(created).toEqual([]);

    fireEvent.change(screen.getByLabelText(new RegExp(t('notices.editor.titleLabel'))), { target: { value: '  Closed on Friday ' } });
    fireEvent.change(screen.getByLabelText(new RegExp(t('notices.editor.bodyLabel'))), { target: { value: 'Line one\nLine two' } });
    fireEvent.click(screen.getByRole('button', { name: t('notices.priority.important') }));
    fireEvent.click(screen.getByRole('checkbox', { name: t('notices.editor.pinned') }));
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.save') }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      title: 'Closed on Friday',
      body: 'Line one\nLine two',
      priority: 'important',
      pinned: true,
      showUntil: null,
      audience: { kind: 'all' },
    });
  });

  it('asks for at least one role when the audience is chosen roles, and sends the chosen ones', async () => {
    const { created } = manage();
    fireEvent.click(screen.getByRole('button', { name: t('notices.manage.new') }));
    fireEvent.change(screen.getByLabelText(new RegExp(t('notices.editor.titleLabel'))), { target: { value: 'For some' } });
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.audienceRoles') }));
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.save') }));
    expect(await screen.findByText(t('notices.problem.audience_empty'))).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Dispatch' }));
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.save') }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.audience).toEqual({ kind: 'roles', roleIds: ['r2'] });
  });

  it('edits against the version it saw, and pins and unpins from the list the same way', async () => {
    const { updated } = manage();
    fireEvent.click(screen.getAllByRole('button', { name: t('notices.manage.edit') })[0]!);
    fireEvent.change(screen.getByLabelText(new RegExp(t('notices.editor.titleLabel'))), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.save') }));
    await waitFor(() => expect(updated).toHaveLength(1));
    expect(updated[0]![0]).toBe('a');
    expect(updated[0]![1]).toMatchObject({ title: 'Renamed', expectedVersion: 3 });

    fireEvent.click(screen.getByRole('button', { name: t('notices.manage.unpin') }));
    await waitFor(() => expect(updated).toHaveLength(2));
    expect(updated[1]).toEqual(['a', { pinned: false, expectedVersion: 3 }]);
  });

  it('shows a conflict, with Reload, when somebody saved first', async () => {
    const reload = vi.fn();
    manage({
      onRetry: reload,
      onUpdate: async () => {
        throw Object.assign(new Error('Changed first'), { code: 'conflict' });
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: t('notices.manage.edit') })[0]!);
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.save') }));
    expect(await screen.findByText(t('notices.editor.conflict'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.reload') }));
    expect(reload).toHaveBeenCalled();
  });

  it('deletes only after a confirmation that says what happens', async () => {
    const { deleted } = manage();
    fireEvent.click(screen.getAllByRole('button', { name: t('notices.manage.delete') })[0]!);
    expect(await screen.findByText(t('notices.delete.body'))).toBeTruthy();
    expect(deleted).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: t('notices.delete.confirm') }));
    await waitFor(() => expect(deleted).toHaveLength(1));
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const { deleted } = manage();
    fireEvent.click(screen.getAllByRole('button', { name: t('notices.manage.delete') })[0]!);
    await screen.findByText(t('notices.delete.body'));
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    await act(async () => undefined);
    expect(deleted).toEqual([]);
  });

  it('shows who has read a notice and who has not', async () => {
    manage();
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(t('notices.manage.readers')) })[0]!);
    expect(await screen.findByText(t('notices.readers.summary', { read: 1, total: 2 }))).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText(t('notices.readers.unread'))).toBeTruthy();
  });

  it('says why a failed action did not work, and keeps the list', async () => {
    manage({
      onUpdate: async () => {
        throw new Error('Master offline');
      },
    });
    fireEvent.click(screen.getByRole('button', { name: t('notices.manage.unpin') }));
    expect(await screen.findByText('Master offline')).toBeTruthy();
    expect(screen.getByText('Notice a')).toBeTruthy();
  });
});

describe('the Master screens', () => {
  async function load<T>(file: string, name: string): Promise<ComponentType<T>> {
    const path = `../../master/web/src/screens/${file}.tsx`;
    return ((await import(/* @vite-ignore */ path)) as Record<string, ComponentType<T>>)[name]!;
  }

  it('NoticeBoardScreen reads the board, marks one read with the server, and tells the shell the count', async () => {
    const posted: unknown[] = [];
    routeFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/notices') {
        return json({ notices: [notice('a', UNREAD), notice('b', UNREAD)], unreadCount: 2 });
      }
      if (method === 'POST' && url === '/api/notices/read') {
        posted.push(body);
        return json({ unreadCount: 1 });
      }
      return undefined;
    });
    const Screen = await load<{ revision: number; onUnreadChange: (n: number) => void }>('NoticeBoardScreen', 'NoticeBoardScreen');
    const counts: number[] = [];
    render(<Screen revision={0} onUnreadChange={(n) => counts.push(n)} />);

    expect(await screen.findByText('Notice a')).toBeTruthy();
    expect(counts.at(-1)).toBe(2);
    fireEvent.click(within(screen.getByText('Notice a').closest('li') as HTMLElement).getByRole('button', { name: t('notices.board.markRead') }));
    await waitFor(() => expect(posted).toEqual([{ ids: ['a'] }]));
    await waitFor(() => expect(counts.at(-1)).toBe(1));
    expect(screen.getAllByRole('button', { name: t('notices.board.markRead') })).toHaveLength(1);
  });

  it('NoticeBoardScreen marks everything read with no ids', async () => {
    const posted: unknown[] = [];
    routeFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/notices') return json({ notices: [notice('a', UNREAD)], unreadCount: 1 });
      if (method === 'POST' && url === '/api/notices/read') {
        posted.push(body);
        return json({ unreadCount: 0 });
      }
      return undefined;
    });
    const Screen = await load<{ revision: number }>('NoticeBoardScreen', 'NoticeBoardScreen');
    render(<Screen revision={0} />);
    await screen.findByText('Notice a');
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markAllRead') }));
    await waitFor(() => expect(posted).toEqual([{}]));
  });

  it('NoticeManageScreen lists the notices, takes the roles from the Master, and creates through it', async () => {
    const created: unknown[] = [];
    routeFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/notices/manage') return json([notice('a', { readCount: 0, audienceSize: 3 })]);
      if (method === 'GET' && url === '/api/notices/audiences') return json([{ id: 'r1', name: 'Sales' }]);
      if (method === 'POST' && url === '/api/notices') {
        created.push(body);
        return json(notice('n'), 201);
      }
      return undefined;
    });
    const Screen = await load<{ revision: number }>('NoticeManageScreen', 'NoticeManageScreen');
    render(
      <ConfirmProvider>
        <Screen revision={0} />
      </ConfirmProvider>,
    );
    expect(await screen.findByText('Notice a')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('notices.manage.new') }));
    fireEvent.change(screen.getByLabelText(new RegExp(t('notices.editor.titleLabel'))), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.audienceRoles') }));
    expect(screen.getByRole('checkbox', { name: 'Sales' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sales' }));
    fireEvent.click(screen.getByRole('button', { name: t('notices.editor.save') }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ title: 'Fresh', audience: { kind: 'roles', roleIds: ['r1'] } });
    await act(async () => undefined);
  });

  it('the Dashboard mounts the card for somebody who may view notices, and the kit exports are in place', () => {
    const source = readFileSync(join(process.cwd(), 'master', 'web', 'src', 'screens', 'DashboardScreen.tsx'), 'utf8');
    expect(source).toContain('<NoticeDashboardCard');
    expect(source).toMatch(/canViewNotices &&/);
  });
});
