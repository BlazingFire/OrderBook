/**
 * How the order-note Print button reaches the printer (docs/ORDER_NOTES_PLAN.md).
 *
 * The page names a printer, and the page is not trusted to have named a real
 * one: it is checked against the printers Windows lists. A name that is not
 * there — a printer that was unplugged or renamed since the choice was
 * remembered — falls back to the system dialog instead of failing or spooling
 * a job into nothing.
 *
 * Here rather than in `shell.ts` because that file imports `electron` and
 * cannot run under the suite; this decision can.
 */

export const MAX_COPIES = 50;

/** An integer 1..50; anything else (a string, 0, 51, 2.5, missing) is one copy. */
export function clampCopies(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_COPIES
    ? value
    : 1;
}

/**
 * The file name offered to Save PDF. The page names it, so it is cleaned here:
 * no path separators or characters Windows refuses, no control characters, one
 * space between parts, at most 100 characters, always ending `.pdf`.
 */
export function pdfFileName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.pdf$/i, '')
    .trim()
    .replace(/^[-. ]+|[. ]+$/g, '')
    .slice(0, 100)
    .trim();
  return cleaned === '' ? 'note.pdf' : `${cleaned}.pdf`;
}

export interface PrintRequest {
  silent: boolean;
  deviceName?: string;
  /** Sheets of the whole job, 1..50, collated — set whether or not a printer is named. */
  copies: number;
  collate: true;
  printBackground: true;
  pageSize: 'A4';
  margins: { marginType: 'none' };
}

export function printOptions(requested: unknown, installed: readonly string[]): PrintRequest {
  const copies = clampCopies((requested as { copies?: unknown } | null)?.copies);
  const base = {
    printBackground: true,
    pageSize: 'A4',
    margins: { marginType: 'none' },
    copies,
    collate: true,
  } as const;
  const name = (requested as { deviceName?: unknown } | null)?.deviceName;

  if (typeof name === 'string' && name !== '' && installed.includes(name)) {
    return { ...base, silent: true, deviceName: name };
  }
  return { ...base, silent: false };
}
