/**
 * The Chatroom's pure parts: what the screens ask a panel for (`ChatTransport`)
 * and the functions that keep a room's message list, its read receipts and its
 * unread figures right. Nothing here touches the DOM or the clock; callers pass
 * `now` where a date matters.
 */

import type {
  ChatAccessCapability,
  ChatMemberRole,
  ChatMessage,
  ChatPerson,
  ChatPostInput,
  ChatPush,
  ChatRoomDetail,
  ChatRoomInput,
  ChatRoomMember,
  ChatRoomPatch,
  ChatRoomSummary,
  ChatSearchHit,
  ChatTaskRow,
} from '@orderbook/shared';
import { CHAT_LIMITS } from '@orderbook/shared';

/** What a transport reports: a push from the Master, or "read everything again" after a reconnect. */
export type ChatEvent = ChatPush | { kind: 'resync' };

/**
 * What the screens need from a panel. The Master's browser calls its own REST
 * routes; an Office calls its server's forwards of them. Held in a ref by every
 * screen, never a dependency of an effect (`no-transport-dep.test.ts`).
 */
export interface ChatTransport {
  people(): Promise<ChatPerson[]>;
  rooms(options?: { all?: boolean; includeArchived?: boolean }): Promise<ChatRoomSummary[]>;
  room(roomId: string): Promise<ChatRoomDetail>;
  /**
   * A page of messages, oldest first. An Office with no link rejects with
   * `code: 'unavailable'` and its own still-queued posts in `pending`.
   */
  messages(roomId: string, options?: { beforeSeq?: number; limit?: number }): Promise<ChatMessage[]>;
  /** The Master answers with the message; an Office queues it and answers with the ids to match later. */
  post(
    roomId: string,
    input: ChatPostInput,
  ): Promise<{ message: ChatMessage } | { pending: { clientId: string; id: string } }>;
  edit(messageId: string, body: string, mentions?: string[]): Promise<ChatMessage>;
  remove(messageId: string): Promise<ChatMessage>;
  pin(messageId: string, pinned: boolean): Promise<ChatMessage>;
  taskDone(messageId: string, done: boolean): Promise<ChatMessage>;
  read(roomId: string, seq: number): Promise<{ lastReadSeq: number }>;
  mute(roomId: string, muted: boolean): Promise<null>;
  direct(userId: string): Promise<ChatRoomSummary>;
  createRoom(input: ChatRoomInput): Promise<ChatRoomSummary>;
  updateRoom(roomId: string, patch: ChatRoomPatch): Promise<ChatRoomSummary>;
  setMember(roomId: string, userId: string, role: ChatMemberRole | null): Promise<ChatRoomDetail | null>;
  search(q: string, roomId?: string): Promise<ChatSearchHit[]>;
  tasks(scope: 'mine' | 'created', includeDone: boolean): Promise<ChatTaskRow[]>;
  requestAccess(capability: ChatAccessCapability, note?: string): Promise<{ notified: number }>;
  subscribe(listener: (event: ChatEvent) => void): () => void;
}

/** A record the composer's picker offers. */
export interface ChatRecordOption {
  kind: 'lead' | 'order';
  id: string;
  label: string;
  partyName: string;
}

/** Who is using the screen and what they may do; the server enforces it all again. */
export interface ChatViewer {
  id: string;
  permissions: readonly string[];
  /** The role tier, so a right that tier can never hold is not offered. */
  tier?: string;
}

// --- Message lists --------------------------------------------------------------

function orderOf(a: ChatMessage, b: ChatMessage): number {
  // A post still on its way to the Master sits after everything that has arrived.
  if (a.pending !== b.pending) return a.pending ? 1 : -1;
  if (a.pending && b.pending) return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  return a.seq - b.seq;
}

/**
 * Fold `incoming` into a room's list: by id, in sequence order, a queued post
 * replaced by the Master's copy of it (same `clientId`), capped at
 * `CHAT_LIMITS.keepInMemory`. `keep` says which end survives the cap: the
 * newest while following the conversation, the oldest after loading older ones.
 */
export function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  keep: 'newest' | 'oldest' = 'newest',
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of current) byId.set(message.id, message);

  const arrivedClientIds = new Set(
    incoming.filter((message) => !message.pending && message.clientId).map((message) => message.clientId),
  );
  for (const message of incoming) byId.set(message.id, message);

  const merged = [...byId.values()]
    .filter((message) => !(message.pending && arrivedClientIds.has(message.clientId)))
    .sort(orderOf);

  const sent = merged.filter((message) => !message.pending);
  const pending = merged.filter((message) => message.pending);
  const capped =
    sent.length > CHAT_LIMITS.keepInMemory
      ? keep === 'newest'
        ? sent.slice(sent.length - CHAT_LIMITS.keepInMemory)
        : sent.slice(0, CHAT_LIMITS.keepInMemory)
      : sent;
  return [...capped, ...pending];
}

/** A live push applied to the room it is for. Pushes for other rooms and other kinds change nothing. */
export function applyChatPush(messages: readonly ChatMessage[], roomId: string, push: ChatPush): ChatMessage[] {
  if (push.kind !== 'message' || push.roomId !== roomId) return messages as ChatMessage[];
  return mergeMessages(messages, [push.message]);
}

/** The newest sequence number among the messages that have arrived. */
export function lastSeqOf(messages: readonly ChatMessage[]): number {
  let last = 0;
  for (const message of messages) if (!message.pending && message.seq > last) last = message.seq;
  return last;
}

// --- Day separators -------------------------------------------------------------

/** The local calendar day of a timestamp, `YYYY-MM-DD`. */
export function dayKeyOf(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface MessageDay {
  /** `YYYY-MM-DD`. */
  day: string;
  messages: ChatMessage[];
}

export function groupByDay(messages: readonly ChatMessage[]): MessageDay[] {
  const days: MessageDay[] = [];
  for (const message of messages) {
    const day = dayKeyOf(message.createdAt);
    const last = days[days.length - 1];
    if (last && last.day === day) last.messages.push(message);
    else days.push({ day, messages: [message] });
  }
  return days;
}

/** 'today', 'yesterday', or null (show the date) for a day key, judged against `now`. */
export function relativeDay(day: string, now: Date): 'today' | 'yesterday' | null {
  const today = dayKeyOf(now.toISOString());
  if (day === today) return 'today';
  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  return day === dayKeyOf(yesterday.toISOString()) ? 'yesterday' : null;
}

// --- Receipts -------------------------------------------------------------------

/**
 * Who has seen a message: members whose read position has reached it. The
 * author is not counted either way. Derived from `lastReadSeq`, so there is no
 * receipt table to keep.
 */
export function receiptsFor(
  message: Pick<ChatMessage, 'seq' | 'author'>,
  members: readonly ChatRoomMember[],
): { seen: ChatRoomMember[]; total: number } {
  const others = members.filter((member) => member.id !== message.author?.id);
  return { seen: others.filter((member) => member.lastReadSeq >= message.seq), total: others.length };
}

// --- Mentions -------------------------------------------------------------------

/**
 * The `@name` being typed at the caret, or null. An `@` counts only at the
 * start of the text or after whitespace, so an address like `a@b.com` is left
 * alone.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  // A name has no line break, and a very long run is not a name.
  if (/\n/.test(query) || query.length > 30) return null;
  return { start: at, query };
}

/** The picked people whose `@Name` is still in the text, as ids. */
export function mentionsStillIn(text: string, picked: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const [id, name] of picked) if (text.includes(`@${name}`)) ids.push(id);
  return ids;
}

// --- Unread figures ---------------------------------------------------------------

/**
 * What the sidebar badge shows: unread messages across rooms that are not
 * muted and not archived. `mentions` counts @-mentions of the viewer in the
 * rooms that are not archived, muted or not (a mention is addressed to them).
 */
export function unreadTotals(rooms: readonly ChatRoomSummary[]): { total: number; mentions: number } {
  let total = 0;
  let mentions = 0;
  for (const room of rooms) {
    if (room.archivedAt || !room.myRole) continue;
    mentions += room.mentionUnread;
    if (!room.muted) total += Math.max(0, room.lastSeq - room.lastReadSeq);
  }
  return { total, mentions };
}

/** A room's name as the viewer sees it: a direct chat is named for the other person. */
export function roomTitle(room: Pick<ChatRoomSummary, 'name' | 'direct'>): string {
  return room.direct?.displayName ?? room.name ?? '';
}
