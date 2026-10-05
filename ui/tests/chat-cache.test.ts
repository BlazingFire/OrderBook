import { describe, expect, it } from 'vitest';

import { chatCacheFor } from '../src/chatCache';
import type { ChatEvent, ChatTransport } from '../src/chatModel';

function transport() {
  const listeners = new Set<(event: ChatEvent) => void>();
  const fake = {
    subscribe: (listener: (event: ChatEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChatTransport;
  return { fake, emit: (event: ChatEvent) => listeners.forEach((listener) => listener(event)) };
}

const message = (seq: number, roomId = 'RM1') =>
  ({ id: `M${seq}`, roomId, seq, body: `line ${seq}`, pending: false, createdAt: '2026-10-05T10:00:00.000Z' }) as never;

const detail = (lastSeq: number) => ({ id: 'RM1', lastSeq, members: [], pinned: [] }) as never;

describe('the chat room cache', () => {
  it('is one cache per transport, and starts empty', () => {
    const { fake } = transport();
    expect(chatCacheFor(fake)).toBe(chatCacheFor(fake));
    expect(chatCacheFor(fake).room('RM1')).toBeNull();
  });

  it('keeps a room that was read, and folds live pushes into it without a read', () => {
    const { fake, emit } = transport();
    const cache = chatCacheFor(fake);
    cache.forViewer('US1');
    cache.setDetail('RM1', detail(2));
    cache.mergePage('RM1', [message(1), message(2)], false);

    emit({ kind: 'message', roomId: 'RM1', message: message(3) } as ChatEvent);

    const held = cache.room('RM1')!;
    expect(held.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(held.detail?.lastSeq).toBe(3);
  });

  it('ignores a push for a room it holds nothing of, so a lone push never looks like a whole room', () => {
    const { fake, emit } = transport();
    const cache = chatCacheFor(fake);
    emit({ kind: 'message', roomId: 'RM9', message: message(7, 'RM9') } as ChatEvent);
    expect(cache.room('RM9')).toBeNull();
  });

  it('never keeps a post that has not been sent yet', () => {
    const { fake } = transport();
    const cache = chatCacheFor(fake);
    cache.mergePage('RM1', [message(1), { ...(message(2) as object), pending: true } as never], false);
    expect(cache.room('RM1')!.messages.map((m) => m.seq)).toEqual([1]);
  });

  it('forgets the header on a room push, but keeps the messages', () => {
    const { fake, emit } = transport();
    const cache = chatCacheFor(fake);
    cache.setDetail('RM1', detail(1));
    cache.mergePage('RM1', [message(1)], false);
    emit({ kind: 'room', roomId: 'RM1' } as ChatEvent);
    expect(cache.room('RM1')!.detail).toBeNull();
    expect(cache.room('RM1')!.messages).toHaveLength(1);
  });

  it('empties on a resync (the feed was down) and when somebody else signs in', () => {
    const { fake, emit } = transport();
    const cache = chatCacheFor(fake);
    cache.forViewer('US1');
    cache.mergePage('RM1', [message(1)], false);
    cache.setRoomList('rooms', []);

    cache.forViewer('US1');
    expect(cache.room('RM1')).not.toBeNull(); // same person: kept

    emit({ kind: 'resync' });
    expect(cache.room('RM1')).toBeNull();
    expect(cache.roomList('rooms')).toBeNull();

    cache.mergePage('RM1', [message(1)], false);
    cache.forViewer('US2');
    expect(cache.room('RM1')).toBeNull();
  });
});
