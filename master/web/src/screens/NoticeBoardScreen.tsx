/**
 * The Notice board on the Master Panel: the notices meant for the signed-in person (U4). The kit's
 * `NoticeBoardView` does the drawing; this reads them from the Master and records what is read.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Notice } from '@orderbook/shared';

import { api } from '../api';
import { NoticeBoardView, apiErrorText } from '@orderbook/ui';
import { todayForNotices } from '../noticeToday';

interface Props {
  /** Moves when a notice changes (a `notice` change event), so the board re-reads. */
  revision: number;
  /** Tells the shell the unread count, for the badge on the sidebar row. */
  onUnreadChange?: (count: number) => void;
  /** The notice a Basic Home slide opened. */
  focus?: { id: string; nonce: number };
}

export function NoticeBoardScreen({ revision, onUnreadChange, focus }: Props) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .notices()
      .then((board) => {
        if (!live) return;
        setNotices(board.notices);
        setUnread(board.unreadCount);
        setError(null);
        onUnreadChange?.(board.unreadCount);
      })
      .catch((caught) => live && setError(apiErrorText(caught, 'notices.board.loadFailed')))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // `onUnreadChange` is the shell's and changes identity every render; the read follows the revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, retry]);

  const markRead = useCallback(
    async (ids: string[] | undefined) => {
      setActionError(null);
      const { unreadCount } = await api.markNoticesRead(ids);
      setNotices((current) =>
        current.map((notice) => (!ids || ids.includes(notice.id) ? { ...notice, readByMe: true } : notice)),
      );
      setUnread(unreadCount);
      onUnreadChange?.(unreadCount);
    },
    [onUnreadChange],
  );

  return (
    <NoticeBoardView
      notices={notices}
      unreadCount={unread}
      loading={loading}
      error={error}
      onRetry={() => setRetry((count) => count + 1)}
      actionError={actionError}
      online
      onMarkRead={(ids) => markRead(ids).catch((caught) => setActionError(apiErrorText(caught, 'notices.board.markFailed')))}
      onMarkAllRead={() => markRead(undefined).catch((caught) => setActionError(apiErrorText(caught, 'notices.board.markFailed')))}
      today={todayForNotices()}
      focus={focus}
    />
  );
}

