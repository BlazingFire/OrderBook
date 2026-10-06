/**
 * The Chatroom, on both panels: the room list with its search, My tasks, the
 * Groups page, and (as sub-screens with a nested sidebar entry) one open room,
 * a group's settings, and "Share in chat".
 *
 * The sidebar offers Rooms, My tasks and Groups; the shell passes the one being
 * shown as `page`. Which room is open is the shell's too (`openRoom`), so a
 * notification or a chip elsewhere can open one. Everything a panel supplies
 * comes in through `ChatTransport` and three callbacks, and the screen holds
 * the transport in a ref (`no-transport-dep.test.ts`).
 *
 * Every control a right gates is absent without it, never greyed; where a
 * right is missing the screen offers to ask for it ("Request access"), which
 * tells the people who edit roles. The Master decides every call again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatAccessCapability,
  ChatRecordChip,
  ChatRecordRef,
  ChatRoomSummary,
  ChatSearchHit,
  ChatTaskRow,
  ChatPerson,
} from '@orderbook/shared';
import { translator } from './i18n.js';

import { Avatar } from './Avatar.js';
import { Button } from './Button.js';
import { ChatConversation } from './ChatConversation.js';
import { ChatGroupSettings } from './ChatGroupSettings.js';
import { ChatShareScreen } from './ChatShareScreen.js';
import { roomTitle, type ChatRecordOption, type ChatTransport, type ChatViewer } from './chatModel.js';
import { Combobox } from './Combobox.js';
import { apiErrorText } from './errorText.js';
import { FilterChip } from './FilterBar.js';
import { Checkbox, Input } from './Form.js';
import { t } from './i18n.js';
import { Icon } from './icons';
import { Popover } from './Popover.js';
import { EmptyState, ErrorState, OfflineBanner, SkeletonRows } from './States.js';
import { useSubNav } from './SubNavSlot.js';
import { ServerMasterBadge } from './TierPill.js';
import { chatCacheFor } from './chatCache.js';
import { useDebounced } from './useDebounced.js';
import { useToast } from './Toast.js';

/** A burst of pushes is folded into one read of the list. */
const REFRESH_MS = 400;

export type ChatPage = 'rooms' | 'tasks' | 'groups';

/** Which right a person may ask for, in the order the screen offers them. */
const REQUESTABLE: readonly ChatAccessCapability[] = [
  'chat.directMessages',
  'chat.shareRecords',
  'chat.tasks',
  'chat.createGroups',
];

const ACCESS_LABEL = {
  'chat.directMessages': 'permission.chat.directMessages',
  'chat.shareRecords': 'permission.chat.shareRecords',
  'chat.tasks': 'permission.chat.tasks',
  'chat.createGroups': 'permission.chat.createGroups',
} as const;

function isUnavailable(caught: unknown): boolean {
  return (caught as { code?: unknown } | null)?.code === 'unavailable';
}

// --- Reading a list that follows the room pushes -----------------------------------------

function useLive<T>(
  transport: ChatTransport,
  load: () => Promise<T>,
  deps: readonly unknown[],
  /** What was read last time, shown at once while the list is read again. */
  remembered?: { get: () => T | null; set: (value: T) => void },
): { data: T | null; error: string | null; offline: boolean; reload: () => void } {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const loadRef = useRef(load);
  loadRef.current = load;
  const rememberedRef = useRef(remembered);
  rememberedRef.current = remembered;
  const [data, setData] = useState<T | null>(() => remembered?.get() ?? null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (value) => {
        if (cancelled) return;
        rememberedRef.current?.set(value);
        setData(value);
        setError(null);
        setOffline(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        if (isUnavailable(caught)) setOffline(true);
        else setError(apiErrorText(caught, 'chat.error.load'));
      },
    );
    return () => {
      cancelled = true;
    };
    // `deps` are the list's own filters; the loader is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = transportRef.current.subscribe((event) => {
      if (event.kind === 'read') return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((count) => count + 1), REFRESH_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return { data, error, offline, reload: () => setTick((count) => count + 1) };
}

function whenOf(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function preview(room: ChatRoomSummary): string {
  const message = room.lastMessage;
  if (!message) return t('chat.rooms.noMessages');
  const who = message.author?.displayName ?? '';
  const text = message.body !== '' ? message.body : message.refs.length > 0 ? t('chat.rooms.sharedRecord') : '';
  return who ? `${who}: ${text}` : text;
}

function RoomFace({ room }: { room: ChatRoomSummary }) {
  if (room.direct) {
    return (
      <Avatar
        name={room.direct.displayName}
        avatar={room.direct.avatar}
        size="md"
        highlight={room.direct.tier === 'server_master'}
      />
    );
  }
  return (
    <span className="ob-chat-roomicon" aria-hidden="true">
      <Icon name={room.announceOnly ? 'bell' : 'chat'} size={18} />
    </span>
  );
}

// --- Rooms ---------------------------------------------------------------------------------

function AccessRequests({
  transport,
  viewer,
}: {
  transport: ChatTransport;
  viewer: ChatViewer;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const missing = REQUESTABLE.filter(
    (capability) =>
      !viewer.permissions.includes(capability) &&
      !viewer.permissions.includes('chat.manage') &&
      // A key above this person's tier cannot be granted to their role, so it is not offered.
      (capability !== 'chat.createGroups' || (viewer.tier !== undefined && viewer.tier !== 'office')),
  );
  if (missing.length === 0) return null;

  async function ask(capability: ChatAccessCapability): Promise<void> {
    setBusy(capability);
    try {
      const result = await transport.requestAccess(capability);
      toast.push(result.notified > 0 ? t('chat.access.sent') : t('chat.access.nobody'), {
        tone: result.notified > 0 ? 'ok' : 'info',
      });
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.access'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="ob-chat-access" aria-label={t('chat.access.title')}>
      <p className="ob-small">{t('chat.access.hint')}</p>
      <div className="ob-chat-access-actions">
        {missing.map((capability) => (
          <Button
            key={capability}
            size="sm"
            busy={busy === capability}
            onClick={() => void ask(capability)}
          >
            {t('chat.access.ask', { right: t(ACCESS_LABEL[capability]) })}
          </Button>
        ))}
      </div>
    </section>
  );
}

function RoomsPage({
  transport,
  viewer,
  onOpenRoom,
  onNewGroup,
}: {
  transport: ChatTransport;
  viewer: ChatViewer;
  onOpenRoom: (room: { id: string; seq?: number }) => void;
  onNewGroup: () => void;
}) {
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [term, setTerm] = useState('');
  const [directOpen, setDirectOpen] = useState(false);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const debounced = useDebounced(term);
  const searching = debounced.trim().length >= 2;

  const roomCache = chatCacheFor(transport);
  roomCache.forViewer(viewer.id);
  const roomsKey = archived ? 'rooms:archived' : 'rooms';
  const rooms = useLive(transport, () => transport.rooms({ includeArchived: archived }), [archived], {
    get: () => roomCache.roomList(roomsKey),
    set: (list) => roomCache.setRoomList(roomsKey, list),
  });
  const hits = useLive<ChatSearchHit[]>(
    transport,
    () => (searching ? transport.search(debounced.trim()) : Promise.resolve([])),
    [searching, debounced],
  );

  const canDirect = viewer.permissions.includes('chat.directMessages');
  const canCreate = viewer.permissions.includes('chat.createGroups') || viewer.permissions.includes('chat.manage');

  useEffect(() => {
    if (!directOpen || people.length > 0) return;
    let cancelled = false;
    void transport.people().then(
      (found) => {
        if (!cancelled) setPeople(found.filter((person) => person.id !== viewer.id));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // The picker loads the people once, the first time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directOpen]);

  async function startDirect(userId: string): Promise<void> {
    setDirectOpen(false);
    try {
      const room = await transport.direct(userId);
      onOpenRoom({ id: room.id });
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.direct'), { tone: 'error' });
    }
  }

  return (
    <div className="ob-chat-page">
      <div className="ob-chat-toolbar">
        <Input
          data-screen-search
          className="ob-chat-search"
          type="search"
          value={term}
          placeholder={t('chat.rooms.search')}
          aria-label={t('chat.rooms.search')}
          onChange={(event) => setTerm(event.target.value)}
        />
        {canDirect && (
          <span className="ob-chat-directwrap">
            <Button icon="plus" onClick={() => setDirectOpen((open) => !open)} aria-expanded={directOpen}>
              {t('chat.rooms.newDirect')}
            </Button>
            <Popover
              open={directOpen}
              onClose={() => setDirectOpen(false)}
              anchorStyle={{ top: 'calc(100% + var(--s-4))', right: 0 }}
            >
              <div className="ob-chat-picker-body">
                <Combobox
                  autoFocus
                  placeholder={t('chat.rooms.pickPerson')}
                  options={people.map((person) => ({
                    key: person.id,
                    label: person.displayName,
                    value: person.id,
                  }))}
                  onSelect={(option) => void startDirect(option.value)}
                />
              </div>
            </Popover>
          </span>
        )}
        {canCreate && (
          <Button icon="plus" onClick={onNewGroup}>
            {t('chat.rooms.newGroup')}
          </Button>
        )}
        <FilterChip active={archived} onClick={() => setArchived((on) => !on)}>
          {t('chat.rooms.showArchived')}
        </FilterChip>
      </div>

      {(rooms.offline || hits.offline) && <OfflineBanner>{t('chat.offline')}</OfflineBanner>}

      {searching ? (
        <div className="ob-chat-results" aria-label={t('chat.search.results')}>
          {hits.data === null ? (
            <SkeletonRows rows={4} columns={2} />
          ) : hits.data.length === 0 ? (
            <EmptyState title={t('chat.search.none')} />
          ) : (
            <ul className="ob-chat-roomlist">
              {hits.data.map((hit) => (
                <li key={hit.message.id}>
                  <button
                    type="button"
                    className="ob-chat-roomrow"
                    onClick={() => onOpenRoom({ id: hit.roomId, seq: hit.message.seq })}
                  >
                    <span className="ob-chat-roomtext">
                      <span className="ob-body-strong">
                        {hit.roomName ?? hit.message.author?.displayName ?? ''}
                      </span>
                      <span className="ob-small ob-chat-preview">
                        {hit.message.author?.displayName}: {hit.message.body}
                      </span>
                    </span>
                    <span className="ob-small">{whenOf(hit.message.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : rooms.error ? (
        <ErrorState title={t('chat.error.load')} description={rooms.error} onAction={rooms.reload} />
      ) : rooms.data === null ? (
        rooms.offline ? null : <SkeletonRows rows={5} columns={2} />
      ) : rooms.data.length === 0 ? (
        <EmptyState title={t('chat.rooms.empty')} description={t('chat.rooms.emptyHint')} />
      ) : (
        <ul className="ob-chat-roomlist">
          {rooms.data.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                className="ob-chat-roomrow"
                data-unread={room.unread > 0 ? 'true' : undefined}
                onClick={() => onOpenRoom({ id: room.id })}
              >
                <RoomFace room={room} />
                <span className="ob-chat-roomtext">
                  <span className="ob-body-strong">
                    {roomTitle(room)}
                    {room.direct?.tier === 'server_master' && <ServerMasterBadge />}
                    {room.archivedAt && <span className="ob-chat-badge">{t('chat.rooms.archived')}</span>}
                    {room.announceOnly && <span className="ob-chat-badge">{t('chat.rooms.announcement')}</span>}
                  </span>
                  <span className="ob-small ob-chat-preview">{preview(room)}</span>
                </span>
                <span className="ob-chat-roommeta">
                  <span className="ob-small">{whenOf(room.lastMessageAt)}</span>
                  <span className="ob-chat-roomflags">
                    {room.muted && <span className="ob-small">{t('chat.rooms.muted')}</span>}
                    {room.mentionUnread > 0 && (
                      <span className="ob-chat-mention" title={t('chat.rooms.mentioned')}>
                        @
                      </span>
                    )}
                    {room.unread > 0 && (
                      <span className="ob-chat-unread" aria-label={t('chat.rooms.unreadLabel', { count: room.unread })}>
                        {room.unread > 99 ? '99+' : room.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <AccessRequests transport={transport} viewer={viewer} />
    </div>
  );
}

// --- My tasks ----------------------------------------------------------------------------------

function TasksPage({
  transport,
  onOpenRoom,
}: {
  transport: ChatTransport;
  onOpenRoom: (room: { id: string; seq?: number }) => void;
}) {
  const toast = useToast();
  const [scope, setScope] = useState<'mine' | 'created'>('mine');
  const [showDone, setShowDone] = useState(false);
  const tasks = useLive<ChatTaskRow[]>(transport, () => transport.tasks(scope, showDone), [scope, showDone]);

  async function tick(row: ChatTaskRow, done: boolean): Promise<void> {
    try {
      await transport.taskDone(row.message.id, done);
      tasks.reload();
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.task'), { tone: 'error' });
    }
  }

  return (
    <div className="ob-chat-page">
      <div className="ob-chat-toolbar">
        <FilterChip active={scope === 'mine'} onClick={() => setScope('mine')}>
          {t('chat.tasks.mine')}
        </FilterChip>
        <FilterChip active={scope === 'created'} onClick={() => setScope('created')}>
          {t('chat.tasks.created')}
        </FilterChip>
        <FilterChip active={showDone} onClick={() => setShowDone((on) => !on)}>
          {t('chat.tasks.showDone')}
        </FilterChip>
      </div>
      {tasks.offline && <OfflineBanner>{t('chat.offline')}</OfflineBanner>}
      {tasks.error ? (
        <ErrorState title={t('chat.error.load')} description={tasks.error} onAction={tasks.reload} />
      ) : tasks.data === null ? (
        tasks.offline ? null : <SkeletonRows rows={4} columns={2} />
      ) : tasks.data.length === 0 ? (
        <EmptyState title={t('chat.tasks.empty')} />
      ) : (
        <ul className="ob-chat-roomlist">
          {tasks.data.map((row) => (
            <li key={row.message.id} className="ob-chat-taskrow" data-done={row.message.task?.doneAt ? 'true' : undefined}>
              <Checkbox
                checked={row.message.task?.doneAt !== null && row.message.task?.doneAt !== undefined}
                onChange={(done) => void tick(row, done)}
                label={row.message.task?.doneAt ? t('chat.task.undo') : t('chat.task.markDone')}
              />
              <button
                type="button"
                className="ob-chat-roomrow"
                onClick={() => onOpenRoom({ id: row.roomId, seq: row.message.seq })}
              >
                <span className="ob-chat-roomtext">
                  <span className="ob-body-strong">{row.message.body || t('chat.rooms.sharedRecord')}</span>
                  <span className="ob-small ob-chat-preview">
                    {[
                      row.roomName,
                      t('chat.task.for', {
                        names: (row.message.task?.assignees ?? []).map((person) => person.displayName).join(', '),
                      }),
                      row.message.task?.dueOn ? t('chat.task.due', { date: row.message.task.dueOn }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Groups ---------------------------------------------------------------------------------------

function GroupsPage({
  transport,
  viewer,
  onOpenRoom,
  onSettings,
  onNewGroup,
}: {
  transport: ChatTransport;
  viewer: ChatViewer;
  onOpenRoom: (room: { id: string }) => void;
  onSettings: (roomId: string) => void;
  onNewGroup: () => void;
}) {
  const manager = viewer.permissions.includes('chat.manage');
  const groups = useLive<ChatRoomSummary[]>(
    transport,
    async () =>
      (await transport.rooms({ all: manager, includeArchived: true })).filter((room) => room.kind !== 'direct'),
    [manager],
  );

  return (
    <div className="ob-chat-page">
      <div className="ob-chat-toolbar">
        <span style={{ flex: 1 }} />
        <Button icon="plus" variant="primary" onClick={onNewGroup}>
          {t('chat.rooms.newGroup')}
        </Button>
      </div>
      {groups.offline && <OfflineBanner>{t('chat.offline')}</OfflineBanner>}
      {groups.error ? (
        <ErrorState title={t('chat.error.load')} description={groups.error} onAction={groups.reload} />
      ) : groups.data === null ? (
        groups.offline ? null : <SkeletonRows rows={4} columns={2} />
      ) : groups.data.length === 0 ? (
        <EmptyState title={t('chat.groups.empty')} />
      ) : (
        <ul className="ob-chat-roomlist">
          {groups.data.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                className="ob-chat-roomrow"
                onClick={() =>
                  room.myRole === 'admin' || manager ? onSettings(room.id) : onOpenRoom({ id: room.id })
                }
              >
                <RoomFace room={room} />
                <span className="ob-chat-roomtext">
                  <span className="ob-body-strong">
                    {roomTitle(room)}
                    {room.archivedAt && <span className="ob-chat-badge">{t('chat.rooms.archived')}</span>}
                    {room.announceOnly && <span className="ob-chat-badge">{t('chat.rooms.announcement')}</span>}
                  </span>
                  <span className="ob-small ob-chat-preview">
                    {translator().tCount('chat.room.members', room.memberCount)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- The screen --------------------------------------------------------------------------------------

export interface ChatroomScreenProps {
  transport: ChatTransport;
  page: ChatPage;
  viewer: ChatViewer;
  /** The room open as a sub-screen, and the message to land on. */
  openRoom: { id: string; seq?: number } | null;
  onOpenRoom: (room: { id: string; seq?: number } | null) => void;
  /** A record to share, from "Share in chat" on a pending or final order. */
  share: ChatRecordChip | null;
  onShareDone: (roomId: string | null) => void;
  onOpenRecord: (record: ChatRecordRef) => void;
  findRecords: (term: string) => Promise<ChatRecordOption[]>;
  /** Moves when the sidebar picks a page, which closes a group's settings left open. */
  resetNonce?: number;
}

export function ChatroomScreen(props: ChatroomScreenProps) {
  const { transport, viewer } = props;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [settings, setSettings] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const sub = props.share ? 'share' : settings !== null ? 'settings' : props.openRoom ? 'room' : null;
  const label =
    sub === 'share'
      ? t('chat.share.title')
      : sub === 'settings'
        ? settings === 'new'
          ? t('chat.rooms.newGroup')
          : t('chat.group.title')
        : sub === 'room'
          ? title || t('nav.chatroom')
          : '';

  // The open room, settings or share sheet is the current page in the sidebar, under Chatroom.
  useSubNav(
    'chatroom',
    sub ? { parentId: 'chatroom', activeId: 'chatroom.open', items: [{ id: 'chatroom.open', label, icon: 'chat' }] } : null,
  );

  // A page picked in the sidebar leaves a settings sub-screen.
  useEffect(() => {
    setSettings(null);
  }, [props.resetNonce, props.page]);

  // Leaving a room by the sidebar must not leave a stale title for the next one.
  useEffect(() => {
    if (!props.openRoom) setTitle('');
  }, [props.openRoom]);

  const onTitle = useCallback((next: string) => setTitle(next), []);

  if (props.share) {
    return (
      <ChatShareScreen
        transport={transport}
        chip={props.share}
        viewer={viewer}
        onBack={() => props.onShareDone(null)}
        onShared={(roomId) => props.onShareDone(roomId)}
      />
    );
  }

  if (settings !== null) {
    return (
      <ChatGroupSettings
        transport={transport}
        roomId={settings}
        viewer={viewer}
        onBack={() => setSettings(null)}
        onSaved={(roomId) => {
          setSettings(null);
          props.onOpenRoom({ id: roomId });
        }}
        onLeft={() => {
          setSettings(null);
          props.onOpenRoom(null);
        }}
      />
    );
  }

  if (props.openRoom) {
    return (
      <ChatConversation
        key={props.openRoom.id}
        transport={transport}
        roomId={props.openRoom.id}
        viewer={viewer}
        focusSeq={props.openRoom.seq ?? null}
        onBack={() => props.onOpenRoom(null)}
        onOpenSettings={(roomId) => setSettings(roomId)}
        onOpenRecord={props.onOpenRecord}
        findRecords={props.findRecords}
        onTitle={onTitle}
      />
    );
  }

  if (props.page === 'tasks') {
    return <TasksPage transport={transport} onOpenRoom={props.onOpenRoom} />;
  }

  if (props.page === 'groups') {
    return (
      <GroupsPage
        transport={transport}
        viewer={viewer}
        onOpenRoom={props.onOpenRoom}
        onSettings={(roomId) => setSettings(roomId)}
        onNewGroup={() => setSettings('new')}
      />
    );
  }

  return (
    <RoomsPage
      transport={transport}
      viewer={viewer}
      onOpenRoom={props.onOpenRoom}
      onNewGroup={() => setSettings('new')}
    />
  );
}
