/**
 * The notice board's reads on this panel.
 *
 * `notice:markRead` is online-only and has no outbox mutation (the Master records a
 * read once per person and notice, and ignores ids outside the reader's board, so a
 * replay changes nothing). A read made while the Master is out of reach is kept here,
 * per signed-in user, in this window's storage and sent once the link is back, retried with a
 * backoff until the Master takes it. Until
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

/**
 * Sends this user's queued reads; what the Master took leaves the queue. True when some are
 * still waiting: the Master was out of reach, not yet ready for the command (426), or wants
 * this person to sign in again (401 `sign_in_again`). A replay changes nothing on the Master,
 * so trying again is always safe.
 */
async function flush(userId: string): Promise<boolean> {
  const ids = load(userId);
  if (ids.length === 0) return false;
  try {
    await api.markNoticesRead(ids);
    const left = load(userId).filter((id) => !ids.includes(id));
    save(userId, left);
    return left.length > 0;
  } catch (error) {
    // Without `notices.view` the reads can never land.
    if (error instanceof ApiError && error.code === 'forbidden') {
      save(userId, []);
      return false;
    }
    return true;
  }
}

/** Waits between tries while the link is up: 1 s, 2 s, 4 s … at most 30 s. */
const RETRY_MS = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);

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

export function useNoticeReads(userId: string | null, online: boolean, revision: number) {
  const [state, setState] = useState<{ userId: string | null; ids: ReadonlySet<string> }>({
    userId: null,
    ids: new Set(),
  });
  // A different person: start from their own queue, never the previous person's reads.
  const readHere = state.userId === userId ? state.ids : new Set(userId ? load(userId) : []);

  useEffect(() => {
    setState({ userId, ids: new Set(userId ? load(userId) : []) });
  }, [userId]);

  // Sends the queue on sign-in, on the link coming up, on every fresh snapshot (`revision`: the
  // person is attached again and the Master's protocol is known) and on every new read, then
  // keeps trying with a backoff while something is left and the link stays up.
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (!userId || !online) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (tries: number) => {
      const again = await flush(userId);
      if (live && again) timer = setTimeout(() => void attempt(tries + 1), RETRY_MS(tries));
    };
    void attempt(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [userId, online, revision, nudge]);

  const markRead = useCallback(
    (ids: string[]) => {
      if (!userId || ids.length === 0) return;
      setState((current) => ({
        userId,
        ids: new Set([...(current.userId === userId ? current.ids : []), ...ids]),
      }));
      save(userId, [...new Set([...load(userId), ...ids])]);
      setNudge((count) => count + 1);
    },
    [userId],
  );

  return { readHere, markRead };
}
