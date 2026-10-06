/**
 * The notice board a signed-in person reads (Oct 7, U4): the notices meant for them, pinned and
 * important first, with what is unread marked and a way to mark it read.
 *
 * Props in, callbacks out: no api or socket call lives here, so the Master feeds it from REST and
 * the Office from its snapshot. A notice is plain text; it is shown with its line breaks and never
 * as markup.
 */

import { useState } from 'react';
import { compareNotices, isNoticeExpired, type Notice } from '@orderbook/shared';

import { Button } from './Button.js';
import { StatusPill } from './DataDisplay.js';
import { formatDateTime } from './format.js';
import { t } from './i18n.js';
import { ConflictBanner, EmptyState, ErrorState, OfflineBanner, SkeletonRows } from './States.js';

/** Longer than this (or more lines) shows a "Show more" instead of the whole text. */
const CLAMP_CHARS = 400;
const CLAMP_LINES = 6;

export interface NoticeBoardViewProps {
  notices: Notice[];
  unreadCount: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Why the last mark-as-read did not work, shown above the list while the list stays. */
  actionError?: string | null;
  /** False: marking as read needs the Master, and the view says so instead of pretending. */
  online: boolean;
  onMarkRead: (ids: string[]) => void | Promise<void>;
  onMarkAllRead: () => void | Promise<void>;
  /** Today as `YYYY-MM-DD`; a notice past its last day is left out. Omit to show what is given. */
  today?: string;
}

/** What is on the board for this person today, in board order. */
export function boardNotices(notices: readonly Notice[], today?: string): Notice[] {
  return notices
    .filter((notice) => !(today && isNoticeExpired(notice.showUntil, today)))
    .sort(compareNotices);
}

export function NoticeBoardView({
  notices,
  unreadCount,
  loading,
  error,
  onRetry,
  actionError,
  online,
  onMarkRead,
  onMarkAllRead,
  today,
}: NoticeBoardViewProps) {
  const shown = boardNotices(notices, today);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, action: () => void | Promise<void>): Promise<void> {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  if (loading && notices.length === 0) return <SkeletonRows rows={4} columns={1} />;
  if (error && notices.length === 0) {
    return <ErrorState title={t('notices.board.loadFailed')} description={error} actionLabel={onRetry ? t('action.retryNow') : undefined} onAction={onRetry} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)', maxWidth: '56rem' }}>
      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}
      {!online && <OfflineBanner>{t('notices.board.offlineNote')}</OfflineBanner>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
        <span className="ob-body-strong" role="status" aria-live="polite">
          {unreadCount > 0 ? t('notices.board.unread', { count: unreadCount }) : t('notices.board.upToDate')}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!online || unreadCount === 0 || busy !== null}
          busy={busy === 'all'}
          onClick={() => void run('all', onMarkAllRead)}
        >
          {t('notices.board.markAllRead')}
        </Button>
      </div>

      {shown.length === 0 ? (
        <EmptyState title={t('notices.board.emptyTitle')} description={t('notices.board.emptyBody')} />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
          {shown.map((notice) => (
            <NoticeItem
              key={notice.id}
              notice={notice}
              online={online}
              busy={busy === notice.id}
              disabled={busy !== null}
              onMarkRead={() => void run(notice.id, () => onMarkRead([notice.id]))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoticeItem({
  notice,
  online,
  busy,
  disabled,
  onMarkRead,
}: {
  notice: Notice;
  online: boolean;
  busy: boolean;
  disabled: boolean;
  onMarkRead: () => void;
}) {
  const unread = notice.readByMe === false;
  const long = notice.body.length > CLAMP_CHARS || notice.body.split('\n').length > CLAMP_LINES;
  const [open, setOpen] = useState(false);
  const clipped = long && !open;

  return (
    <li
      data-notice={notice.id}
      data-unread={unread || undefined}
      style={{
        border: '1px solid var(--line)',
        borderLeft: unread ? '3px solid var(--accent)' : '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        background: 'var(--bg-surface)',
        padding: 'var(--s-12) var(--s-16)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-8)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
        {unread && <span className="ob-small" style={{ color: 'var(--accent)', fontWeight: 600 }}>{t('notices.board.unreadMark')}</span>}
        <h2 className="ob-title" style={{ margin: 0, fontSize: 'var(--t-body-size)', overflowWrap: 'anywhere' }}>
          {notice.title}
        </h2>
        {notice.priority === 'important' && <StatusPill tone="conflict">{t('notices.priority.important')}</StatusPill>}
        {notice.pinned && <StatusPill tone="accent">{t('notices.pinned')}</StatusPill>}
      </div>

      <p
        className="ob-body"
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          ...(clipped
            ? { display: '-webkit-box', WebkitLineClamp: CLAMP_LINES, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
            : {}),
        }}
      >
        {notice.body}
      </p>
      {long && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setOpen((current) => !current)}>
            {open ? t('notices.board.showLess') : t('notices.board.showMore')}
          </Button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
        <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
          {t('notices.meta.by', { author: notice.authorName ?? '—', when: formatDateTime(notice.createdAt) })}
          {notice.showUntil ? ` · ${t('notices.meta.until', { date: notice.showUntil })}` : ''}
        </span>
        {unread && (
          <Button variant="secondary" size="sm" disabled={!online || disabled} busy={busy} onClick={onMarkRead}>
            {t('notices.board.markRead')}
          </Button>
        )}
      </div>
    </li>
  );
}
