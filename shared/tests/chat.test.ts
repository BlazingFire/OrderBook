/**
 * The Chatroom's pure rules: what a post may carry, the five-minute window, and
 * the figures built from a room.
 */

import { describe, expect, it } from 'vitest';

import {
  CHAT_LIMITS,
  CHAT_MIN_PROTOCOL,
  COMMAND_MIN_PROTOCOL,
  ENTITY_PREFIX,
  EN_MESSAGES,
  CHAT_SYSTEM_KEYS,
  MUTATION_PERMISSIONS,
  PANEL_PROTOCOL_VERSION,
  cleanChatPost,
  directKeyOf,
  isCalendarDay,
  unreadOf,
  withinEditWindow,
} from '../src/index.js';

const value = (input: unknown) => {
  const result = cleanChatPost(input);
  if (!('value' in result)) throw new Error(`refused: ${result.errorKey}`);
  return result.value;
};
const refusal = (input: unknown) => {
  const result = cleanChatPost(input);
  return 'errorKey' in result ? result.errorKey : null;
};

describe('cleanChatPost', () => {
  it('trims the words and strips control characters but keeps line breaks', () => {
    expect(value({ body: '  hello\u0007 there\nsecond line \u0000 ' }).body).toBe('hello there\nsecond line');
  });

  it('refuses nothing to say, and too much', () => {
    expect(refusal({ body: '   ' })).toBe('validation.chat.bodyRequired');
    expect(refusal({})).toBe('validation.chat.bodyRequired');
    expect(refusal('not an object')).toBe('validation.chat.bodyRequired');
    expect(refusal({ body: 'x'.repeat(CHAT_LIMITS.bodyMax) })).toBeNull();
    expect(refusal({ body: 'x'.repeat(CHAT_LIMITS.bodyMax + 1) })).toBe('validation.chat.bodyTooLong');
  });

  it('lets a record go on its own, but not an empty message', () => {
    const post = value({ body: '', refs: [{ kind: 'order', id: 'OD0000000001' }] });
    expect(post.refs).toEqual([{ kind: 'order', id: 'OD0000000001' }]);
  });

  it('keeps each record once, at most five, and only leads and orders', () => {
    const chips = (count: number) => Array.from({ length: count }, (_, i) => ({ kind: 'lead', id: `LD${i}` }));
    expect(value({ body: 'x', refs: [...chips(2), ...chips(2)] }).refs).toHaveLength(2);
    expect(refusal({ body: 'x', refs: chips(CHAT_LIMITS.refsMax) })).toBeNull();
    expect(refusal({ body: 'x', refs: chips(CHAT_LIMITS.refsMax + 1) })).toBe('validation.chat.tooManyRefs');
    expect(refusal({ body: 'x', refs: [{ kind: 'party', id: 'PT1' }] })).toBe('validation.chat.refNotFound');
    expect(refusal({ body: 'x', refs: [{ kind: 'lead' }] })).toBe('validation.chat.refNotFound');
  });

  it('keeps each mention once and caps them', () => {
    const many = Array.from({ length: 30 }, (_, i) => `US${i}`);
    expect(value({ body: 'x', mentions: ['US1', 'US1', 'US2', 7, ''] }).mentions).toEqual(['US1', 'US2']);
    expect(value({ body: 'x', mentions: many }).mentions).toHaveLength(CHAT_LIMITS.mentionsMax);
  });

  it('wants at least one person, and a real day, for a task', () => {
    expect(refusal({ body: 'x', task: { assignees: [] } })).toBe('validation.chat.assigneeRequired');
    expect(refusal({ body: 'x', task: { assignees: ['US1'], dueOn: '2026-02-30' } })).toBe('validation.chat.dueInvalid');
    expect(value({ body: 'x', task: { assignees: ['US1', 'US1'], dueOn: '2026-02-28' } }).task).toEqual({
      assignees: ['US1'],
      dueOn: '2026-02-28',
    });
    expect(value({ body: 'x' }).task).toBeNull();
  });
});

describe('isCalendarDay', () => {
  it('knows leap years and month lengths without a Date', () => {
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2100-02-29')).toBe(false);
    expect(isCalendarDay('2026-04-31')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('26-1-1')).toBe(false);
    expect(isCalendarDay(20261101)).toBe(false);
  });
});

describe('withinEditWindow', () => {
  const created = Date.UTC(2026, 9, 3, 10, 0, 0);

  it('is five minutes, inclusive, and never before the post', () => {
    expect(withinEditWindow(new Date(created).toISOString(), created)).toBe(true);
    expect(withinEditWindow(new Date(created).toISOString(), created + CHAT_LIMITS.editWindowMs)).toBe(true);
    expect(withinEditWindow(new Date(created).toISOString(), created + CHAT_LIMITS.editWindowMs + 1)).toBe(false);
    expect(withinEditWindow(new Date(created).toISOString(), created - 1)).toBe(false);
    expect(withinEditWindow('not a date', created)).toBe(false);
  });
});

describe('the figures', () => {
  it('counts unread, never below nothing', () => {
    expect(unreadOf({ lastSeq: 9, lastReadSeq: 4 })).toBe(5);
    expect(unreadOf({ lastSeq: 3, lastReadSeq: 7 })).toBe(0);
  });

  it('names a direct chat the same from either side', () => {
    expect(directKeyOf('US2', 'US1')).toBe(directKeyOf('US1', 'US2'));
    expect(directKeyOf('US1', 'US2')).toBe('US1:US2');
  });
});

describe('the Chatroom\'s wiring in shared', () => {
  it('posts as CM ids behind chat.use', () => {
    expect(ENTITY_PREFIX.chat_message).toBe('CM');
    expect(new Set(Object.values(ENTITY_PREFIX)).size).toBe(Object.values(ENTITY_PREFIX).length);
    expect(MUTATION_PERMISSIONS['chat.post']).toBe('chat.use');
  });

  it('gates all seventeen commands at the chat protocol, which this build speaks', () => {
    const chat = Object.entries(COMMAND_MIN_PROTOCOL).filter(([event]) => event.startsWith('chat:'));
    expect(chat).toHaveLength(17);
    for (const [, needs] of chat) expect(needs).toBe(CHAT_MIN_PROTOCOL);
    expect(PANEL_PROTOCOL_VERSION).toBeGreaterThanOrEqual(CHAT_MIN_PROTOCOL);
  });

  it('has an English sentence for every system line', () => {
    for (const key of Object.values(CHAT_SYSTEM_KEYS)) {
      expect(EN_MESSAGES).toHaveProperty(key);
    }
  });
});
