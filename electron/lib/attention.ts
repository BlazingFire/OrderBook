/**
 * What the page may put in a system notification (`orderbook:notify`).
 *
 * The page is not trusted to send a sensible notice: anything that is not a
 * pair of strings is refused, and both are trimmed and cut short so a page
 * cannot fill the screen with a toast. Windows cuts a toast's text long before
 * these limits anyway.
 *
 * Here rather than in `shell.ts` because that file imports `electron` and
 * cannot run under the suite; this decision can.
 */

export const TITLE_MAX = 120;
export const BODY_MAX = 300;

export interface AttentionText {
  title: string;
  body: string;
}

export function attentionText(value: unknown): AttentionText | null {
  const title = (value as { title?: unknown } | null)?.title;
  const body = (value as { body?: unknown } | null)?.body;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  const clampedTitle = title.trim().slice(0, TITLE_MAX);
  if (clampedTitle === '') return null;
  return { title: clampedTitle, body: body.trim().slice(0, BODY_MAX) };
}
