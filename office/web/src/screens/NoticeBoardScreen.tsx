/**
 * The Notice board on the Office panel: the reader's list from the snapshot
 * (`view.notices`, already scoped to this person), with the reads made here already
 * laid over it by `withReadsHere`. Marking works offline too: `useNoticeReads` keeps
 * the read and sends it when the Master is back, so the view is never told it is offline.
 */

import type { Notice } from '@orderbook/shared';
import { NoticeBoardView } from '@orderbook/ui';

import { unreadOnBoard, todayForNotices } from '../noticeReads';

interface Props {
  notices: Notice[];
  onMarkRead: (ids: string[]) => void;
  /** The notice a Basic Home slide opened. */
  focus?: { id: string; nonce: number };
}

export function NoticeBoardScreen({ notices, onMarkRead, focus }: Props) {
  const today = todayForNotices();
  const unread = unreadOnBoard(notices, today);
  return (
    <NoticeBoardView
      notices={notices}
      unreadCount={unread.length}
      online
      today={today}
      focus={focus}
      onMarkRead={onMarkRead}
      onMarkAllRead={() => onMarkRead(unread.map((notice) => notice.id))}
    />
  );
}
