/**
 * The notice slideshow at the top of Basic Home (owner add-on V5). The artifact has no board
 * for it, so it is built from the design system's parts: a surface band like the Feedback
 * banners, the Data pills, and the icon set's chevrons.
 *
 * It cycles the reader's important and pinned notices, unread first (`cardNotices`, the same
 * audience the board and the Dashboard card show). A slide shows the title, the pills, the
 * start of the body and the date; pressing it opens that notice on the board.
 *
 * Rotation follows the WAI-ARIA carousel pattern: 6 s a slide; paused while the pointer is
 * over it or focus is inside it; a stop / start button first, then previous, the dots and
 * next. The slides region is silent while it rotates on its own and polite once the reader
 * is driving. Under reduced motion (the OS setting or the app's motion switch) it never
 * advances by itself. With nothing to show it draws nothing.
 */

import { useEffect, useId, useState } from 'react';
import type { Notice } from '@orderbook/shared';

import { StatusPill } from './DataDisplay.js';
import { formatDate } from './format.js';
import { t } from './i18n.js';
import { Icon } from './icons.js';
import { cardNotices } from './NoticeDashboardCard.js';

export const SLIDE_MS = 6000;

export interface NoticeSlideshowProps {
  notices: Notice[];
  today?: string;
  /** Opens this notice on the board. */
  onOpen: (id: string) => void;
  /** How many slides at most; the rest are on the board. */
  limit?: number;
}

function motionReduced(): boolean {
  if (document.documentElement.dataset.motion === 'off') return true;
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export function NoticeSlideshow({ notices, today, onOpen, limit = 8 }: NoticeSlideshowProps) {
  const slides = cardNotices(notices, today, limit);
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

  if (count === 0) return null;
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
