/**
 * The Chatroom (1.3, Phase 6): text-only chat between the people of one company.
 *
 * Rooms are `group`, `direct` (exactly two people) and `announcement` (a group
 * only its admins may speak in). A message is plain text of at most
 * `CHAT_LIMITS.bodyMax` characters, with no files and no images. It may carry
 * up to five **record chips** (a pending order or a final order) and, as a
 * task, a list of assignees.
 *
 * **A chip stores only `{kind, id}`.** What it shows is worked out for the
 * person looking, on every read: a viewer who may open the record sees its
 * number and party; anybody else sees "Restricted record" and nothing about
 * which party it belongs to. That is why the stored form carries no label.
 *
 * Pure: no clock, no I/O. The caller passes `now`.
 */

import type { MessageKey } from '../i18n/keys.js';
import type { IsoTimestamp, UserAvatar, Uuid } from './entities.js';

/**
 * The first panel protocol that speaks chat: its commands (`COMMAND_MIN_PROTOCOL`),
 * the `chat:event` push, and the `chat.post` mutation. Frozen here, never tied
 * to `PANEL_PROTOCOL_VERSION`, which keeps rising.
 */
export const CHAT_MIN_PROTOCOL = 5;

export const CHAT_LIMITS = {
  bodyMax: 4000,
  refsMax: 5,
  mentionsMax: 20,
  assigneesMax: 20,
  nameMax: 60,
  descriptionMax: 280,
  noteMax: 280,
  /** Own message: edit or delete within five minutes of posting. */
  editWindowMs: 5 * 60 * 1000,
  pageSize: 50,
  /** Messages one open room keeps on a screen; the oldest are dropped and fetched again on demand. */
  keepInMemory: 300,
  searchMin: 2,
  searchMax: 50,
} as const;

export type ChatRoomKind = 'group' | 'direct' | 'announcement';
export type ChatMemberRole = 'admin' | 'member';
export type ChatRecordKind = 'lead' | 'order';
export type ChatMessageKind = 'text' | 'task' | 'system';

/** What is stored for a record reference: no label, no party. */
export interface ChatRecordChip {
  kind: ChatRecordKind;
  id: string;
}

/** A chip as one viewer is allowed to see it. */
export interface ChatRecordRef extends ChatRecordChip {
  /** The record's number; null when `restricted`. */
  label: string | null;
  partyName: string | null;
  /** The viewer may not open it, or it no longer exists. */
  restricted: boolean;
}

/** One of the capabilities a person without it may ask an administrator for. */
export const CHAT_ACCESS_CAPABILITIES = [
  'chat.directMessages',
  'chat.shareRecords',
  'chat.tasks',
  'chat.createGroups',
] as const;

export type ChatAccessCapability = (typeof CHAT_ACCESS_CAPABILITIES)[number];

export interface ChatAccessRequest {
  capability: ChatAccessCapability;
  note?: string;
}

export function isChatAccessCapability(value: unknown): value is ChatAccessCapability {
  return (CHAT_ACCESS_CAPABILITIES as readonly unknown[]).includes(value);
}

export interface ChatPerson {
  id: string;
  displayName: string;
  avatar: UserAvatar | null;
  /** The role tier, so a Server Master can be marked. */
  tier: string;
}

/** What a system line in the timeline says happened. */
export const CHAT_SYSTEM_EVENTS = [
  'created',
  'memberAdded',
  'memberRemoved',
  'renamed',
  'announceOn',
  'announceOff',
  'archived',
  'unarchived',
] as const;

export type ChatSystemEvent = (typeof CHAT_SYSTEM_EVENTS)[number];

export interface ChatSystemPayload {
  event: ChatSystemEvent;
  params: Record<string, string>;
}

export interface ChatTaskState {
  assignees: ChatPerson[];
  /** A calendar day, YYYY-MM-DD. */
  dueOn: string | null;
  doneAt: IsoTimestamp | null;
  doneBy: ChatPerson | null;
}

export interface ChatMessage {
  id: string;
  roomId: Uuid;
  /** Gap-free within the room, from 1. */
  seq: number;
  kind: ChatMessageKind;
  author: ChatPerson | null;
  /** Empty once deleted. */
  body: string;
  refs: ChatRecordRef[];
  /** User ids mentioned in the body. */
  mentions: string[];
  system: ChatSystemPayload | null;
  createdAt: IsoTimestamp;
  editedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  pinnedAt: IsoTimestamp | null;
  pinnedBy: string | null;
  task: ChatTaskState | null;
  /** The sender's own id for this post, which lets a panel match its pending bubble. */
  clientId: string | null;
  /** Queued on this panel and not yet on the Master. Only the Office server sets it. */
  pending?: boolean;
}

export interface ChatRoomSummary {
  id: Uuid;
  kind: ChatRoomKind;
  /** Null for a direct chat. */
  name: string | null;
  description: string | null;
  /** True for `announcement`. */
  announceOnly: boolean;
  archivedAt: IsoTimestamp | null;
  /** The viewer's role in it; null for a room an administrator is looking at without being in it. */
  myRole: ChatMemberRole | null;
  muted: boolean;
  lastSeq: number;
  lastReadSeq: number;
  unread: number;
  mentionUnread: number;
  memberCount: number;
  lastMessageAt: IsoTimestamp | null;
  lastMessage: ChatMessage | null;
  /** The other person of a direct chat. */
  direct: ChatPerson | null;
}

export interface ChatRoomMember extends ChatPerson {
  role: ChatMemberRole;
  lastReadSeq: number;
}

export interface ChatRoomDetail extends ChatRoomSummary {
  members: ChatRoomMember[];
  pinned: ChatMessage[];
}

export interface ChatTaskInput {
  assignees: string[];
  dueOn?: string | null;
}

export interface ChatPostInput {
  body: string;
  refs?: ChatRecordChip[];
  mentions?: string[];
  task?: ChatTaskInput | null;
  /** The sender's id for this post; absent means the Master makes one up. */
  clientId?: string;
}

export interface ChatRoomInput {
  name: string;
  description?: string | null;
  announceOnly?: boolean;
  memberIds?: string[];
}

export interface ChatRoomPatch {
  name?: string;
  description?: string | null;
  announceOnly?: boolean;
  archived?: boolean;
}

export interface ChatSearchHit {
  message: ChatMessage;
  roomId: Uuid;
  roomName: string | null;
  roomKind: ChatRoomKind;
}

export interface ChatTaskRow {
  message: ChatMessage;
  roomId: Uuid;
  roomName: string | null;
}

/**
 * The one live event: a message upserted (a new post, an edit, a delete, a pin
 * or a task tick), a room that changed shape (the viewer refetches it), and a
 * member's read position. `forUserId` is stamped by the Master's fan-out.
 */
export type ChatPush =
  | { kind: 'message'; roomId: Uuid; message: ChatMessage }
  | { kind: 'room'; roomId: Uuid }
  | { kind: 'read'; roomId: Uuid; userId: string; seq: number };

// --- Pure helpers ------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Removes control characters other than a line break, by code so no pattern has to name them. */
function stripControls(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if ((code < 32 && code !== 10) || code === 127) continue;
    out += char;
  }
  return out;
}

/** True when `dueOn` is a real calendar day. No `Date` involved. */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
  return d <= days;
}

/** The refusals `cleanChatPost` can give. All take no parameters, so any caller can render one. */
export type ChatPostErrorKey =
  | 'validation.chat.bodyRequired'
  | 'validation.chat.bodyTooLong'
  | 'validation.chat.tooManyRefs'
  | 'validation.chat.refNotFound'
  | 'validation.chat.assigneeRequired'
  | 'validation.chat.dueInvalid';

export type CleanChatResult =
  | { value: Required<Omit<ChatPostInput, 'clientId'>> & { clientId: string | null } }
  | { errorKey: ChatPostErrorKey };

function dedupe<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Check and tidy one post. Control characters other than a newline are removed
 * and the ends trimmed. A message needs words or at least one record chip.
 */
export function cleanChatPost(input: unknown): CleanChatResult {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const body = stripControls(typeof raw.body === 'string' ? raw.body : '').trim();
  if (body.length > CHAT_LIMITS.bodyMax) return { errorKey: 'validation.chat.bodyTooLong' };

  const rawRefs = Array.isArray(raw.refs) ? raw.refs : [];
  const refs: ChatRecordChip[] = [];
  for (const entry of rawRefs) {
    const chip = entry as Partial<ChatRecordChip> | null;
    if (!chip || (chip.kind !== 'lead' && chip.kind !== 'order') || typeof chip.id !== 'string' || !chip.id) {
      return { errorKey: 'validation.chat.refNotFound' };
    }
    refs.push({ kind: chip.kind, id: chip.id });
  }
  const uniqueRefs = dedupe(refs, (chip) => `${chip.kind}:${chip.id}`);
  if (uniqueRefs.length > CHAT_LIMITS.refsMax) return { errorKey: 'validation.chat.tooManyRefs' };

  const mentions = dedupe(
    (Array.isArray(raw.mentions) ? raw.mentions : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
    (id) => id,
  ).slice(0, CHAT_LIMITS.mentionsMax);

  let task: ChatTaskInput | null = null;
  if (raw.task !== undefined && raw.task !== null) {
    const rawTask = raw.task as Partial<ChatTaskInput>;
    const assignees = dedupe(
      (Array.isArray(rawTask.assignees) ? rawTask.assignees : []).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
      (id) => id,
    );
    if (assignees.length === 0 || assignees.length > CHAT_LIMITS.assigneesMax) {
      return { errorKey: 'validation.chat.assigneeRequired' };
    }
    const dueOn = rawTask.dueOn ?? null;
    if (dueOn !== null && !isCalendarDay(dueOn)) return { errorKey: 'validation.chat.dueInvalid' };
    task = { assignees, dueOn };
  }

  // A record can be shared on its own; anything else needs words.
  if (body === '' && uniqueRefs.length === 0) return { errorKey: 'validation.chat.bodyRequired' };

  const clientId = typeof raw.clientId === 'string' && raw.clientId.length > 0 ? raw.clientId.slice(0, 80) : null;
  return { value: { body, refs: uniqueRefs, mentions, task, clientId } };
}

/** A person may edit or delete their own message for five minutes after posting it. */
export function withinEditWindow(createdAt: IsoTimestamp | number, now: number): boolean {
  const created = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age >= 0 && age <= CHAT_LIMITS.editWindowMs;
}

/** Unread messages in a room, never negative. */
export function unreadOf(room: Pick<ChatRoomSummary, 'lastSeq' | 'lastReadSeq'>): number {
  return Math.max(0, room.lastSeq - room.lastReadSeq);
}

/** The key a system line is shown with. An explicit map, so every key is greppable. */
export const CHAT_SYSTEM_KEYS: Record<ChatSystemEvent, MessageKey> = {
  created: 'chat.system.created',
  memberAdded: 'chat.system.memberAdded',
  memberRemoved: 'chat.system.memberRemoved',
  renamed: 'chat.system.renamed',
  announceOn: 'chat.system.announceOn',
  announceOff: 'chat.system.announceOff',
  archived: 'chat.system.archived',
  unarchived: 'chat.system.unarchived',
};

/** The direct-chat key for two people: their ids, ordered, so either side finds the same room. */
export function directKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
