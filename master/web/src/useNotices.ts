import { useCallback, useEffect, useState } from 'react';
import type { Notice, SellToday } from '@orderbook/shared';

import { api } from './api';

/**
 * The notices meant for the signed-in person and how many are unread, for the sidebar badge and the
 * Dashboard card. Re-reads whenever `revision` moves (a `notice` change event). `enabled` is false for
 * somebody without `notices.view`: nothing is asked.
 *
 * The Notice board screen reports its own unread count back through `setUnread`, so the badge drops the
 * moment a notice is marked read instead of waiting for the next read. `loaded` turns true once the
 * first read after sign-in has answered, so the sign-in pop-up (V6) knows the list is real, and
 * `markRead` is the pop-up's way to mark notices read through the same route as the board.
 * `sellToday` is the person's "Sell today" entries from the same read (2026-10-08), for the pop-up
 * and the Basic Home product band; undefined until it has answered.
 */
export function useNotices(
  revision: number,
  enabled: boolean,
): {
  notices: Notice[];
  sellToday: SellToday[] | undefined;
  unread: number | undefined;
  loaded: boolean;
  setUnread: (count: number) => void;
  markRead: (ids: string[]) => Promise<void>;
} {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [sellToday, setSellToday] = useState<SellToday[] | undefined>(undefined);
  const [unread, setUnreadState] = useState<number | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Signed out (or no right to read): forget the last person's list, so the next sign-in starts
    // empty and unloaded and nothing of theirs is ever shown to somebody else.
    if (!enabled) {
      setNotices([]);
      setSellToday(undefined);
      setUnreadState(undefined);
      setLoaded(false);
      return;
    }
    let live = true;
    api
      .notices()
      .then((board) => {
        if (!live) return;
        setNotices(board.notices);
        setSellToday(board.sellToday ?? []);
        setUnreadState(board.unreadCount);
        setLoaded(true);
      })
      // A Master older than the notice board has no such route; the row simply carries no badge.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [revision, enabled]);

  const setUnread = useCallback((count: number) => setUnreadState(count), []);
  const markRead = useCallback(async (ids: string[]) => {
    const { unreadCount } = await api.markNoticesRead(ids);
    setNotices((current) => current.map((notice) => (ids.includes(notice.id) ? { ...notice, readByMe: true } : notice)));
    setUnreadState(unreadCount);
  }, []);
  return { notices, sellToday, unread: unread && unread > 0 ? unread : undefined, loaded, setUnread, markRead };
}
