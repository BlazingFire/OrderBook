/**
 * The notice slideshow at the top of Basic Home (owner add-on V5). The artifact has no board
 * for it, so it is built from the design system's parts: a surface band like the Feedback
 * banners, the Data pills, and the icon set's chevrons.
 *
 * It cycles every notice on the reader's board today that is placed on Basic Home (2026-10-08:
 * it used to take only the important and pinned ones, so an ordinary notice never showed here),
 * unread first and then in board order (`homeNotices`). A slide shows the title, the pills, the
 * start of the body and the date; pressing it opens that notice on the board.
 *
 * Rotation follows the WAI-ARIA carousel pattern: 6 s a slide; paused while the pointer is
 * over it or focus is inside it; a stop / start button first, then previous, the dots and
 * next. The slides region is silent while it rotates on its own and polite once the reader
 * is driving. Under reduced motion (the OS setting or the app's motion switch) it never
 * advances by itself. With nothing to show it is a short band that says so, with the way to
 * the board, so Basic Home never looks as if the notice board were missing.
 */

import { useEffect, useId, useState } from 'react';
import { noticeOnHome, type Notice } from '@orderbook/shared';

import { Button } from './Button.js';
import { StatusPill } from './DataDisplay.js';
import { formatDate } from './format.js';
import { t } from './i18n.js';
import { Icon } from './icons.js';
import { boardNotices } from './NoticeBoardView.js';

export const SLIDE_MS = 6000;

/** The slides: on the board today and placed on Basic Home, unread before read, then board order. */
export function homeNotices(notices: readonly Notice[], today?: string, limit = 8): Notice[] {
  const placed = boardNotices(notices, today).filter(noticeOnHome);
  const unreadFirst = [...placed.filter((n) => n.readByMe === false), ...placed.filter((n) => n.readByMe !== false)];
  return unreadFirst.slice(0, limit);
}

export interface NoticeSlideshowProps {
  notices: Notice[];
  today?: string;
  /** Opens this notice on the board. */
  onOpen: (id: string) => void;
  /** Opens the board itself: the empty band's button. */
  onOpenBoard?: () => void;
  /** How many slides at most; the rest are on the board. */
  limit?: number;
}

function motionReduced(): boolean {
  if (document.documentElement.dataset.motion === 'off') return true;
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export function NoticeSlideshow({ notices, today, onOpen, onOpenBoard, limit = 8 }: NoticeSlideshowProps) {
  const slides = homeNotices(notices, today, limit);
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const slidesId = useId();

  const count = slides.length;
  const current = count === 0 ? 0 : Math.min(index, count - 1);
  const canRotate = count > 1 && !motionReduced();
  const rotating = canRotate && !stopped && !hovered && !focused;

  useEffect(() => {
    if (!rotating) return undefined;
    const timer = setTimeout(() => setIndex((i) => (Math.min(i, count - 1) + 1) % count), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [rotating, current, count]);

  if (count === 0) {
    return (
      <section className="ob-slideshow ob-slideshow--empty" aria-label={t('notices.slideshow.label')}>
        <span className="ob-slideshow-empty">
          <span className="ob-slideshow-title">{t('notices.board.emptyTitle')}</span>
          <span className="ob-slideshow-body">{t('notices.board.emptyBody')}</span>
        </span>
        {onOpenBoard && (
          <Button variant="secondary" size="sm" onClick={onOpenBoard}>
            {t('notices.card.open')}
          </Button>
        )}
      </section>
    );
  }
  const notice = slides[current]!;
  const go = (next: number) => setIndex(((next % count) + count) % count);

  return (
    <section
      className={`ob-slideshow${notice.priority === 'important' ? ' ob-slideshow--important' : ''}`}
      aria-roledescription="carousel"
      aria-label={t('notices.slideshow.label')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div id={slidesId} className="ob-slideshow-slides" aria-live={rotating ? 'off' : 'polite'}>
        <div
          key={notice.id}
          role="group"
          aria-roledescription="slide"
          aria-label={t('notices.slideshow.slide', { index: current + 1, count })}
          className="ob-slideshow-slide"
        >
          <button
            type="button"
            className="ob-slideshow-open"
            data-notice={notice.id}
            onClick={() => onOpen(notice.id)}
          >
            <span className="ob-slideshow-head">
              <span className="ob-slideshow-title">{notice.title}</span>
              {notice.priority === 'important' && (
                <StatusPill tone="conflict">{t('notices.priority.important')}</StatusPill>
              )}
              {notice.pinned && <StatusPill tone="accent">{t('notices.pinned')}</StatusPill>}
              <span className="ob-slideshow-date">{formatDate(notice.createdAt)}</span>
            </span>
            <span className="ob-slideshow-body">{notice.body}</span>
          </button>
        </div>
      </div>

      {count > 1 && (
        <div className="ob-slideshow-controls">
          {canRotate && (
            <button
              type="button"
              className="ob-icon-btn"
              aria-label={stopped ? t('notices.slideshow.play') : t('notices.slideshow.pause')}
              title={stopped ? t('notices.slideshow.play') : t('notices.slideshow.pause')}
              onClick={() => setStopped((value) => !value)}
            >
              <svg
                width={16}
                height={16}
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                {stopped ? (
                  <path d="M5 3.5v9l7-4.5z" />
                ) : (
                  <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" />
                )}
              </svg>
            </button>
          )}
          <button
            type="button"
            className="ob-icon-btn"
            aria-controls={slidesId}
            aria-label={t('notices.slideshow.previous')}
            title={t('notices.slideshow.previous')}
            onClick={() => go(current - 1)}
          >
            <Icon name="chevron-left" />
          </button>
          <div
            className="ob-slideshow-dots"
            role="group"
            aria-label={t('notices.slideshow.choose')}
          >
            {slides.map((slide, i) => (
              <button
                key={slide.id}
                type="button"
                className="ob-slideshow-dot"
                aria-controls={slidesId}
                aria-label={t('notices.slideshow.goTo', { index: i + 1 })}
                aria-current={i === current ? 'true' : undefined}
                onClick={() => go(i)}
              />
            ))}
          </div>
          <button
            type="button"
            className="ob-icon-btn"
            aria-controls={slidesId}
            aria-label={t('notices.slideshow.next')}
            title={t('notices.slideshow.next')}
            onClick={() => go(current + 1)}
          >
            <Icon name="chevron-right" />
          </button>
        </div>
      )}
    </section>
  );
}
