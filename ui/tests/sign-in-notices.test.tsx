/**
 * V6: important unread notices pop up once, right after somebody signs in.
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
const TODAY = '2026-10-07';

const dialog = () => screen.queryByRole('dialog', { name: t('notices.signIn.title') });
const listed = () => within(dialog()!).getAllByRole('listitem').map((item) => item.getAttribute('data-notice'));

describe('signInNotices', () => {
  it('lists only the important ones not read and still on the board, newest first', () => {
    expect(signInNotices([OLD, NORMAL, NEW, READ, EXPIRED], TODAY).map((n) => n.id)).toEqual(['N2', 'N1']);
  });
});

describe('SignInNotices', () => {
  it('shows the important unread notices, newest first, once they have loaded', () => {
    const view = render(<SignInNotices loaded={false} notices={[]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(dialog()).toBeNull();

    view.rerender(<SignInNotices loaded notices={[OLD, NORMAL, NEW, READ, EXPIRED]} today={TODAY} onMarkRead={vi.fn()} />);

    expect(dialog()).not.toBeNull();
    expect(listed()).toEqual(['N2', 'N1']);
  });

  it('shows nothing to somebody with no important unread notice, or none at all', () => {
    render(<SignInNotices loaded notices={[NORMAL, READ, EXPIRED]} today={TODAY} onMarkRead={vi.fn()} />);
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
    const view = render(<SignInNotices loaded notices={[NORMAL]} today={TODAY} onMarkRead={vi.fn()} />);
    expect(dialog()).toBeNull();
    view.rerender(<SignInNotices loaded notices={[NORMAL, NEW]} today={TODAY} onMarkRead={vi.fn()} />);
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
});
