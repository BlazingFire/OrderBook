/**
 * The Dashboard's card of notices worth seeing at a glance: the important ones and the pinned ones,
 * unread first. It draws nothing when there are none, so a quiet board costs the Dashboard no space.
 */

import type { Notice } from '@orderbook/shared';

import { Button } from './Button.js';
import { Card } from './Card.js';
import { StatusPill } from './DataDisplay.js';
import { t } from './i18n.js';
import { boardNotices } from './NoticeBoardView.js';

export interface NoticeDashboardCardProps {
  notices: Notice[];
  today?: string;
  onOpen: () => void;
  /** How many to list; the rest are one click away on the board. */
  limit?: number;
}

/** The notices the card lists: not expired, important or pinned, unread before read, then board order. */
export function cardNotices(notices: readonly Notice[], today?: string, limit = 3): Notice[] {
  const worth = boardNotices(notices, today).filter((notice) => notice.pinned || notice.priority === 'important');
  const unreadFirst = [...worth.filter((n) => n.readByMe === false), ...worth.filter((n) => n.readByMe !== false)];
  return unreadFirst.slice(0, limit);
}

export function NoticeDashboardCard({ notices, today, onOpen, limit = 3 }: NoticeDashboardCardProps) {
  const listed = cardNotices(notices, today, limit);
  if (listed.length === 0) return null;
  const unread = boardNotices(notices, today).filter((notice) => notice.readByMe === false).length;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-8)', marginBottom: 'var(--s-8)' }}>
        <h2 className="ob-title" style={{ margin: 0 }}>
          {t('notices.card.title')}
        </h2>
        {unread > 0 && <StatusPill tone="accent">{t('notices.card.unreadCount', { count: unread })}</StatusPill>}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
        {listed.map((notice) => (
          <li key={notice.id} data-notice={notice.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', flexWrap: 'wrap' }}>
              <span className="ob-body-strong" style={{ overflowWrap: 'anywhere' }}>{notice.title}</span>
              {notice.priority === 'important' && <StatusPill tone="conflict">{t('notices.priority.important')}</StatusPill>}
              {notice.pinned && <StatusPill tone="accent">{t('notices.pinned')}</StatusPill>}
            </span>
            <span
              className="ob-small"
              style={{
                color: 'var(--fg-secondary)',
                overflowWrap: 'anywhere',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                whiteSpace: 'pre-wrap',
              }}
            >
              {notice.body}
            </span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 'var(--s-12)' }}>
        <Button variant="secondary" size="sm" onClick={onOpen}>
          {t('notices.card.open')}
        </Button>
      </div>
    </Card>
  );
}
