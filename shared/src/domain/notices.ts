/**
 * The notice board: short messages the company puts up for everybody, or for chosen roles.
 *
 * A notice is plain text (no markup, so nothing to sanitise and nothing a panel can be made to
 * run), has a priority, may be pinned, and may carry a "show until" date after which it is
 * no longer on the board. Who sees it is its audience: everybody, or the people holding any of
 * the chosen roles. Whoever may manage notices sees them all, expired ones included.
 *
 * Reading is recorded per person (`notice_reads`), so the board can show an unread badge and a
 * manager can see who has read what.
 */

import type { Permission } from './permissions.js';

/**
 * The first panel protocol that speaks the notice board: its commands (`COMMAND_MIN_PROTOCOL`)
 * and the `notices` field of the snapshot. Frozen here, never tied to `PANEL_PROTOCOL_VERSION`,
 * which keeps rising.
 */
export const NOTICE_MIN_PROTOCOL = 10;

export const NOTICE_PRIORITIES = ['normal', 'important'] as const;
export type NoticePriority = (typeof NOTICE_PRIORITIES)[number];

export function isNoticePriority(value: unknown): value is NoticePriority {
  return typeof value === 'string' && (NOTICE_PRIORITIES as readonly string[]).includes(value);
}

/** Limits, enforced by the Master and used by the editor to say so before it is submitted. */
export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 4000;
/** At most this many roles in one audience: more than any company has, so it only bounds a bad request. */
export const NOTICE_AUDIENCE_MAX_ROLES = 50;

/** Who a notice is for. `roles` holds at least one role id. */
export type NoticeAudience = { kind: 'all' } | { kind: 'roles'; roleIds: string[] };

export interface Notice {
  id: string;
  tenantId: string;
  title: string;
  /** Plain text; line breaks are kept. */
  body: string;
  priority: NoticePriority;
  /** Pinned notices sort first. */
  pinned: boolean;
  /** `YYYY-MM-DD` in the company's business time zone: the last day it is shown. Null: until removed. */
  showUntil: string | null;
  audience: NoticeAudience;
  /**
   * Role names for `audience.roleIds`, in the same order. Present only on what a manager reads
   * (roles are withheld from panels), absent for an ordinary reader.
   */
  audienceRoleNames?: string[];
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Rises on every change; an edit says which version it saw (`expectedVersion`). */
  version: number;
  /**
   * Whether the person reading has read it. Present in a reader's list and in the snapshot,
   * absent in a manager's list (which is about the notice, not about the reader).
   */
  readByMe?: boolean;
  /** True once `showUntil` has passed. Only a manager's list ever holds an expired notice. */
  expired?: boolean;
  /** Manager's list only: how many people have read it, and how many may see it. */
  readCount?: number;
  audienceSize?: number;
}

/** What a manager sends to create or change a notice. */
export interface NoticeInput {
  title: string;
  body: string;
  priority?: NoticePriority;
  pinned?: boolean;
  showUntil?: string | null;
  audience?: NoticeAudience;
}

/** An edit says which version it was made from; the Master refuses it if somebody else got there first. */
export type NoticeUpdate = Partial<NoticeInput> & { expectedVersion: number };

export interface NoticeReader {
  userId: string;
  displayName: string;
  /** Null for somebody in the audience who has not read it. */
  readAt: string | null;
}

/** Who may see a notice and who has read it. Manager only. */
export interface NoticeReaders {
  noticeId: string;
  readers: NoticeReader[];
}

/** What a reader gets: the notices meant for them, newest and pinned first, and how many are unread. */
export interface NoticeBoard {
  notices: Notice[];
  unreadCount: number;
}

/** The permission keys. `view` is held by every role; `manage` is the administrator's. */
export const NOTICE_PERMISSIONS = {
  view: 'notices.view',
  manage: 'notices.manage',
} as const satisfies Record<string, Permission>;

/** Today in `YYYY-MM-DD` for a business time zone, the way `showUntil` is compared. */
export function noticeToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Whether a notice is past its last day. A notice with no date never expires. */
export function isNoticeExpired(showUntil: string | null, today: string): boolean {
  return showUntil !== null && showUntil < today;
}

/** Pinned first, then important, then newest. The order of both lists. */
export function compareNotices(a: Notice, b: Notice): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.priority !== b.priority) return a.priority === 'important' ? -1 : 1;
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

export type NoticeProblem =
  | 'title_required'
  | 'title_too_long'
  | 'body_too_long'
  | 'bad_priority'
  | 'bad_date'
  | 'audience_empty'
  | 'audience_too_big';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, not just the right shape (2026-02-31 is refused). */
export function isNoticeDay(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Checks a create or edit before it is stored. A create needs a title; an edit may leave
 * fields out. Returns the first problem found, or null. The Master runs it on every write,
 * the editor runs it to say so before the request is sent.
 */
export function noticeProblem(
  input: Partial<NoticeInput>,
  mode: 'create' | 'update',
): NoticeProblem | null {
  if (mode === 'create' || input.title !== undefined) {
    const title = (input.title ?? '').trim();
    if (!title) return 'title_required';
    if (title.length > NOTICE_TITLE_MAX) return 'title_too_long';
  }
  if (input.body !== undefined && input.body.length > NOTICE_BODY_MAX) return 'body_too_long';
  if (input.priority !== undefined && !isNoticePriority(input.priority)) return 'bad_priority';
  if (input.showUntil != null && !isNoticeDay(input.showUntil)) return 'bad_date';
  if (input.audience?.kind === 'roles') {
    if (input.audience.roleIds.length === 0) return 'audience_empty';
    if (input.audience.roleIds.length > NOTICE_AUDIENCE_MAX_ROLES) return 'audience_too_big';
  }
  return null;
}
