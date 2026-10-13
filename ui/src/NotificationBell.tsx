/**
 * The notification bell in the topbar, on both panels (1.3), and the drawer it
 * slides in from the right: the Notification kit's cards, filed by category,
 * filterable, and grouped Today / Earlier.
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
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type {
  MessageKey,
  NotificationKind,
  NotificationLink,
  UserNotification,
} from '@orderbook/shared';

import { formatDateTime, formatRelative } from './format.js';
import { t } from './i18n.js';
import { Icon, type IconName } from './icons';
import { motionDisabled } from './theme.js';

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
  'lead.numbered': 'notification.lead.numbered',
  'lead.deleted': 'notification.lead.deleted',
  'lead.edited': 'notification.lead.edited',
  'chat.mention': 'notification.chat.mention',
  'task.assigned': 'notification.task.assigned',
  'task.done': 'notification.task.done',
  'access.requested': 'notification.access.requested',
  'print.printed': 'notification.print.printed',
  'backup.autoSkipped': 'notification.backup.autoSkipped',
  'backup.autoFailed': 'notification.backup.autoFailed',
  'update.available': 'notification.update.available',
  'update.installing': 'notification.update.installing',
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

type Tone = 'amber' | 'red' | 'accent' | 'ok' | 'neutral';
type Category = 'devices' | 'orders' | 'chatroom' | 'tasks' | 'access' | 'printroom' | 'backup' | 'updates';

/**
 * The Notification kit's reading of each kind: the category it files under, and its tile. Tile
 * colour carries meaning — amber needs attention, red needs action, blue is information, green
 * is done, grey is chatter.
 */
const KIND_LOOK: Record<NotificationKind, { category: Category; tone: Tone; icon: IconName }> = {
  'panel.offlineLong': { category: 'devices', tone: 'amber', icon: 'monitor-off' },
  'lead.numbered': { category: 'orders', tone: 'accent', icon: 'clipboard' },
  'lead.deleted': { category: 'orders', tone: 'red', icon: 'trash' },
  'lead.edited': { category: 'orders', tone: 'accent', icon: 'edit' },
  'chat.mention': { category: 'chatroom', tone: 'accent', icon: 'mention' },
  'task.assigned': { category: 'tasks', tone: 'accent', icon: 'task' },
  'task.done': { category: 'tasks', tone: 'ok', icon: 'check' },
  'access.requested': { category: 'access', tone: 'amber', icon: 'lock' },
  'print.printed': { category: 'printroom', tone: 'ok', icon: 'print' },
  'backup.autoSkipped': { category: 'backup', tone: 'amber', icon: 'warning' },
  'backup.autoFailed': { category: 'backup', tone: 'red', icon: 'warning' },
  'update.available': { category: 'updates', tone: 'accent', icon: 'update' },
  'update.installing': { category: 'updates', tone: 'accent', icon: 'restart' },
};

/** A kind newer than this build: grey, filed under nothing but All. */
const UNKNOWN_LOOK: { category: null; tone: Tone; icon: IconName } = {
  category: null,
  tone: 'neutral',
  icon: 'bell',
};

const OPEN_TEXT: Record<NotificationLink['kind'], MessageKey> = {
  panel: 'notification.open.panel',
  lead: 'notification.open.lead',
  chat: 'notification.open.chat',
  role: 'notification.open.role',
  print: 'notification.open.print',
  update: 'notification.open.update',
};

const CATEGORY_TEXT: Record<Category, MessageKey> = {
  devices: 'notification.category.devices',
  orders: 'notification.category.orders',
  chatroom: 'notification.category.chatroom',
  tasks: 'notification.category.tasks',
  access: 'notification.category.access',
  printroom: 'notification.category.printroom',
  backup: 'notification.category.backup',
  updates: 'notification.category.updates',
};

/** How long the drawer takes to slide out: `--d-exit` in the stylesheet. */
const EXIT_MS = 140;

/** Motion off in Settings or in the OS: the drawer goes at once instead of sliding out. */
function instantMotion(): boolean {
  return (
    motionDisabled() ||
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isToday(iso: string, now: Date): boolean {
  return new Date(iso).toDateString() === now.toDateString();
}

/** One card in the drawer, stored or the panel's own, as the kit draws it. */
interface Card {
  id: string;
  text: string;
  createdAt: string;
  unread: boolean;
  category: Category | null;
  tone: Tone;
  icon: IconName;
  item: UserNotification | null;
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
  // Sliding out: still on screen, already on its way.
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [reads, setReads] = useState(0);
  const [items, setItems] = useState<UserNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState<Category | 'all'>('all');
  // The last read failed: the Master is out of reach, or the panel's own server is.
  const [stale, setStale] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

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

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  function show(): void {
    clearTimeout(closeTimer.current);
    setClosing(false);
    setReads((value) => value + 1);
    setOpen(true);
  }

  function close(): void {
    clearTimeout(closeTimer.current);
    if (instantMotion()) {
      setOpen(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, EXIT_MS);
  }

  const shown = open && !closing;

  // Esc and a click anywhere else close it, as every other popover does.
  useEffect(() => {
    if (!shown) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || drawerRef.current?.contains(target)) return;
      close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [shown]);

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
    close();
    if (item.link) onOpen?.(item.link);
  }

  const cards: Card[] = [
    ...local.map(
      (notice): Card => ({
        id: notice.id,
        text: notice.text,
        createdAt: notice.createdAt,
        unread: true,
        ...KIND_LOOK['panel.offlineLong'],
        item: null,
      }),
    ),
    ...items.map(
      (item): Card => ({
        id: item.id,
        text: notificationText(item),
        createdAt: item.createdAt,
        unread: !item.readAt,
        ...((KIND_LOOK as Partial<Record<string, (typeof KIND_LOOK)[NotificationKind]>>)[item.kind] ?? UNKNOWN_LOOK),
        item,
      }),
    ),
  ];
  const categories = [...new Set(cards.map((card) => card.category))].filter(
    (category): category is Category => category !== null,
  );
  // A filter whose last card went away falls back to All rather than an empty drawer.
  const active = filter !== 'all' && categories.includes(filter) ? filter : 'all';
  const visible = active === 'all' ? cards : cards.filter((card) => card.category === active);
  const now = new Date();
  const groups = [
    { key: 'notification.group.today' as const, cards: visible.filter((card) => isToday(card.createdAt, now)) },
    { key: 'notification.group.earlier' as const, cards: visible.filter((card) => !isToday(card.createdAt, now)) },
  ].filter((group) => group.cards.length > 0);

  const count = unread + local.length;
  const label = count > 0 ? t('notification.unreadLabel', { count }) : t('notification.title');
  // The badge turns red while anything that needs action is unread.
  const needsAction = cards.some((card) => card.unread && card.tone === 'red');

  function renderCard(card: Card, index: number) {
    const { item } = card;
    return (
      <li key={card.id}>
        <article
          className="ob-ncard"
          data-unread={card.unread ? 'true' : undefined}
          data-tone={card.tone}
          data-clickable={item ? 'true' : undefined}
          style={{ '--i': Math.min(index, 8) } as CSSProperties}
          onClick={item ? () => openItem(item) : undefined}
        >
          <span className={`ob-ntile ob-ntile--${card.tone}`}>
            <Icon name={card.icon} size={17} />
          </span>
          <div className="ob-ncard-body">
            <div className="ob-ncard-meta">
              {card.category ? t(CATEGORY_TEXT[card.category]) : t('notification.title')}
              <span className="ob-ncard-sep">·</span>
              <time dateTime={card.createdAt} title={formatDateTime(card.createdAt)}>
                {formatRelative(card.createdAt)}
              </time>
              {card.unread && <span className="ob-ncard-dot" role="img" aria-label={t('notification.unread')} />}
            </div>
            <span className="ob-ncard-title">{card.text}</span>
            {item?.link && onOpen && (
              <div className="ob-ncard-actions">
                <button
                  type="button"
                  className={`ob-btn ob-btn--sm ${card.unread ? 'ob-btn--primary' : 'ob-btn--secondary'}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openItem(item);
                  }}
                >
                  {t(OPEN_TEXT[item.link.kind])}
                </button>
              </div>
            )}
          </div>
        </article>
      </li>
    );
  }

  let index = 0;
  const drawer = (
    <aside
      ref={drawerRef}
      className="ob-ndrawer"
      data-closing={closing ? 'true' : undefined}
      role="region"
      aria-label={t('notification.title')}
    >
      <div className="ob-ndrawer-head">
        <h2 className="ob-ndrawer-title">{t('notification.title')}</h2>
        {count > 0 && <span className="ob-ndrawer-new">{t('notification.newCount', { count })}</span>}
        <span style={{ flex: 1 }} />
        {unread > 0 && (
          <button type="button" className="ob-btn ob-btn--ghost ob-btn--sm" onClick={() => markRead({ all: true })}>
            {t('notification.markAllRead')}
          </button>
        )}
        <button
          type="button"
          className="ob-icon-btn"
          aria-label={t('action.close')}
          title={t('action.close')}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>

      {categories.length > 1 && (
        <div className="ob-ndrawer-chips">
          {(['all', ...categories] as const).map((category) => (
            <button
              key={category}
              type="button"
              className="ob-nchip"
              aria-pressed={active === category}
              onClick={() => setFilter(category)}
            >
              {category === 'all' ? t('notification.filter.all') : t(CATEGORY_TEXT[category])}
              <span className="ob-nchip-count">
                {category === 'all' ? cards.length : cards.filter((card) => card.category === category).length}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="ob-ndrawer-body">
        {stale && <p className="ob-small ob-ndrawer-note">{t('notification.offlineNote')}</p>}
        {cards.length === 0 ? (
          <div className="ob-ndrawer-empty">
            <span className="ob-ndrawer-empty-tile">
              <Icon name="bell" size={24} />
            </span>
            <span className="ob-body-strong">{t('notification.empty')}</span>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="ob-ngroup">
              <h3 className="ob-eyebrow ob-ngroup-head">{t(group.key)}</h3>
              <ul className="ob-ngroup-list">{group.cards.map((card) => renderCard(card, index++))}</ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );

  return (
    <span ref={wrapRef} className="ob-bell">
      <button
        type="button"
        className="ob-icon-btn"
        aria-label={label}
        title={label}
        aria-expanded={shown}
        onClick={() => (shown ? close() : show())}
      >
        <Icon name="bell" />
        {count > 0 && (
          <span className={`ob-bell-badge${needsAction ? ' ob-bell-badge--action' : ''}`} aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && createPortal(drawer, document.body)}
    </span>
  );
}
