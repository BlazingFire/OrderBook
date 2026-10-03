/**
 * Auto-print station mode (docs/ORDER_NOTES_PLAN.md, the Printroom).
 *
 * A PC that prints the Printroom's jobs by itself is usually left minimised.
 * A hidden or minimised Chromium window throttles its timers and pauses
 * animation frames, and a page that is not rendering prints blank or late. While
 * station mode is on the shell therefore turns background throttling off.
 *
 * The page asks; the main process decides. Only the literal boolean `true`
 * turns the mode on (a string, `1` or an object do not), so a malformed request
 * can only leave the window as it normally is.
 *
 * Here rather than in `shell.ts` because that file imports `electron` and
 * cannot run under the suite; this decision can.
 */

/** Whether a request from the page switches station mode on. Anything but the boolean `true` is off. */
export function parseStationMode(value: unknown): boolean {
  return value === true;
}

/** Throttle background timers and frames only when the PC is not a print station. */
export function backgroundThrottlingFor(stationMode: boolean): boolean {
  return !stationMode;
}
