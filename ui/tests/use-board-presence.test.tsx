/**
 * `useBoardPresence` (1.4 R22): the faces on a board's cards live on one read and
 * the Master's pushes, vanish when the link drops, and come back by themselves.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPresence, PresenceEntry } from '@orderbook/shared';

import { BOARD_RETRY_MAX_MS, BOARD_RETRY_MS, createPresenceChannel, useBoardPresence } from '../src/index.js';

const face = (userId: string): PresenceEntry => ({
  userId,
  displayName: `Name ${userId}`,
  avatar: null,
  tier: 'office',
  editing: false,
  since: '2026-10-03T09:00:00.000Z',
});

const board = (kind: 'lead' | 'order', records: Record<string, PresenceEntry[]>): BoardPresence => ({
  recordKind: kind,
  records,
});

function setup(read: (kind: 'lead' | 'order') => Promise<BoardPresence>) {
  const boardRead = vi.fn(read);
  const channel = createPresenceChannel({
    beat: vi.fn().mockResolvedValue(null),
    board: boardRead,
  });
  return { channel, boardRead };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useBoardPresence', () => {
  it('reads the board once when it opens, then takes each push as the whole board', async () => {
    const { channel, boardRead } = setup(async (kind) => board(kind, { 'LD-1': [face('u1')] }));
    const { result } = renderHook(() => useBoardPresence(channel, 'lead'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(boardRead).toHaveBeenCalledTimes(1);
    expect(boardRead).toHaveBeenCalledWith('lead');
    expect(result.current.get('LD-1')?.map((entry) => entry.userId)).toEqual(['u1']);

    act(() => channel.pushBoard(board('lead', { 'LD-2': [face('u2')] })));
    expect([...result.current.keys()]).toEqual(['LD-2']);

    // The other board's push is not this one's.
    act(() => channel.pushBoard(board('order', { 'OD-1': [face('u3')] })));
    expect([...result.current.keys()]).toEqual(['LD-2']);

    act(() => channel.pushBoard(board('lead', {})));
    expect(result.current.size).toBe(0);
  });

  it('drops every face when the link drops, and reads the board again a little later', async () => {
    const { channel, boardRead } = setup(async (kind) => board(kind, { 'LD-1': [face('u1')] }));
    const { result } = renderHook(() => useBoardPresence(channel, 'lead'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.size).toBe(1);

    act(() => channel.reset());
    expect(result.current.size).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_RETRY_MS);
    });
    expect(boardRead).toHaveBeenCalledTimes(2);
    expect(result.current.get('LD-1')).toBeDefined();
  });

  it('keeps asking quietly while the Master cannot be reached, less often each time', async () => {
    let up = false;
    const { channel, boardRead } = setup(async (kind) => {
      if (!up) throw new Error('offline');
      return board(kind, { 'LD-1': [face('u1')] });
    });
    const { result } = renderHook(() => useBoardPresence(channel, 'lead'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(boardRead).toHaveBeenCalledTimes(1);

    // 3 s, then 6 s, then 12 s: not a call every three seconds for ever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_RETRY_MS);
    });
    expect(boardRead).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_RETRY_MS * 2 - 1);
    });
    expect(boardRead).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(boardRead).toHaveBeenCalledTimes(3);
    expect(result.current.size).toBe(0);

    // However long it has been away, it never waits past the cap.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_RETRY_MAX_MS * 4);
    });
    const before = boardRead.mock.calls.length;
    up = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_RETRY_MAX_MS);
    });
    expect(boardRead.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.size).toBe(1);
  });

  it('asks nothing and hears nothing while its screen is hidden', async () => {
    const { channel, boardRead } = setup(async (kind) => board(kind, { 'LD-1': [face('u1')] }));
    const { result } = renderHook(() => useBoardPresence(channel, 'lead', false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_RETRY_MS * 2);
    });
    expect(boardRead).not.toHaveBeenCalled();
    act(() => channel.pushBoard(board('lead', { 'LD-1': [face('u1')] })));
    expect(result.current.size).toBe(0);
  });

  it('does nothing on a panel whose transport has no board read', () => {
    const channel = createPresenceChannel({ beat: vi.fn().mockResolvedValue(null) });
    const { result } = renderHook(() => useBoardPresence(channel, 'lead'));
    act(() => channel.pushBoard(board('lead', { 'LD-1': [face('u1')] })));
    expect(result.current.size).toBe(0);
  });
});
