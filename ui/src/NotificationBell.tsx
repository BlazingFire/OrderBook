/**
 * The notification bell in the topbar, on both panels (1.3).
 *
 * Notices are stored on the Master, one person's at a time, and follow that
 * person to whichever panel they sign in on, so the bell reads them through a
 * transport each panel supplies: the Master's own REST routes, or the Office's
 * forwards of them. It holds no copy of its own beyond what is on screen. A
 * panel moves `revision` when the list may have changed (a push, a reconnect,
 * a different person signed in) and the bell reads it again; opening it reads
 * it again too.
 *
 * `local` notices are the panel's own and are never stored: the Office's "no
 * link for an hour" is raised by the PC that has no link, so it cannot ask the
 * Master to keep it. They sit above the stored ones and count towards the
 * badge for as long as the panel passes them.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  MessageKey,
  NotificationKind,
  NotificationLink,
  UserNotification,
} from '@orderbook/shared';

import { formatDateTime } from './format.js';
import { t } from './i18n.js';
import { Icon } from './icons';
import { rem } from './rem.js';

export interface NotificationTransport {
  list(): Promise<{ items: UserNotification[]; unreadCount: number }>;
  markRead(which: { ids: string[] } | { all: true }): Promise<{ unreadCount: number }>;
}

/** A notice the panel raised about itself. Never stored, never sent. */
export interface LocalNotice {
  id: string;
  text: string;
  createdAt: string;
}

/** Spelled out per kind, so every key is greppable and a missing one fails the type check. */
const KIND_TEXT: Record<NotificationKind, MessageKey> = {
  'panel.offlineLong': 'notification.panel.offlineLong',
  'chat.mention': 'notification.chat.mention',
  'task.assigned': 'notification.task.assigned',
  'task.done': 'notification.task.done',
  'access.requested': 'notification.access.requested',
};

/** A chat right named in a notice, as the reader's language words it. */
const RIGHT_TEXT: Record<string, MessageKey> = {
  'chat.directMessages': 'permission.chat.directMessages',
  'chat.shareRecords': 'permission.chat.shareRecords',
  'chat.tasks': 'permission.chat.tasks',
  'chat.createGroups': 'permission.chat.createGroups',
};

/** One notice as a sentence. A kind newer than this build reads as a plain "Notifications". */
export function notificationText(item: Pick<UserNotification, 'kind' | 'params'>): string {
  const key = (KIND_TEXT as Partial<Record<string, MessageKey>>)[item.kind];
  if (!key) return t('notification.title');
  // The right is stored as its key and worded here, so the sentence is whole in either language.
  const right = typeof item.params.capability === 'string' ? RIGHT_TEXT[item.params.capability] : undefined;
  return t(key, right ? { ...item.params, capability: t(right) } : item.params);
}

export function NotificationBell({
  transport,
  revision,
  local = [],
  onOpen,
}: {
  transport: NotificationTransport;
  /** Moves when the stored list may have changed. */
  revision: number;
  local?: readonly LocalNotice[];
  /** Where a notice with a link takes the reader. Without it, opening only marks it read. */
  onOpen?: (link: NotificationLink) => void;
}) {
  // Held in a ref: a panel may build the transport inline on every render.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [open, setOpen] = useState(false);
  const [reads, setReads] = useState(0);
  const [items, setItems] = useState<UserNotification[]>([]);
  const [unread, setUnread] = useState(0);
  // The last read failed: the Master is out of reach, or the panel's own server is.
  const [stale, setStale] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    transportRef.current.list().then(
      (result) => {
        if (cancelled) return;
        setItems(result.items);
        setUnread(result.unreadCount);
        setStale(false);
      },
      () => {
        if (!cancelled) setStale(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision, reads]);

  // Esc and a click anywhere else close it, as every other popover does.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function markRead(which: { ids: string[] } | { all: true }): void {
    const at = new Date().toISOString();
    const ids = 'ids' in which ? new Set(which.ids) : null;
    setItems((current) =>
      current.map((item) => (item.readAt || (ids && !ids.has(item.id)) ? item : { ...item, readAt: at })),
    );
    transportRef.current.markRead(which).then(
      (result) => setUnread(result.unreadCount),
      () => setStale(true),
    );
  }

  function openItem(item: UserNotification): void {
    if (!item.readAt) markRead({ ids: [item.id] });
    setOpen(false);
    if (item.link) onOpen?.(item.link);
  }

  const count = unread + local.length;
  const label = count > 0 ? t('notification.unreadLabel', { count }) : t('notification.title');

  return (
    <span ref={wrapRef} className="ob-bell">
      <button
        type="button"
        className="ob-icon-btn"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => {
          if (!open) setReads((value) => value + 1);
          setOpen(!open);
        }}
      >
        <Icon name="bell" />
        {count > 0 && (
          <span className="ob-bell-badge" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="ob-popover ob-bell-list"
          role="region"
          aria-label={t('notification.title')}
          style={{ width: rem(320) }}
        >
          <div className="ob-bell-head">
            <span className="ob-body-strong">{t('notification.title')}</span>
            <span style={{ flex: 1 }} />
            {unread > 0 && (
              <button
                type="button"
                className="ob-btn ob-btn--ghost ob-btn--sm"
                onClick={() => markRead({ all: true })}
              >
                {t('notification.markAllRead')}
              </button>
            )}
          </div>

          {stale && <p className="ob-small ob-bell-note">{t('notification.offlineNote')}</p>}

          {local.length === 0 && items.length === 0 ? (
            <p className="ob-small ob-bell-note">{t('notification.empty')}</p>
          ) : (
            <ul className="ob-bell-items">
              {local.map((notice) => (
                <li key={notice.id} className="ob-bell-item" data-unread="true">
                  <span>{notice.text}</span>
                  <span className="ob-small ob-bell-when">{formatDateTime(notice.createdAt)}</span>
                </li>
              ))}
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="ob-bell-item"
                    data-unread={item.readAt ? undefined : 'true'}
                    onClick={() => openItem(item)}
                  >
                    <span>{notificationText(item)}</span>
                    <span className="ob-small ob-bell-when">{formatDateTime(item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  );
}
