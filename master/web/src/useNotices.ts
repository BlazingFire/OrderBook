import { useCallback, useEffect, useState } from 'react';
import type { Notice } from '@orderbook/shared';

import { api } from './api';

/**
 * The notices meant for the signed-in person and how many are unread, for the sidebar badge and the
 * Dashboard card. Re-reads whenever `revision` moves (a `notice` change event). `enabled` is false for
 * somebody without `notices.view`: nothing is asked.
 *
 * The Notice board screen reports its own unread count back through `setUnread`, so the badge drops the
 * moment a notice is marked read instead of waiting for the next read.
 */
export function useNotices(
  revision: number,
  enabled: boolean,
): {
  notices: Notice[];
  unread: number | undefined;
  setUnread: (count: number) => void;
} {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnreadState] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api
      .notices()
      .then((board) => {
        if (!live) return;
        setNotices(board.notices);
        setUnreadState(board.unreadCount);
      })
      // A Master older than the notice board has no such route; the row simply carries no badge.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [revision, enabled]);

  const setUnread = useCallback((count: number) => setUnreadState(count), []);
  return { notices, unread: unread && unread > 0 ? unread : undefined, setUnread };
}
