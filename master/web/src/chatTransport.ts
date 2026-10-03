/**
 * What the shared Chatroom screens reach on the Master's own browser: its
 * `/api/chat` routes through `api`, and a small in-page bus the shell feeds
 * from the socket's `chat:event` (and from a reconnect, as `resync`).
 */

import type { ChatEvent, ChatTransport } from '@orderbook/ui';

import { api } from './api';

const listeners = new Set<(event: ChatEvent) => void>();

/** Called by the shell for every `chat:event` the socket delivers, and with `resync` after a reconnect. */
export function dispatchChat(event: ChatEvent): void {
  for (const listener of [...listeners]) listener(event);
}

export const masterChatTransport: ChatTransport = {
  people: () => api.chatPeople(),
  rooms: (options) => api.chatRooms(options),
  room: (roomId) => api.chatRoom(roomId),
  messages: (roomId, options) => api.chatMessages(roomId, options),
  post: async (roomId, input) => ({ message: await api.chatPost(roomId, input) }),
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
