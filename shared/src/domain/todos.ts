/**
 * The To-do list (2026-10-08): tasks an administrator writes for the office.
 *
 * A task is one line of plain text. Anybody holding `todos.view` marks it "In progress" or
 * "Completed"; more than one person may mark, each mark names its person and time, and a
 * person can take their own mark back. `todos.manage` writes and deletes tasks.
 *
 * Expiry is chosen when the task is written: none, at a fixed time (`expiresAt`), or a number
 * of hours after it was completed (`expireAfterHours`), counted from its earliest Completed
 * mark. An expired task leaves the list for everybody; the Master works that out when it reads.
 */

/**
 * The first panel protocol that speaks the To-do list: its `todo:*` commands. Frozen here,
 * never tied to `PANEL_PROTOCOL_VERSION`, which keeps rising. 11, the same as "Sell today":
 * the protocol rises once per release, and 11 had not been released when this was added.
 */
export const TODO_MIN_PROTOCOL = 11;

/** Limits, enforced by the Master (and the database) and used by the form. */
export const TODO_TEXT_MAX = 500;
/** "Expire after completion" is at most a year. */
export const TODO_EXPIRE_AFTER_HOURS_MAX = 8760;

export const TODO_MARK_STATUSES = ['in_progress', 'completed'] as const;
export type TodoMarkStatus = (typeof TODO_MARK_STATUSES)[number];

export function isTodoMarkStatus(value: unknown): value is TodoMarkStatus {
  return typeof value === 'string' && (TODO_MARK_STATUSES as readonly string[]).includes(value);
}

/** One person's mark on a task. */
export interface TodoMark {
  userId: string;
  name: string;
  status: TodoMarkStatus;
  markedAt: string;
}

export interface TodoTask {
  id: string;
  text: string;
  createdByName: string | null;
  createdAt: string;
  /**
   * When the task leaves the list: the fixed time, or the completion time plus
   * `expireAfterHours` once it is completed. Null while there is none (yet).
   */
  expiresAt: string | null;
  /** Set when the task expires that many hours after it is completed. */
  expireAfterHours: number | null;
  /** The earliest Completed mark; null while nobody has marked it completed. */
  completedAt: string | null;
  /** Oldest first. */
  marks: TodoMark[];
}

export interface TodoInput {
  text: string;
  /** An ISO time. Not with `expireAfterHours`. */
  expiresAt?: string | null;
  expireAfterHours?: number | null;
}

/** Put the acting person's mark on (`marked: true`) or take it off. */
export interface TodoMarkInput {
  id: string;
  status: TodoMarkStatus;
  marked: boolean;
}
