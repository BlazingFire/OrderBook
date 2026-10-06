import { noticeToday } from '@orderbook/shared';

/**
 * Today as `YYYY-MM-DD` on this PC's clock, for leaving a notice off the board once its last day has
 * passed while the screen stays open. The Master already hides expired notices when it answers; this
 * only covers the day turning over.
 */
export function todayForNotices(now: Date = new Date()): string {
  return noticeToday(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
}
