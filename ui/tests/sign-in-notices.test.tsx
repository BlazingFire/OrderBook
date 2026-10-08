/**
 * V6: unread notices pop up once, right after somebody signs in. Since 2026-10-08 that is every
 * unread notice placed at sign-in, important first, not the important ones alone.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Notice } from '@orderbook/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import { SignInNotices, signInNotices } from '../src/SignInNotices.js';

beforeAll(() => {
  // jsdom has no checkVisibility; the dialog's focus trap asks it which controls can take focus.
  Element.prototype.checkVisibility ??= () => true;
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

function notice(id: string, overrides: Partial<Notice> = {}): Notice {
  return {
    id,
    tenantId: 'tenant-1',
    title: `Title ${id}`,
    body: `Body ${id}`,
    priority: 'important',
    pinned: false,
    showUntil: null,
    audience: { kind: 'all' },
    authorId: null,
    authorName: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    version: 1,
    readByMe: false,
    ...overrides,
  } as Notice;
}

const OLD = notice('N1', { createdAt: '2026-10-01T09:00:00.000Z' });
const NEW = notice('N2', { createdAt: '2026-10-05T09:00:00.000Z' });
const NORMAL = notice('N3', { priority: 'normal' });
const READ = notice('N4', { readByMe: true });
const EXPIRED = notice('N5', { showUntil: '2026-10-02' });
const HOME_ONLY = notice('N6', { showAtSignIn: false });
const TODAY = '2026-10-07';

const dialog = () => screen.queryByRole('dialog', { name: t('notices.signIn.title') });
const listed = () => within(dialog()!).getAllByRole('listitem').map((item) => item.getAttribute('data-notice'));

describe('signInNotices', () => {
  it('lists every unread one placed at sign-in and still on the board, important first, then newest', () => {
    expect(signInNotices([OLD, NORMAL, NEW, READ, EXPIRED, HOME_ONLY], TODAY).map((n) => n.id)).toEqual([
      'N2',
      'N1',
      'N3',
    ]);
  });
});

describe('SignInNotices', () => {
  it('shows the unread notices, important first, once they have loaded, with the pill only on the important ones', () => {
    const view = render(<SignInNotices loaded={false} notices={[]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(dialog()).toBeNull();

    view.rerender(
      <SignInNotices loaded notices={[OLD, NORMAL, NEW, READ, EXPIRED, HOME_ONLY]} today={TODAY} onMarkRead={vi.fn()} />,
    );

    expect(dialog()).not.toBeNull();
    expect(listed()).toEqual(['N2', 'N1', 'N3']);
    const pills = (id: string) =>
      within(dialog()!.querySelector(`[data-notice="${id}"]`) as HTMLElement).queryAllByText(t('notices.priority.important'));
    expect(pills('N2')).toHaveLength(1);
    expect(pills('N3')).toHaveLength(0);
  });

  it('follows the company switch as it stood when it decided, and closes when the switch goes off', () => {
    const props = { loaded: true, notices: [NEW], today: TODAY, onMarkRead: vi.fn() };
    const off = render(<SignInNotices key="sign-in-1" {...props} enabled={false} />);
    expect(dialog()).toBeNull();
    // Turned on later in the same sign-in: nothing pops up until the next one.
    off.rerender(<SignInNotices key="sign-in-1" {...props} enabled />);
    expect(dialog()).toBeNull();
    cleanup();

    const on = render(<SignInNotices key="sign-in-2" {...props} enabled />);
    expect(dialog()).not.toBeNull();
    on.rerender(<SignInNotices key="sign-in-2" {...props} enabled={false} />);
    expect(dialog()).toBeNull();
  });

  it('shows an ordinary unread notice on its own', () => {
    render(<SignInNotices loaded notices={[NORMAL]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(listed()).toEqual(['N3']);
  });

  it('shows nothing to somebody with no unread notice placed at sign-in, or none at all', () => {
    render(<SignInNotices loaded notices={[READ, EXPIRED, HOME_ONLY]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(dialog()).toBeNull();
    cleanup();
    render(<SignInNotices loaded notices={[]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(dialog()).toBeNull();
  });

  it('Later closes it for this sign-in, and the next sign-in shows it again', () => {
    const props = { loaded: true, notices: [NEW], today: TODAY, onMarkRead: vi.fn() };
    const view = render(<SignInNotices key="sign-in-1" {...props} />);
    fireEvent.click(screen.getByRole('button', { name: t('notices.signIn.later') }));
    expect(dialog()).toBeNull();
    expect(props.onMarkRead).not.toHaveBeenCalled();

    // Same sign-in: a fresh list does not bring it back.
    view.rerender(<SignInNotices key="sign-in-1" {...props} notices={[NEW, OLD]} />);
    expect(dialog()).toBeNull();

    // The panel mounts it anew for the next sign-in.
    view.rerender(<SignInNotices key="sign-in-2" {...props} />);
    expect(dialog()).not.toBeNull();
  });

  it('does not interrupt the session for a notice that arrives after sign-in', () => {
    const view = render(<SignInNotices loaded notices={[READ]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(dialog()).toBeNull();
    view.rerender(<SignInNotices loaded notices={[READ, NEW]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(dialog()).toBeNull();
  });

  it('Mark as read hands every listed id to the read path and closes', async () => {
    const onMarkRead = vi.fn(async () => undefined);
    render(<SignInNotices loaded notices={[OLD, NEW]} today={TODAY} onMarkRead={onMarkRead} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('notices.signIn.markRead') }));
    });

    expect(onMarkRead).toHaveBeenCalledWith(['N2', 'N1']);
    expect(dialog()).toBeNull();
  });

  it('stays open and says so when marking them read fails', async () => {
    const onMarkRead = vi.fn(async () => {
      throw new Error('offline');
    });
    render(<SignInNotices loaded notices={[NEW]} today={TODAY} onMarkRead={onMarkRead} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('notices.signIn.markRead') }));
    });

    expect(dialog()).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(t('notices.signIn.markFailed'));
  });

  it('does not ask again after a reload in the same sign-in, and asks again at the next one', () => {
    const props = { loaded: true, notices: [NEW], today: TODAY, onMarkRead: vi.fn() };
    render(<SignInNotices {...props} sessionKey="user-1:2026-10-07T08:00:00Z" />);
    expect(dialog()).not.toBeNull();
    cleanup();

    // The window reloads: the shell mounts again for the same sign-in.
    render(<SignInNotices {...props} sessionKey="user-1:2026-10-07T08:00:00Z" />);
    expect(dialog()).toBeNull();
    cleanup();

    // Signed out and in again: a new session, so it asks.
    render(<SignInNotices {...props} sessionKey="user-1:2026-10-07T13:00:00Z" />);
    expect(dialog()).not.toBeNull();
  });

  it('keeps nothing of the session key itself in storage', () => {
    render(<SignInNotices loaded notices={[NEW]} today={TODAY} onMarkRead={vi.fn()} sessionKey="user-1:secret-token" />);
    const stored = Object.values({ ...window.sessionStorage }).join(' ');
    expect(stored).not.toContain('secret-token');
    expect(stored).not.toContain('user-1');
  });

  it('says it is out of the way once it decided on nothing, or once its dialog closed, never while open (2026-10-08)', () => {
    const onSettled = vi.fn();
    const view = render(<SignInNotices loaded={false} notices={[]} today={TODAY} onMarkRead={vi.fn()} onSettled={onSettled} />);
    expect(onSettled).not.toHaveBeenCalled();
    view.rerender(<SignInNotices loaded notices={[READ]} today={TODAY} onMarkRead={vi.fn()} onSettled={onSettled} />);
    expect(onSettled).toHaveBeenCalledTimes(1);
    cleanup();

    const later = vi.fn();
    render(<SignInNotices loaded notices={[NEW]} today={TODAY} onMarkRead={vi.fn()} onSettled={later} />);
    expect(dialog()).not.toBeNull();
    expect(later).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('notices.signIn.later') }));
    expect(later).toHaveBeenCalledTimes(1);
  });
});
