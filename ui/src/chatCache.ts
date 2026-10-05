/**
 * What the Chatroom keeps in memory between visits, so a room opens at once.
 *
 * Opening a conversation used to start from nothing: a blank room, a spinner, two round
 * trips (`room`, `messages`), and then the page. The chat already receives every message live
 * (`chat:event` / the Office stream, as `ChatTransport.subscribe`) — the screen just threw
 * that away when it closed. This cache is subscribed to the same feed for as long as the page
 * lives, so a room that was open a minute ago, or whose list was read, is current when it is
 * opened again: the screen draws it immediately and reconciles with one quiet read behind it.
 *
 * Rules it keeps:
 * - **Live pushes are applied here, not refetched**: a `message` push is folded into the
 *   cached room (`applyChatPush`) and a `room` push drops that room's header (it is read again).
 *   The room lists are shown as last read and read again by the screen, since their last
 *   message and unread counts move with every push.
 * - **A `resync` empties it**: the feed was down, so nothing held can be trusted.
 * - **It belongs to one person**: `forViewer` empties it when somebody else signs in.
 * - **Messages still waiting to be sent are never kept** (they live in the screen and the
 *   Office outbox).
 */

import type { ChatMessage, ChatRoomDetail, ChatRoomSummary } from '@orderbook/shared';

import { applyChatPush, mergeMessages } from './chatModel.js';
import type { ChatEvent, ChatTransport } from './chatModel.js';

/** The newest rooms held; a person rarely moves between more than this in a sitting. */
const MAX_ROOMS = 24;

export interface CachedRoom {
  detail: ChatRoomDetail | null;
  /** Oldest first, never containing a pending post. */
  messages: ChatMessage[];
  hasOlder: boolean;
}

export interface ChatCache {
  /** Empties the cache when `viewerId` is not who it was built for. */
  forViewer(viewerId: string): void;
  room(roomId: string): CachedRoom | null;
  setDetail(roomId: string, detail: ChatRoomDetail): void;
  /** Fold a page read from the server into the room; `hasOlder` as that read reported it. */
  mergePage(roomId: string, page: readonly ChatMessage[], hasOlder: boolean): void;
  /** The room list as last read for `key` (the options it was asked with). */
  roomList(key: string): ChatRoomSummary[] | null;
  setRoomList(key: string, rooms: ChatRoomSummary[]): void;
  clear(): void;
}

function createChatCache(transport: ChatTransport): ChatCache {
  let owner: string | null = null;
  const rooms = new Map<string, CachedRoom>();
  const lists = new Map<string, ChatRoomSummary[]>();

  function touch(roomId: string): CachedRoom {
    const held = rooms.get(roomId) ?? { detail: null, messages: [], hasOlder: false };
    // Re-insert at the end: a Map iterates in insertion order, so the front is the least recent.
    rooms.delete(roomId);
    rooms.set(roomId, held);
    if (rooms.size > MAX_ROOMS) {
      const oldest = rooms.keys().next().value;
      if (oldest !== undefined) rooms.delete(oldest);
    }
    return held;
  }

  transport.subscribe((event: ChatEvent) => {
    if (event.kind === 'resync') {
      rooms.clear();
      lists.clear();
      return;
    }
    if (event.kind === 'read') return;
    // The room lists are left as read: a screen shows them at once and reads them again behind that.
    const held = rooms.get(event.roomId);
    if (!held) return;
    if (event.kind === 'room') {
      held.detail = null;
      return;
    }
    if (event.kind === 'message') {
      // A room read only partly (no messages yet) stays that way: a lone push would look like the whole room.
      if (held.messages.length > 0) held.messages = applyChatPush(held.messages, event.roomId, event);
      const detail = held.detail;
      if (detail && event.message.seq > detail.lastSeq) held.detail = { ...detail, lastSeq: event.message.seq };
    }
  });

  return {
    forViewer(viewerId) {
      if (owner === viewerId) return;
      owner = viewerId;
      rooms.clear();
      lists.clear();
    },
    room: (roomId) => rooms.get(roomId) ?? null,
    setDetail(roomId, detail) {
      touch(roomId).detail = detail;
    },
    mergePage(roomId, page, hasOlder) {
      const held = touch(roomId);
      held.messages = mergeMessages(
        held.messages,
        page.filter((message) => !message.pending),
        'newest',
      );
      held.hasOlder = hasOlder;
    },
    roomList: (key) => lists.get(key) ?? null,
    setRoomList(key, list) {
      lists.set(key, list);
    },
    clear() {
      rooms.clear();
      lists.clear();
    },
  };
}

const caches = new WeakMap<ChatTransport, ChatCache>();

/** The cache of one panel's transport, created (and subscribed to its feed) on first use. */
export function chatCacheFor(transport: ChatTransport): ChatCache {
  let cache = caches.get(transport);
  if (!cache) {
    cache = createChatCache(transport);
    caches.set(transport, cache);
  }
  return cache;
}
