/**
 * The notice slideshow on Basic Home (owner add-on V5): which notices it turns over (every one
 * placed on Basic Home, 2026-10-08), the band that says there are none, the 6 s
 * rotation, pausing on hover and focus, the stop button, no auto-advance under reduced motion,
 * the carousel ARIA, and a slide opening its notice.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { NoticeBoardView } from '../src/NoticeBoardView.js';
import { NoticeSlideshow, SLIDE_MS, homeNotices } from '../src/NoticeSlideshow.js';

const TODAY = '2026-10-07';

function notice(id: string, over: Partial<Notice> = {}): Notice {
  return {
    id,
    title: `Notice ${id}`,
    body: `Body of ${id}`,
    priority: 'important',
    pinned: false,
    showUntil: null,
    audience: { kind: 'all' },
    authorId: 'boss',
    authorName: 'Boss',
    createdAt: '2026-10-06T09:00:00.000Z',
    updatedAt: '2026-10-06T09:00:00.000Z',
    version: 1,
    readByMe: false,
    ...over,
  } as Notice;
}

const THREE = [notice('a'), notice('b'), notice('c')];

function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('reduce'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
}

const shownTitle = () => document.querySelector('.ob-slideshow-title')?.textContent;
const slides = () => document.querySelector('.ob-slideshow-slides') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
  delete document.documentElement.dataset.motion;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('which notices it shows', () => {
  const MIXED = [
    notice('read', { readByMe: true }),
    notice('plain', { priority: 'normal' }),
    notice('pinned', { priority: 'normal', pinned: true }),
    notice('gone', { showUntil: '2026-10-01' }),
    notice('sign-in-only', { showOnHome: false }),
    notice('new'),
  ];

  it('turns over every notice placed on Basic Home and still up today, unread first, then board order', () => {
    // 2026-10-08: an ordinary unpinned notice is on Basic Home too; before, only important or pinned ones were.
    expect(homeNotices(MIXED, TODAY).map((n) => n.id)).toEqual(['pinned', 'new', 'plain', 'read']);

    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={MIXED} />);
    expect(screen.getAllByRole('button', { name: /^Show notice/ })).toHaveLength(4);
    expect(shownTitle()).toBe('Notice pinned');
  });

  it('shows an ordinary notice on its own', () => {
    render(
      <NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={[notice('plain', { priority: 'normal' })]} />,
    );
    expect(shownTitle()).toBe('Notice plain');
  });

  it('says there are none, and offers the board, when nothing is placed on Basic Home', () => {
    const onOpenBoard = vi.fn();
    render(
      <NoticeSlideshow
        today={TODAY}
        onOpen={() => undefined}
        onOpenBoard={onOpenBoard}
        notices={[notice('x', { showOnHome: false }), notice('gone', { showUntil: '2026-10-01' })]}
      />,
    );
    const band = screen.getByRole('region', { name: t('notices.slideshow.label') });
    expect(band.getAttribute('aria-roledescription')).toBeNull();
    expect(within(band).getByText(t('notices.board.emptyTitle'))).toBeTruthy();
    expect(within(band).queryByText('Notice x')).toBeNull();
    fireEvent.click(within(band).getByRole('button', { name: t('notices.card.open') }));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
  });

  it('shows one notice still, with no controls', () => {
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={[notice('only')]} />);
    expect(shownTitle()).toBe('Notice only');
    expect(screen.queryByRole('button', { name: t('notices.slideshow.next') })).toBeNull();
  });
});

describe('rotation', () => {
  it('moves on every 6 s and wraps round, silently while it rotates', () => {
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={THREE} />);
    expect(shownTitle()).toBe('Notice a');
    expect(slides().getAttribute('aria-live')).toBe('off');
    act(() => vi.advanceTimersByTime(SLIDE_MS - 1));
    expect(shownTitle()).toBe('Notice a');
    act(() => vi.advanceTimersByTime(1));
    expect(shownTitle()).toBe('Notice b');
    act(() => vi.advanceTimersByTime(SLIDE_MS));
    expect(shownTitle()).toBe('Notice c');
    act(() => vi.advanceTimersByTime(SLIDE_MS));
    expect(shownTitle()).toBe('Notice a');
  });

  it('holds while the pointer is over it, and goes on when it leaves', () => {
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={THREE} />);
    const band = screen.getByRole('region', { name: t('notices.slideshow.label') });
    fireEvent.mouseEnter(band);
    act(() => vi.advanceTimersByTime(SLIDE_MS * 3));
    expect(shownTitle()).toBe('Notice a');
    expect(slides().getAttribute('aria-live')).toBe('polite');
    fireEvent.mouseLeave(band);
    act(() => vi.advanceTimersByTime(SLIDE_MS));
    expect(shownTitle()).toBe('Notice b');
  });

  it('holds while focus is inside it', () => {
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={THREE} />);
    act(() => screen.getByRole('button', { name: t('notices.slideshow.next') }).focus());
    act(() => vi.advanceTimersByTime(SLIDE_MS * 3));
    expect(shownTitle()).toBe('Notice a');
  });

  it('stops for good with the stop button, and starts again with it', () => {
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={THREE} />);
    fireEvent.click(screen.getByRole('button', { name: t('notices.slideshow.pause') }));
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => vi.advanceTimersByTime(SLIDE_MS * 3));
    expect(shownTitle()).toBe('Notice a');
    fireEvent.click(screen.getByRole('button', { name: t('notices.slideshow.play') }));
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => vi.advanceTimersByTime(SLIDE_MS));
    expect(shownTitle()).toBe('Notice b');
  });

  it('never moves by itself under reduced motion, and offers no stop button there', () => {
    setReducedMotion(true);
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={THREE} />);
    act(() => vi.advanceTimersByTime(SLIDE_MS * 3));
    expect(shownTitle()).toBe('Notice a');
    expect(screen.queryByRole('button', { name: t('notices.slideshow.pause') })).toBeNull();
    // The reader can still turn the slides.
    fireEvent.click(screen.getByRole('button', { name: t('notices.slideshow.next') }));
    expect(shownTitle()).toBe('Notice b');
  });

  it('never moves by itself with the app’s motion switched off', () => {
    document.documentElement.dataset.motion = 'off';
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={THREE} />);
    act(() => vi.advanceTimersByTime(SLIDE_MS * 3));
    expect(shownTitle()).toBe('Notice a');
  });
});

describe('controls and ARIA', () => {
  it('is a carousel of slides, with previous, next and dots that say which is shown', () => {
    render(<NoticeSlideshow today={TODAY} onOpen={() => undefined} notices={THREE} />);
    const band = screen.getByRole('region', { name: t('notices.slideshow.label') });
    expect(band.getAttribute('aria-roledescription')).toBe('carousel');
    const slide = within(band).getByRole('group', {
      name: t('notices.slideshow.slide', { index: 1, count: 3 }),
    });
    expect(slide.getAttribute('aria-roledescription')).toBe('slide');

    fireEvent.click(screen.getByRole('button', { name: t('notices.slideshow.previous') }));
    expect(shownTitle()).toBe('Notice c');
    fireEvent.click(
      screen.getByRole('button', { name: t('notices.slideshow.goTo', { index: 2 }) }),
    );
    expect(shownTitle()).toBe('Notice b');
    expect(
      screen
        .getByRole('button', { name: t('notices.slideshow.goTo', { index: 2 }) })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('opens the notice on the board when a slide is pressed', () => {
    const onOpen = vi.fn();
    render(<NoticeSlideshow today={TODAY} onOpen={onOpen} notices={THREE} />);
    fireEvent.click(screen.getByText('Notice a'));
    expect(onOpen).toHaveBeenCalledWith('a');
  });
});

describe('the board, opened from a slide', () => {
  it('brings that notice into view, focused and open in full', () => {
    vi.useRealTimers();
    const long = 'line\n'.repeat(20);
    render(
      <NoticeBoardView
        notices={[notice('a'), notice('b', { body: long })]}
        unreadCount={2}
        online
        onMarkRead={() => undefined}
        onMarkAllRead={() => undefined}
        focus={{ id: 'b', nonce: 1 }}
      />,
    );
    const item = document.querySelector('[data-notice="b"]') as HTMLElement;
    expect(document.activeElement).toBe(item);
    expect(within(item).getByRole('button', { name: t('notices.board.showLess') })).toBeTruthy();
  });
});
