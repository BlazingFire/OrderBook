/**
 * What the shared Chatroom screens reach on an Office Panel: its own server's
 * `/api/chat` forwards (`api`), and a small in-page bus the shell feeds from
 * the event stream's `chat` frames and from every reconnect (`resync`).
 *
 * Posting is the one call that differs from the Master's browser: the panel
 * queues the message and answers `202`, so `post` hands back the ids the
 * screen needs to match the Master's copy when it arrives. Reading with no link
 * rejects `unavailable`, carrying this person's still-queued posts so the
 * screen can keep showing them.
 */

import type { ChatMessage } from '@orderbook/shared';
import type { ChatEvent, ChatTransport } from '@orderbook/ui';

import { ApiError, api } from './api';

const listeners = new Set<(event: ChatEvent) => void>();

/** Called by the shell for every `chat` frame, and with `resync` whenever the stream or the link comes back. */
export function dispatchChat(event: ChatEvent): void {
  for (const listener of [...listeners]) listener(event);
}

export const officeChatTransport: ChatTransport = {
  people: () => api.chatPeople(),
  rooms: (options) => api.chatRooms(options),
  room: (roomId) => api.chatRoom(roomId),
  messages: async (roomId, options) => {
    try {
      return await api.chatMessages(roomId, options);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'unavailable') {
        const pending = (caught.details as { pending?: ChatMessage[] }).pending ?? [];
        throw Object.assign(caught, { pending });
      }
      throw caught;
    }
  },
  post: async (roomId, input) => {
    const queued = await api.chatPost(roomId, input);
    return { pending: { clientId: queued.mutationId, id: queued.id } };
  },
  edit: (messageId, body, mentions) => api.chatEdit(messageId, body, mentions),
  remove: (messageId) => api.chatDelete(messageId),
  pin: (messageId, pinned) => api.chatPin(messageId, pinned),
  taskDone: (messageId, done) => api.chatTaskDone(messageId, done),
  read: (roomId, seq) => api.chatRead(roomId, seq),
  mute: (roomId, muted) => api.chatMute(roomId, muted),
  direct: (userId) => api.chatDirect(userId),
  createRoom: (input) => api.chatCreateRoom(input),
  updateRoom: (roomId, patch) => api.chatUpdateRoom(roomId, patch),
  setMember: (roomId, userId, role) => api.chatSetMember(roomId, userId, role),
  search: (q, roomId) => api.chatSearch(q, roomId),
  tasks: (scope, includeDone) => api.chatTasks(scope, includeDone),
  requestAccess: (capability, note) => api.chatRequestAccess(capability, note),
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
