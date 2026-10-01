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

export interface PrintRequest {
  silent: boolean;
  deviceName?: string;
  printBackground: true;
  pageSize: 'A4';
  margins: { marginType: 'none' };
}

export function printOptions(requested: unknown, installed: readonly string[]): PrintRequest {
  const base = { printBackground: true, pageSize: 'A4', margins: { marginType: 'none' } } as const;
  const name = (requested as { deviceName?: unknown } | null)?.deviceName;

  if (typeof name === 'string' && name !== '' && installed.includes(name)) {
    return { ...base, silent: true, deviceName: name };
  }
  return { ...base, silent: false };
}
