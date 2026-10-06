/**
 * One chat room: the pinned bar, the messages, and the composer.
 *
 * Text only. A message is plain words (never turned into links), at most a few
 * record chips, and, for people who may, a task. There is deliberately no
 * control for attaching a file or a picture anywhere in this file.
 *
 * Messages are held per room up to `CHAT_LIMITS.keepInMemory`; older ones are
 * fetched with "Load older". Rows use `content-visibility: auto`, so a long
 * room costs little to draw. The Master pushes everything live (a new message,
 * an edit, a pin, a task tick, a member's read position) and a reconnect asks
 * for the room again. A post made with no link is shown as "Sending…" and is
 * replaced by the Master's copy when it arrives (same `clientId`).
 *
 * What a person may do is decided by the Master on every call; the controls
 * here are absent, not greyed, where the right is missing, as everywhere.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  ChatPerson,
  ChatRecordChip,
  ChatRecordRef,
  ChatRoomDetail,
  ChatRoomMember,
} from '@orderbook/shared';
import { CHAT_LIMITS, CHAT_SYSTEM_KEYS, withinEditWindow } from '@orderbook/shared';

import { Avatar } from './Avatar.js';
import { Button, IconButton } from './Button.js';
import {
  applyChatPush,
  dayKeyOf,
  groupByDay,
  lastSeqOf,
  mentionQueryAt,
  mentionsStillIn,
  mergeMessages,
  receiptsFor,
  relativeDay,
  roomTitle,
  type ChatRecordOption,
  type ChatTransport,
  type ChatViewer,
} from './chatModel.js';
import { useConfirm } from './ConfirmDialog.js';
import { apiErrorText } from './errorText.js';
import { Checkbox, DateField, Input, Textarea } from './Form.js';
import { translator, t } from './i18n.js';
import { Icon } from './icons';
import { OfflineBanner, ErrorState } from './States.js';
import { Popover } from './Popover.js';
import { ServerMasterBadge } from './TierPill.js';
import { chatCacheFor } from './chatCache.js';
import { useDebounced } from './useDebounced.js';
import { useToast } from './Toast.js';
import { useUnsavedWork } from './unsavedWork.js';

/** How long a person must have a room open at the bottom before it counts as read. */
const READ_DELAY_MS = 1_000;

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(day: string): string {
  const relative = relativeDay(day, new Date());
  if (relative === 'today') return t('chat.day.today');
  if (relative === 'yesterday') return t('chat.day.yesterday');
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y as number, (m as number) - 1, d as number).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function isUnavailable(caught: unknown): boolean {
  return (caught as { code?: unknown } | null)?.code === 'unavailable';
}

function pendingOf(caught: unknown): ChatMessage[] {
  const pending = (caught as { pending?: unknown } | null)?.pending;
  return Array.isArray(pending) ? (pending as ChatMessage[]) : [];
}

// --- A record chip ----------------------------------------------------------------

function RecordChip({
  record,
  onOpen,
  onRemove,
}: {
  record: ChatRecordRef;
  onOpen?: (record: ChatRecordRef) => void;
  onRemove?: () => void;
}) {
  const kind = record.kind === 'lead' ? t('chat.ref.lead') : t('chat.ref.order');
  const text = record.restricted
    ? t('chat.ref.restricted')
    : `${kind} ${record.label ?? record.id}${record.partyName ? ` · ${record.partyName}` : ''}`;

  return (
    <span className="ob-chat-chip" data-restricted={record.restricted ? 'true' : undefined}>
      <button
        type="button"
        className="ob-chat-chip-open"
        disabled={record.restricted || !onOpen}
        onClick={() => onOpen?.(record)}
      >
        <Icon name={record.kind === 'lead' ? 'leads' : 'orders'} size={12} />
        <span>{text}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="ob-chat-chip-remove"
          aria-label={t('chat.composer.removeRef', { label: record.label ?? record.id })}
          onClick={onRemove}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

function PersonName({ person }: { person: ChatPerson | null }) {
  if (!person) return <span className="ob-chat-author">{t('chat.message.unknownAuthor')}</span>;
  return (
    <span className="ob-chat-author">
      {person.displayName}
      {person.tier === 'server_master' && <ServerMasterBadge />}
    </span>
  );
}

// --- One message ---------------------------------------------------------------------

interface MessageRowProps {
  message: ChatMessage;
  showHeader: boolean;
  viewer: ChatViewer;
  detail: ChatRoomDetail;
  highlighted: boolean;
  mentionsMe: boolean;
  onOpenRecord: (record: ChatRecordRef) => void;
  onEdit: (message: ChatMessage, body: string) => Promise<void>;
  onDelete: (message: ChatMessage) => void;
  onPin: (message: ChatMessage, pinned: boolean) => void;
  onTaskDone: (message: ChatMessage, done: boolean) => void;
}

function MessageRow(props: MessageRowProps) {
  const { message, viewer, detail } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (message.kind === 'system' && message.system) {
    return (
      <div className="ob-chat-system" data-seq={message.seq}>
        {t(CHAT_SYSTEM_KEYS[message.system.event], message.system.params)}
      </div>
    );
  }

  const own = message.author?.id === viewer.id;
  const isManager = viewer.permissions.includes('chat.manage');
  const isRoomAdmin = detail.myRole === 'admin';
  const moderator = detail.kind !== 'direct' && (isRoomAdmin || isManager);
  const deleted = message.deletedAt !== null;
  const inWindow = !message.pending && withinEditWindow(message.createdAt, Date.now());
  const canEdit = own && inWindow && !deleted && !detail.archivedAt;
  const canDelete = !deleted && !message.pending && ((own && inWindow) || moderator);
  const canPin = moderator && !deleted && !message.pending && !detail.archivedAt;
  const hasMenu = canEdit || canDelete || canPin;

  const task = message.task;
  const assigneeIds = task?.assignees.map((person) => person.id) ?? [];
  const canTick =
    !!task && !deleted && (assigneeIds.includes(viewer.id) || own || moderator) && !message.pending;
  const receipts = task ? receiptsFor(message, detail.members) : null;

  return (
    <div
      className="ob-chat-row"
      data-seq={message.seq}
      data-own={own ? 'true' : undefined}
      data-highlight={props.highlighted ? 'true' : undefined}
      data-mention={props.mentionsMe ? 'true' : undefined}
    >
      <div className="ob-chat-avatar">
        {props.showHeader && message.author && (
          <Avatar
            name={message.author.displayName}
            avatar={message.author.avatar}
            size="sm"
            highlight={message.author.tier === 'server_master'}
          />
        )}
      </div>
      <div className="ob-chat-bubble">
        {props.showHeader && (
          <div className="ob-chat-head">
            <PersonName person={message.author} />
            <span className="ob-small ob-chat-time">{timeOf(message.createdAt)}</span>
            {message.pinnedAt && <Icon name="pin" size={12} />}
          </div>
        )}

        {deleted ? (
          <p className="ob-chat-deleted">{t('chat.message.deleted')}</p>
        ) : editing !== null ? (
          <div className="ob-chat-edit">
            <Textarea
              value={editing}
              maxLength={CHAT_LIMITS.bodyMax}
              rows={3}
              aria-label={t('chat.message.edit')}
              onChange={(event) => setEditing(event.target.value)}
            />
            <div className="ob-chat-edit-actions">
              <Button
                size="sm"
                variant="primary"
                busy={busy}
                disabled={editing.trim() === '' && message.refs.length === 0}
                onClick={() => {
                  setBusy(true);
                  void props
                    .onEdit(message, editing)
                    .then(() => setEditing(null))
                    .catch(() => undefined)
                    .finally(() => setBusy(false));
                }}
              >
                {t('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {message.body !== '' && (
              <p className="ob-chat-body">
                {message.body}
                {message.editedAt && <span className="ob-small"> {t('chat.message.edited')}</span>}
              </p>
            )}
            {message.refs.length > 0 && (
              <div className="ob-chat-refs">
                {message.refs.map((ref) => (
                  <RecordChip key={`${ref.kind}:${ref.id}`} record={ref} onOpen={props.onOpenRecord} />
                ))}
              </div>
            )}
          </>
        )}

        {task && !deleted && (
          <div className="ob-chat-task" data-done={task.doneAt ? 'true' : undefined}>
            <div className="ob-chat-task-head">
              <Icon name="task" size={14} />
              <span className="ob-body-strong">
                {t('chat.task.for', { names: task.assignees.map((person) => person.displayName).join(', ') })}
              </span>
              {task.dueOn && <span className="ob-small">{t('chat.task.due', { date: task.dueOn })}</span>}
            </div>
            <Checkbox
              checked={task.doneAt !== null}
              disabled={!canTick}
              onChange={(done) => props.onTaskDone(message, done)}
              label={task.doneAt ? t('chat.task.undo') : t('chat.task.markDone')}
            />
            {task.doneAt && task.doneBy && (
              <span className="ob-small">{t('chat.task.doneBy', { name: task.doneBy.displayName })}</span>
            )}
            {receipts && receipts.total > 0 && !message.pending && (
              <span className="ob-chat-seen">
                <button
                  type="button"
                  className="ob-btn ob-btn--ghost ob-btn--sm"
                  aria-expanded={receiptsOpen}
                  onClick={() => setReceiptsOpen((open) => !open)}
                >
                  {translator().tCount('chat.task.seenBy', receipts.seen.length, { total: receipts.total })}
                </button>
                <Popover open={receiptsOpen} onClose={() => setReceiptsOpen(false)}>
                  <ul className="ob-chat-seen-list">
                    {detail.members
                      .filter((member) => member.id !== message.author?.id)
                      .map((member) => (
                        <li key={member.id} data-seen={member.lastReadSeq >= message.seq ? 'true' : undefined}>
                          {member.displayName}
                        </li>
                      ))}
                  </ul>
                </Popover>
              </span>
            )}
          </div>
        )}

        {message.pending && <span className="ob-small ob-chat-sending">{t('chat.message.sending')}</span>}
      </div>

      {hasMenu && editing === null && (
        <div className="ob-chat-actions">
          <IconButton
            icon="more"
            label={t('chat.message.actions')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          />
          <Popover open={menuOpen} onClose={() => setMenuOpen(false)}>
            <div className="ob-chat-menu" role="menu">
              {canEdit && (
                <button
                  type="button"
                  role="menuitem"
                  className="ob-chat-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditing(message.body);
                  }}
                >
                  {t('chat.message.edit')}
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  role="menuitem"
                  className="ob-chat-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onDelete(message);
                  }}
                >
                  {t('chat.message.delete')}
                </button>
              )}
              {canPin && (
                <button
                  type="button"
                  role="menuitem"
                  className="ob-chat-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onPin(message, message.pinnedAt === null);
                  }}
                >
                  {message.pinnedAt ? t('chat.message.unpin') : t('chat.message.pin')}
                </button>
              )}
            </div>
          </Popover>
        </div>
      )}
    </div>
  );
}

// --- The composer ------------------------------------------------------------------------

interface ComposerDraft {
  body: string;
  refs: ChatRecordChip[];
  mentions: string[];
  task: { assignees: string[]; dueOn: string | null } | null;
}

function Composer({
  members,
  viewer,
  findRecords,
  onSend,
  roomKey,
}: {
  members: readonly ChatRoomMember[];
  viewer: ChatViewer;
  findRecords: (term: string) => Promise<ChatRecordOption[]>;
  onSend: (draft: ComposerDraft) => Promise<void>;
  /** A new room starts a new draft. */
  roomKey: string;
}) {
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<ChatRecordOption[]>([]);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [asTask, setAsTask] = useState(false);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [dueOn, setDueOn] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<ChatRecordOption[]>([]);
  const [sending, setSending] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef(findRecords);
  findRef.current = findRecords;
  const debouncedTerm = useDebounced(term);

  const canShare = viewer.permissions.includes('chat.shareRecords');
  const canTask = viewer.permissions.includes('chat.tasks');

  useEffect(() => {
    setText('');
    setRefs([]);
    setPicked(new Map());
    setMention(null);
    setAsTask(false);
    setAssignees([]);
    setDueOn('');
    setPickerOpen(false);
  }, [roomKey]);

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    void findRef.current(debouncedTerm.trim()).then(
      (found) => {
        if (!cancelled) setOptions(found);
      },
      () => {
        if (!cancelled) setOptions([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, debouncedTerm]);

  const candidates = mention
    ? members
        .filter((member) => member.id !== viewer.id)
        .filter((member) => member.displayName.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 6)
    : [];

  function chooseMention(member: ChatRoomMember): void {
    if (!mention) return;
    const caret = areaRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${member.displayName} ${text.slice(caret)}`;
    setText(next);
    setPicked((current) => new Map(current).set(member.id, member.displayName));
    setMention(null);
    const position = mention.start + member.displayName.length + 2;
    window.setTimeout(() => {
      areaRef.current?.focus();
      areaRef.current?.setSelectionRange(position, position);
    }, 0);
  }

  const trimmed = text.trim();
  const taskReady = !asTask || assignees.length > 0;
  const canSend = (trimmed !== '' || refs.length > 0) && taskReady && !sending;
  const left = CHAT_LIMITS.bodyMax - text.length;

  // "Save all and update": a message half-written is named, never sent. It would
  // go to other people in the writer's name, which an update has no business doing.
  useUnsavedWork(
    `chat-draft:${roomKey}`,
    text.trim() ? { label: t('updates.saveAll.chatMessage', { text: text.trim().slice(0, 40) }) } : null,
  );

  async function send(): Promise<void> {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend({
        body: trimmed,
        refs: refs.map(({ kind, id }) => ({ kind, id })),
        mentions: mentionsStillIn(trimmed, picked),
        task: asTask ? { assignees, dueOn: dueOn === '' ? null : dueOn } : null,
      });
      setText('');
      setRefs([]);
      setPicked(new Map());
      setAsTask(false);
      setAssignees([]);
      setDueOn('');
    } catch {
      // The screen has already said why; the draft stays for another try.
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="ob-chat-composer">
      {refs.length > 0 && (
        <div className="ob-chat-refs">
          {refs.map((ref) => (
            <RecordChip
              key={`${ref.kind}:${ref.id}`}
              record={{ ...ref, restricted: false, partyName: ref.partyName }}
              onRemove={() => setRefs((current) => current.filter((item) => item !== ref))}
            />
          ))}
        </div>
      )}

      {asTask && (
        <div className="ob-chat-taskform">
          <span className="ob-body-strong">{t('chat.composer.assignees')}</span>
          <div className="ob-chat-assignees">
            {members.map((member) => (
              <Checkbox
                key={member.id}
                checked={assignees.includes(member.id)}
                onChange={(checked) =>
                  setAssignees((current) =>
                    checked ? [...current, member.id] : current.filter((id) => id !== member.id),
                  )
                }
                label={member.displayName}
              />
            ))}
          </div>
          <label className="ob-chat-due">
            <span className="ob-small">{t('chat.composer.due')}</span>
            <DateField value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
          </label>
        </div>
      )}

      <div className="ob-chat-inputrow">
        <div className="ob-chat-inputwrap">
          <textarea
            ref={areaRef}
            className="ob-textarea"
            rows={2}
            value={text}
            maxLength={CHAT_LIMITS.bodyMax}
            placeholder={t('chat.composer.placeholder')}
            aria-label={t('chat.composer.placeholder')}
            onChange={(event) => {
              setText(event.target.value);
              setMention(mentionQueryAt(event.target.value, event.target.selectionStart));
              setMentionIndex(0);
            }}
            onClick={(event) =>
              setMention(mentionQueryAt(text, (event.target as HTMLTextAreaElement).selectionStart))
            }
            onKeyDown={(event) => {
              if (mention && candidates.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setMentionIndex((index) => Math.min(index + 1, candidates.length - 1));
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMentionIndex((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  chooseMention(candidates[mentionIndex] as ChatRoomMember);
                  return;
                }
              }
              if (event.key === 'Escape' && mention) {
                event.preventDefault();
                setMention(null);
                return;
              }
              // Enter sends, Shift+Enter is a new line, and a key that is picking a character is left alone.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {mention && candidates.length > 0 && (
            <ul className="ob-chat-mentions" role="listbox" aria-label={t('chat.composer.mentionList')}>
              {candidates.map((member, index) => (
                <li
                  key={member.id}
                  role="option"
                  aria-selected={index === mentionIndex}
                  data-active={index === mentionIndex ? 'true' : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseMention(member);
                  }}
                >
                  {member.displayName}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="ob-chat-send">
          {canShare && (
            <span className="ob-chat-picker">
              <IconButton
                icon="plus"
                label={t('chat.composer.addRecord')}
                aria-expanded={pickerOpen}
                disabled={refs.length >= CHAT_LIMITS.refsMax}
                onClick={() => setPickerOpen((open) => !open)}
              />
              <Popover
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                anchorStyle={{ bottom: 'calc(100% + var(--s-4))', right: 0 }}
              >
                <div className="ob-chat-picker-body">
                  <Input
                    autoFocus
                    value={term}
                    placeholder={t('chat.ref.search')}
                    aria-label={t('chat.ref.search')}
                    onChange={(event) => setTerm(event.target.value)}
                  />
                  <ul className="ob-chat-picker-list">
                    {options.length === 0 && <li className="ob-small">{t('chat.ref.none')}</li>}
                    {options.map((option) => (
                      <li key={`${option.kind}:${option.id}`}>
                        <button
                          type="button"
                          className="ob-chat-menu-item"
                          onClick={() => {
                            setRefs((current) =>
                              current.some((item) => item.kind === option.kind && item.id === option.id)
                                ? current
                                : [...current, option],
                            );
                            setPickerOpen(false);
                          }}
                        >
                          {`${option.kind === 'lead' ? t('chat.ref.lead') : t('chat.ref.order')} ${option.label} · ${option.partyName}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </Popover>
            </span>
          )}
          {canTask && (
            <Button
              size="sm"
              variant={asTask ? 'primary' : 'ghost'}
              icon="task"
              aria-pressed={asTask}
              onClick={() => setAsTask((on) => !on)}
            >
              {t('chat.composer.task')}
            </Button>
          )}
          {left <= 500 && <span className="ob-small ob-chat-counter">{t('chat.composer.counter', { left })}</span>}
          <Button variant="primary" busy={sending} disabled={!canSend} onClick={() => void send()}>
            {t('chat.composer.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- The room ------------------------------------------------------------------------------

export interface ChatConversationProps {
  transport: ChatTransport;
  roomId: string;
  viewer: ChatViewer;
  /** Load the page around this message, and mark it. */
  focusSeq?: number | null;
  onBack: () => void;
  onOpenSettings: (roomId: string) => void;
  onOpenRecord: (record: ChatRecordRef) => void;
  findRecords: (term: string) => Promise<ChatRecordOption[]>;
  /** The room's name, once known, for the sidebar's nested entry. */
  onTitle?: (title: string) => void;
}

export function ChatConversation(props: ChatConversationProps) {
  const { roomId, viewer } = props;
  const transportRef = useRef(props.transport);
  transportRef.current = props.transport;
  const callbacks = useRef(props);
  callbacks.current = props;

  const toast = useToast();
  const confirm = useConfirm();

  const [detail, setDetail] = useState<ChatRoomDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [highlightSeq, setHighlightSeq] = useState<number | null>(props.focusSeq ?? null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const readSent = useRef(0);
  const stickToBottom = useRef(true);

  const apply = useCallback((update: (current: ChatMessage[]) => ChatMessage[]) => setMessages(update), []);

  const loadAll = useCallback(
    async (focus: number | null) => {
      setFailed(null);
      let room: ChatRoomDetail | null = null;
      try {
        room = await transportRef.current.room(roomId);
        chatCacheFor(transportRef.current).setDetail(roomId, room);
        setDetail(room);
        setOffline(false);
        callbacks.current.onTitle?.(roomTitle(room));
      } catch (caught) {
        if (isUnavailable(caught)) setOffline(true);
        else {
          setFailed(apiErrorText(caught, 'chat.error.load'));
          setLoading(false);
          return;
        }
      }

      if (room && !room.myRole) {
        // An administrator looking at a group they are not in: no messages until they join.
        setMessages([]);
        setHasOlder(false);
        setLoading(false);
        return;
      }

      try {
        const page = await transportRef.current.messages(
          roomId,
          focus ? { beforeSeq: focus + 26, limit: CHAT_LIMITS.pageSize } : { limit: CHAT_LIMITS.pageSize },
        );
        // A reload keeps what is held and folds the newest page into it.
        const older = page.length >= CHAT_LIMITS.pageSize && (page[0]?.seq ?? 1) > 1;
        setMessages((current) => (focus ? mergeMessages([], page, 'oldest') : mergeMessages(current, page)));
        setHasOlder(older);
        if (!focus) chatCacheFor(transportRef.current).mergePage(roomId, page, older);
        setOffline(false);
      } catch (caught) {
        if (isUnavailable(caught)) {
          setOffline(true);
          const queued = pendingOf(caught);
          if (queued.length > 0) setMessages((current) => mergeMessages(current, queued));
        } else {
          setFailed(apiErrorText(caught, 'chat.error.load'));
        }
      } finally {
        setLoading(false);
      }
    },
    [roomId],
  );

  // Open a room: start fresh, then follow it live.
  useEffect(() => {
    // A room read before (or followed live since) opens from memory; the read below reconciles it quietly.
    const cache = chatCacheFor(transportRef.current);
    cache.forViewer(viewer.id);
    const held = props.focusSeq ? null : cache.room(roomId);
    if (held && held.detail && held.messages.length > 0) {
      setDetail(held.detail);
      setMessages(held.messages);
      setHasOlder(held.hasOlder);
      setLoading(false);
    } else {
      setDetail(null);
      setMessages([]);
      setLoading(true);
    }
    readSent.current = 0;
    stickToBottom.current = true;
    void loadAll(props.focusSeq ?? null);

    const unsubscribe = transportRef.current.subscribe((event) => {
      if (event.kind === 'resync') {
        void loadAll(null);
        return;
      }
      if (event.roomId !== roomId) return;
      if (event.kind === 'message') {
        apply((current) => applyChatPush(current, roomId, event));
        // A new line or a task tick changes counts the header and the receipts read.
        setDetail((current) =>
          current && event.message.seq > current.lastSeq
            ? { ...current, lastSeq: event.message.seq }
            : current,
        );
        if (event.message.pinnedAt !== undefined) {
          setDetail((current) => {
            if (!current) return current;
            const others = current.pinned.filter((message) => message.id !== event.message.id);
            return {
              ...current,
              pinned: event.message.pinnedAt && !event.message.deletedAt ? [event.message, ...others] : others,
            };
          });
        }
      } else if (event.kind === 'room') {
        void transportRef.current.room(roomId).then(
          (room) => {
            chatCacheFor(transportRef.current).setDetail(roomId, room);
            setDetail(room);
            callbacks.current.onTitle?.(roomTitle(room));
          },
          () => undefined,
        );
      } else if (event.kind === 'read') {
        setDetail((current) =>
          current
            ? {
                ...current,
                members: current.members.map((member) =>
                  member.id === event.userId
                    ? { ...member, lastReadSeq: Math.max(member.lastReadSeq, event.seq) }
                    : member,
                ),
              }
            : current,
        );
      }
    });
    return unsubscribe;
    // The room is the only thing that restarts this; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Keep the newest message in view while following the conversation.
  const lastSeq = lastSeqOf(messages);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (highlightSeq) {
      const target = list.querySelector(`[data-seq="${highlightSeq}"]`);
      if (target && typeof (target as HTMLElement).scrollIntoView === 'function') {
        (target as HTMLElement).scrollIntoView({ block: 'center' });
        return;
      }
    }
    if (stickToBottom.current || atBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages.length, lastSeq, highlightSeq, loading]);

  // What has been seen is reported once a second after it settles, and only to a window that is looked at.
  const myLastRead = detail?.members.find((member) => member.id === viewer.id)?.lastReadSeq ?? 0;
  useEffect(() => {
    if (!detail?.myRole || lastSeq === 0) return;
    if (lastSeq <= Math.max(readSent.current, myLastRead)) return;
    const timer = window.setTimeout(() => {
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
      if (!atBottom.current) return;
      readSent.current = lastSeq;
      void transportRef.current.read(roomId, lastSeq).then(
        () =>
          setDetail((current) =>
            current
              ? {
                  ...current,
                  lastReadSeq: Math.max(current.lastReadSeq, lastSeq),
                  unread: 0,
                  mentionUnread: 0,
                  members: current.members.map((member) =>
                    member.id === viewer.id ? { ...member, lastReadSeq: lastSeq } : member,
                  ),
                }
              : current,
          ),
        () => undefined,
      );
    }, READ_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lastSeq, myLastRead, detail?.myRole, roomId, viewer.id]);

  async function loadOlder(): Promise<void> {
    const first = messages.find((message) => !message.pending);
    if (!first) return;
    try {
      const older = await transportRef.current.messages(roomId, {
        beforeSeq: first.seq,
        limit: CHAT_LIMITS.pageSize,
      });
      stickToBottom.current = false;
      atBottom.current = false;
      const more = older.length >= CHAT_LIMITS.pageSize && (older[0]?.seq ?? 1) > 1;
      setMessages((current) => mergeMessages(current, older, 'oldest'));
      setHasOlder(more);
      chatCacheFor(transportRef.current).mergePage(roomId, older, more);
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.load'), { tone: 'error' });
    }
  }

  async function send(draft: ComposerDraft): Promise<void> {
    try {
      const result = await transportRef.current.post(roomId, {
        body: draft.body,
        refs: draft.refs,
        mentions: draft.mentions,
        task: draft.task,
      });
      stickToBottom.current = true;
      if ('message' in result) {
        setMessages((current) => mergeMessages(current, [result.message]));
      } else {
        const me = detail?.members.find((member) => member.id === viewer.id);
        const author: ChatPerson = me
          ? { id: me.id, displayName: me.displayName, avatar: me.avatar, tier: me.tier }
          : { id: viewer.id, displayName: viewer.id, avatar: null, tier: 'office' };
        const queued: ChatMessage = {
          id: result.pending.id,
          roomId,
          seq: 0,
          kind: draft.task ? 'task' : 'text',
          author,
          body: draft.body,
          refs: draft.refs.map((chip) => ({ ...chip, label: chip.id, partyName: null, restricted: false })),
          mentions: draft.mentions,
          system: null,
          createdAt: new Date().toISOString(),
          editedAt: null,
          deletedAt: null,
          pinnedAt: null,
          pinnedBy: null,
          task: draft.task
            ? {
                assignees: draft.task.assignees.map(
                  (id) => detail?.members.find((member) => member.id === id) ?? { id, displayName: id, avatar: null, tier: 'office' },
                ),
                dueOn: draft.task.dueOn,
                doneAt: null,
                doneBy: null,
              }
            : null,
          clientId: result.pending.clientId,
          pending: true,
        };
        setMessages((current) => mergeMessages(current, [queued]));
      }
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.send'), { tone: 'error' });
      throw caught;
    }
  }

  async function edit(message: ChatMessage, body: string): Promise<void> {
    try {
      const next = await transportRef.current.edit(message.id, body, message.mentions);
      setMessages((current) => mergeMessages(current, [next]));
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.edit'), { tone: 'error' });
      throw caught;
    }
  }

  async function remove(message: ChatMessage): Promise<void> {
    const ok = await confirm({
      title: t('chat.message.deleteTitle'),
      body: t('chat.message.deleteBody'),
      confirmLabel: t('chat.message.delete'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const next = await transportRef.current.remove(message.id);
      setMessages((current) => mergeMessages(current, [next]));
      setDetail((current) =>
        current ? { ...current, pinned: current.pinned.filter((item) => item.id !== message.id) } : current,
      );
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.delete'), { tone: 'error' });
    }
  }

  async function pin(message: ChatMessage, pinned: boolean): Promise<void> {
    try {
      const next = await transportRef.current.pin(message.id, pinned);
      setMessages((current) => mergeMessages(current, [next]));
      setDetail((current) => {
        if (!current) return current;
        const others = current.pinned.filter((item) => item.id !== next.id);
        return { ...current, pinned: next.pinnedAt ? [next, ...others] : others };
      });
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.pin'), { tone: 'error' });
    }
  }

  async function taskDone(message: ChatMessage, done: boolean): Promise<void> {
    try {
      const next = await transportRef.current.taskDone(message.id, done);
      setMessages((current) => mergeMessages(current, [next]));
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.task'), { tone: 'error' });
    }
  }

  async function toggleMute(): Promise<void> {
    if (!detail) return;
    setMuteBusy(true);
    try {
      await transportRef.current.mute(roomId, !detail.muted);
      setDetail({ ...detail, muted: !detail.muted });
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.mute'), { tone: 'error' });
    } finally {
      setMuteBusy(false);
    }
  }

  async function addMyself(): Promise<void> {
    try {
      const next = await transportRef.current.setMember(roomId, viewer.id, 'member');
      if (next) setDetail(next);
      await loadAll(null);
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.member'), { tone: 'error' });
    }
  }

  async function jumpTo(message: ChatMessage): Promise<void> {
    setPinsOpen(false);
    if (messages.some((item) => item.id === message.id)) {
      setHighlightSeq(null);
      window.setTimeout(() => setHighlightSeq(message.seq), 0);
      return;
    }
    try {
      const page = await transportRef.current.messages(roomId, {
        beforeSeq: message.seq + 26,
        limit: CHAT_LIMITS.pageSize,
      });
      stickToBottom.current = false;
      setMessages(mergeMessages([], page, 'oldest'));
      setHasOlder((page[0]?.seq ?? 1) > 1);
      setHighlightSeq(message.seq);
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.load'), { tone: 'error' });
    }
  }

  if (failed && !detail) {
    return (
      <div className="ob-chat-room">
        <ErrorState title={t('chat.error.load')} description={failed} onAction={() => void loadAll(null)} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="ob-chat-room">
        {offline && <OfflineBanner>{t('chat.offline')}</OfflineBanner>}
        {loading && <p className="ob-small ob-chat-note">{t('common.loading')}</p>}
      </div>
    );
  }

  const isManager = viewer.permissions.includes('chat.manage');
  const isRoomAdmin = detail.myRole === 'admin';
  const canPost =
    detail.myRole !== null &&
    !detail.archivedAt &&
    (detail.kind !== 'announcement' || isRoomAdmin || isManager);
  const canOpenSettings = detail.kind !== 'direct' && (isRoomAdmin || isManager);
  const title = roomTitle(detail);
  const days = groupByDay(messages);

  return (
    <div className="ob-chat-room">
      <header className="ob-chat-roomhead">
        <Button variant="ghost" size="sm" icon="collapse" onClick={props.onBack}>
          {t('chat.room.back')}
        </Button>
        <h2 className="ob-title ob-chat-roomtitle">{title}</h2>
        {detail.direct?.tier === 'server_master' && <ServerMasterBadge />}
        <span className="ob-small">{translator().tCount('chat.room.members', detail.memberCount)}</span>
        <span style={{ flex: 1 }} />
        {detail.myRole && (
          <Button size="sm" variant="ghost" busy={muteBusy} aria-pressed={detail.muted} onClick={() => void toggleMute()}>
            {detail.muted ? t('chat.room.unmute') : t('chat.room.mute')}
          </Button>
        )}
        {canOpenSettings && (
          <Button size="sm" icon="settings" onClick={() => props.onOpenSettings(roomId)}>
            {t('chat.room.settings')}
          </Button>
        )}
      </header>

      {offline && <OfflineBanner>{t('chat.offline')}</OfflineBanner>}

      {detail.pinned.length > 0 && (
        <div className="ob-chat-pinbar">
          <button
            type="button"
            className="ob-chat-pinbar-toggle"
            aria-expanded={pinsOpen}
            onClick={() => setPinsOpen((open) => !open)}
          >
            <Icon name="pin" size={14} />
            <span>{translator().tCount('chat.pinned.count', detail.pinned.length)}</span>
            <Icon name={pinsOpen ? 'chevron-up' : 'chevron-down'} size={12} />
          </button>
          {pinsOpen && (
            <ul className="ob-chat-pinlist">
              {detail.pinned.map((message) => (
                <li key={message.id}>
                  <button type="button" className="ob-chat-menu-item" onClick={() => void jumpTo(message)}>
                    <strong>{message.author?.displayName ?? ''}</strong> {message.body}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div
        ref={listRef}
        className="ob-chat-list"
        onScroll={(event) => {
          const list = event.currentTarget;
          atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
          if (atBottom.current) stickToBottom.current = true;
        }}
      >
        {hasOlder && (
          <div className="ob-chat-older">
            <Button size="sm" variant="ghost" onClick={() => void loadOlder()}>
              {t('chat.room.loadOlder')}
            </Button>
          </div>
        )}

        {!detail.myRole ? (
          <div className="ob-chat-note">
            <p>{t('chat.room.notMember')}</p>
            {isManager && (
              <Button variant="primary" onClick={() => void addMyself()}>
                {t('chat.room.addMyself')}
              </Button>
            )}
          </div>
        ) : messages.length === 0 && !loading ? (
          <p className="ob-small ob-chat-note">{t('chat.room.empty')}</p>
        ) : (
          days.map((day) => (
            <section key={day.day} aria-label={dayLabel(day.day)}>
              <div className="ob-chat-day">
                <span>{dayLabel(day.day)}</span>
              </div>
              {day.messages.map((message, index) => {
                const previous = day.messages[index - 1];
                const showHeader =
                  message.kind === 'system' ||
                  !previous ||
                  previous.kind === 'system' ||
                  previous.author?.id !== message.author?.id ||
                  dayKeyOf(previous.createdAt) !== dayKeyOf(message.createdAt) ||
                  Date.parse(message.createdAt) - Date.parse(previous.createdAt) > 5 * 60 * 1000;
                return (
                  <MessageRow
                    key={message.id}
                    message={message}
                    showHeader={showHeader}
                    viewer={viewer}
                    detail={detail}
                    highlighted={highlightSeq === message.seq}
                    mentionsMe={message.mentions.includes(viewer.id)}
                    onOpenRecord={props.onOpenRecord}
                    onEdit={edit}
                    onDelete={(target) => void remove(target)}
                    onPin={(target, pinned) => void pin(target, pinned)}
                    onTaskDone={(target, done) => void taskDone(target, done)}
                  />
                );
              })}
            </section>
          ))
        )}
      </div>

      {detail.archivedAt ? (
        <p className="ob-small ob-chat-note">{t('chat.room.archivedNote')}</p>
      ) : detail.myRole && !canPost ? (
        <p className="ob-small ob-chat-note">{t('chat.composer.announceOnly')}</p>
      ) : canPost ? (
        <Composer
          members={detail.members}
          viewer={viewer}
          findRecords={props.findRecords}
          onSend={send}
          roomKey={roomId}
        />
      ) : null}
    </div>
  );
}
