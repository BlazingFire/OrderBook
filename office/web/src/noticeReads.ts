/**
 * The notice board's reads on this panel.
 *
 * `notice:markRead` is online-only and has no outbox mutation (the Master records a
 * read once per person and notice, and ignores ids outside the reader's board, so a
 * replay changes nothing). A read made while the Master is out of reach is kept here,
 * per signed-in user, in this window's storage and sent on the next reconnect. Until
 * the next snapshot says `readByMe`, the ids read here count as read, so the badge and
 * the board move the moment somebody marks something.
 *
 * Keyed by user id: a read queued by somebody who signed out is never sent under
 * whoever signs in next. It waits for its own person.
 */

import { useCallback, useEffect, useState } from 'react';

import { isNoticeExpired, noticeToday, type Notice } from '@orderbook/shared';

import { ApiError, api } from './api';

/** Today on this PC's clock, so a notice whose last day passes while the cached snapshot is all there is leaves the board. */
export function todayForNotices(now: Date = new Date()): string {
  return noticeToday(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

const keyFor = (userId: string) => `orderbook.noticeReads.${userId}`;

function load(userId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function save(userId: string, ids: string[]): void {
  try {
    if (ids.length > 0) localStorage.setItem(keyFor(userId), JSON.stringify(ids));
    else localStorage.removeItem(keyFor(userId));
  } catch {
    // Storage blocked: the read is still sent now when online, only an offline one is lost.
  }
}

/** Sends this user's queued reads plus `extra`; what the Master took leaves the queue. */
async function flush(userId: string, extra: string[] = []): Promise<void> {
  const ids = [...new Set([...load(userId), ...extra])];
  if (ids.length === 0) return;
  try {
    await api.markNoticesRead(ids);
    save(
      userId,
      load(userId).filter((id) => !ids.includes(id)),
    );
  } catch (error) {
    // Without `notices.view` the reads can never land; anything else waits for the next link.
    if (error instanceof ApiError && error.code === 'forbidden') save(userId, []);
  }
}

/** This person's notices with the reads made on this panel counted as read. */
export function withReadsHere(notices: readonly Notice[], readHere: ReadonlySet<string>): Notice[] {
  return notices.map((notice) =>
    !notice.readByMe && readHere.has(notice.id) ? { ...notice, readByMe: true } : notice,
  );
}

/** The unread ones still on the board today: the badge, the board's count and Mark all as read. */
export function unreadOnBoard(notices: readonly Notice[], today: string): Notice[] {
  return notices.filter((notice) => !notice.readByMe && !isNoticeExpired(notice.showUntil, today));
}

export function useNoticeReads(userId: string | null, online: boolean) {
  const [state, setState] = useState<{ userId: string | null; ids: ReadonlySet<string> }>({
    userId: null,
    ids: new Set(),
  });
  // A different person: start from their own queue, never the previous person's reads.
  const readHere =
    state.userId === userId ? state.ids : new Set(userId ? load(userId) : []);

  useEffect(() => {
    setState({ userId, ids: new Set(userId ? load(userId) : []) });
  }, [userId]);

  useEffect(() => {
    if (userId && online) void flush(userId);
  }, [userId, online]);

  const markRead = useCallback(
    (ids: string[]) => {
      if (!userId || ids.length === 0) return;
      setState((current) => ({
        userId,
        ids: new Set([...(current.userId === userId ? current.ids : []), ...ids]),
      }));
      save(userId, [...new Set([...load(userId), ...ids])]);
      if (online) void flush(userId, ids);
    },
    [userId, online],
  );

  return { readHere, markRead };
}
