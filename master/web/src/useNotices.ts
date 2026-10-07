import { useCallback, useEffect, useState } from 'react';
import type { Notice } from '@orderbook/shared';

import { api } from './api';

/**
 * The notices meant for the signed-in person and how many are unread, for the sidebar badge, the
 * Dashboard card and the Basic Home slideshow. Re-reads whenever `revision` moves (a `notice` change
 * event). `enabled` is false for somebody without `notices.view`: nothing is asked.
 *
 * Kept per person (`userId`): the shell stays mounted across a sign-out, so without the key the next
 * person saw the previous person's list, a notice for a role they are not in included, until their own
 * read came back; and a read the previous person started could land after the switch. Now a different
 * person starts empty on the very first render, and an answer for anybody else is dropped.
 *
 * The Notice board screen reports its own unread count back through `setUnread`, so the badge drops the
 * moment a notice is marked read instead of waiting for the next read.
 */
export function useNotices(
  revision: number,
  enabled: boolean,
  userId: string | null,
): {
  notices: Notice[];
  unread: number | undefined;
  setUnread: (count: number) => void;
} {
  const [state, setState] = useState<{ userId: string | null; notices: Notice[]; unread?: number }>(
    {
      userId: null,
      notices: [],
    },
  );
  const mine = state.userId === userId ? state : { userId, notices: [], unread: undefined };

  useEffect(() => {
    if (!enabled || !userId) return;
    let live = true;
    api
      .notices()
      .then((board) => {
        if (!live) return;
        setState({ userId, notices: board.notices, unread: board.unreadCount });
      })
      // A Master older than the notice board has no such route; the row simply carries no badge.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [revision, enabled, userId]);

  const setUnread = useCallback(
    (count: number) =>
      setState((current) => (current.userId === userId ? { ...current, unread: count } : current)),
    [userId],
  );
  const unread = enabled ? mine.unread : undefined;
  return {
    notices: enabled ? mine.notices : [],
    unread: unread && unread > 0 ? unread : undefined,
    setUnread,
  };
}
