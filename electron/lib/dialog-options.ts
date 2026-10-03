/**
 * What the page may ask of a native chooser (`orderbook:chooseDirectory` and
 * `orderbook:chooseFile`).
 *
 * The page names a title and, for a file, the extensions to offer. Neither is
 * trusted: a title that is not a short string falls back to the shell's own,
 * and an extension list keeps only plain names (`zip`, not `*.zip` or
 * `../x`). With nothing usable left, the chooser offers `.zip`, the one file a
 * panel asks for today (a backup archive).
 *
 * Here rather than in `shell.ts` because that file imports `electron` and
 * cannot run under the suite; this decision can.
 */

export const DIALOG_TITLE_MAX = 120;
const MAX_EXTENSIONS = 8;
const DEFAULT_EXTENSIONS = ['zip'];

export function dialogTitle(value: unknown, fallback: string): string {
  const title = (value as { title?: unknown } | null)?.title;
  if (typeof title !== 'string') return fallback;
  const clamped = title.trim().slice(0, DIALOG_TITLE_MAX);
  return clamped === '' ? fallback : clamped;
}

export function dialogExtensions(value: unknown): string[] {
  const raw = (value as { extensions?: unknown } | null)?.extensions;
  if (!Array.isArray(raw)) return DEFAULT_EXTENSIONS;
  const kept: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const extension = item.trim().toLowerCase();
    if (/^[a-z0-9]{1,10}$/.test(extension) && !kept.includes(extension)) kept.push(extension);
    if (kept.length === MAX_EXTENSIONS) break;
  }
  return kept.length > 0 ? kept : DEFAULT_EXTENSIONS;
}
