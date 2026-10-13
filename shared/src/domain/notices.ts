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

import type { Product, ProductImage } from './entities.js';

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
  /**
   * Where it shows besides the board (2026-10-08): the band on Basic Home, and the pop-up right
   * after sign-in. At least one is true. Optional on the wire: a Master older than these fields
   * sends neither, and absent reads as true (`noticeOnHome`, `noticeAtSignIn`), which is how
   * every notice showed before.
   */
  showOnHome?: boolean;
  showAtSignIn?: boolean;
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
  /** Omitted on a create: true. Both false is refused (`no_placement`). */
  showOnHome?: boolean;
  showAtSignIn?: boolean;
  audience?: NoticeAudience;
}

/** An edit says which version it was made from; the Master refuses it if somebody else got there first. */
export type NoticeUpdate = Partial<NoticeInput> & { expectedVersion: number };

/** A role a notice can be addressed to: what the editor's audience picker lists. */
export interface NoticeAudienceRole {
  id: string;
  name: string;
}

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
  /**
   * The reader's "Sell today" entries that have not ended (some may start later), never counted
   * in `unreadCount`. Absent from a Master older than `SELL_TODAY_MIN_PROTOCOL`.
   */
  sellToday?: SellToday[];
}

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

/** Whether a notice goes in the Basic Home band. Absent (an older Master) is yes. */
export function noticeOnHome(notice: Pick<Notice, 'showOnHome'>): boolean {
  return notice.showOnHome !== false;
}

/** Whether a notice goes in the pop-up after sign-in. Absent (an older Master) is yes. */
export function noticeAtSignIn(notice: Pick<Notice, 'showAtSignIn'>): boolean {
  return notice.showAtSignIn !== false;
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
  | 'audience_too_big'
  | 'no_placement';

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
  // Shown nowhere but the board is what the board alone is for: one of the two stays on. An edit
  // that sends only one of them is checked against the stored other by the Master.
  if (input.showOnHome === false && input.showAtSignIn === false) return 'no_placement';
  return null;
}

// --- Sell today (2026-10-08) -----------------------------------------------------------------

/*
 * "What to sell today": a headline, an optional message and the sub products the company wants
 * pushed, put up by a notice manager for chosen days. It pops up once per person per day after
 * sign-in (or when it first appears while signed in) and closes by itself after
 * `autoCloseSeconds`, and its products lead the product band on Basic Home.
 *
 * Stored as a row of `notices` with `kind = 'sellToday'`, so it shares the audience, the
 * version, the soft delete and the Recycle Bin with a notice. It is never one on the wire: the
 * board, its badge, the Basic Home notice band and the sign-in pop-up only ever see `kind =
 * 'notice'` rows, and sell-today entries travel in their own lists (`NoticeBoard.sellToday`,
 * `SyncSnapshot.sellToday`) and their own commands (`sellToday:*`), so a panel older than them
 * shows nothing of them rather than showing them as notices.
 */

/** The first panel protocol with the `sellToday:*` commands and the snapshot's `sellToday`. */
export const SELL_TODAY_MIN_PROTOCOL = 11;

/** At most this many products in one entry: a pop-up of photo cards, not a catalogue. */
export const SELL_TODAY_PRODUCTS_MAX = 12;
/** "Close by itself after" is 0 (only when closed) or 5 to 120 seconds. */
export const SELL_TODAY_AUTO_CLOSE_MIN = 5;
export const SELL_TODAY_AUTO_CLOSE_MAX = 120;
export const SELL_TODAY_AUTO_CLOSE_DEFAULT = 15;

/** One product of an entry, resolved by the Master so a panel needs no catalogue to draw the card. */
export interface SellTodayProduct {
  /** The sub product (`products.id`). */
  id: string;
  name: string;
  /** Its code (the first active variant's), or null. */
  code: string | null;
  size: string | null;
  /** The main product it sits under (its category's name). */
  mainProduct: string | null;
  /** The primary photo, or null for a sub product without one. */
  image: ProductImage | null;
}

export interface SellToday {
  id: string;
  tenantId: string;
  /** The headline. */
  title: string;
  /** The optional message; plain text, line breaks kept. */
  body: string;
  /** In the order the manager picked them, including any since deleted (left out of `products`). */
  productIds: string[];
  /** The live ones of `productIds`, in that order. Empty for a reader without `products.view`. */
  products: SellTodayProduct[];
  /** 0: stays until closed. Otherwise closes by itself after this many seconds. */
  autoCloseSeconds: number;
  /** `YYYY-MM-DD`, the first day it applies, in the company's time zone. */
  showFrom: string | null;
  /** `YYYY-MM-DD`, the last day it applies. Null: until removed. */
  showUntil: string | null;
  audience: NoticeAudience;
  /** Manager's list only, as on `Notice`. */
  audienceRoleNames?: string[];
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Manager's list only: past its last day. */
  expired?: boolean;
}

/** What a manager sends to create or change an entry. */
export interface SellTodayInput {
  title: string;
  body?: string;
  productIds?: string[];
  autoCloseSeconds?: number;
  showFrom?: string | null;
  showUntil?: string | null;
  audience?: NoticeAudience;
}

export type SellTodayUpdate = Partial<SellTodayInput> & { expectedVersion: number };

export type SellTodayProblem =
  | 'title_required'
  | 'title_too_long'
  | 'body_too_long'
  | 'bad_date'
  | 'dates_reversed'
  | 'audience_empty'
  | 'audience_too_big'
  | 'nothing_to_sell'
  | 'too_many_products'
  | 'bad_auto_close';

/** Whether a number of seconds is one "Close by itself after" accepts. */
export function isSellTodayAutoClose(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (value === 0 || (value >= SELL_TODAY_AUTO_CLOSE_MIN && value <= SELL_TODAY_AUTO_CLOSE_MAX))
  );
}

/**
 * Checks a create or edit, as `noticeProblem` does. A create needs a headline and something to
 * sell (a product or a message); an edit is checked on what it sends, and the Master checks the
 * merged result of the dates and of "something to sell" against what is stored.
 */
export function sellTodayProblem(
  input: Partial<SellTodayInput>,
  mode: 'create' | 'update',
): SellTodayProblem | null {
  if (mode === 'create' || input.title !== undefined) {
    const title = (input.title ?? '').trim();
    if (!title) return 'title_required';
    if (title.length > NOTICE_TITLE_MAX) return 'title_too_long';
  }
  if (input.body !== undefined && input.body.length > NOTICE_BODY_MAX) return 'body_too_long';
  if (input.productIds !== undefined && new Set(input.productIds).size > SELL_TODAY_PRODUCTS_MAX)
    return 'too_many_products';
  if (mode === 'create' && (input.productIds ?? []).length === 0 && !(input.body ?? '').trim())
    return 'nothing_to_sell';
  if (input.autoCloseSeconds !== undefined && !isSellTodayAutoClose(input.autoCloseSeconds))
    return 'bad_auto_close';
  if (input.showFrom != null && !isNoticeDay(input.showFrom)) return 'bad_date';
  if (input.showUntil != null && !isNoticeDay(input.showUntil)) return 'bad_date';
  if (input.showFrom != null && input.showUntil != null && input.showUntil < input.showFrom)
    return 'dates_reversed';
  if (input.audience?.kind === 'roles') {
    if (input.audience.roleIds.length === 0) return 'audience_empty';
    if (input.audience.roleIds.length > NOTICE_AUDIENCE_MAX_ROLES) return 'audience_too_big';
  }
  return null;
}

/** Whether an entry applies on `today`: on or after its first day and not past its last. */
export function sellTodayApplies(entry: Pick<SellToday, 'showFrom' | 'showUntil'>, today: string): boolean {
  return (entry.showFrom === null || entry.showFrom <= today) && !isNoticeExpired(entry.showUntil, today);
}

/** Today's entry: of those that apply today, the newest. One a day is the rule; overlap shows the newest. */
export function sellTodayFor(entries: readonly SellToday[] | undefined, today: string): SellToday | null {
  let newest: SellToday | null = null;
  for (const entry of entries ?? []) {
    if (!sellTodayApplies(entry, today)) continue;
    if (!newest || entry.createdAt > newest.createdAt) newest = entry;
  }
  return newest;
}

/** A sub product as a card: its first active code, its main product, its primary photo. */
export function sellTodayProductOf(product: Product): SellTodayProduct {
  const variant = product.variants.find((each) => each.isActive) ?? product.variants[0];
  return {
    id: product.id,
    name: product.name,
    code: variant?.code ?? null,
    size: product.size,
    mainProduct: product.categoryName || null,
    image: product.images.find((image) => image.isPrimary) ?? product.images[0] ?? null,
  };
}
