/**
 * What the Master is doing before it can serve anything, and why it stopped if
 * it did.
 *
 * This exists because of a failure mode with no symptom. The Master used to
 * open its HTTP port only *after* PostgreSQL was up, migrated and checked — so
 * anything that went wrong before that (a cluster that will not start, a port
 * already taken, a major-version mismatch, a missing font) killed the process
 * with the explanation in a console window the operator never looks at. From
 * the browser, the port simply never opened: the panel sat on its starting
 * screen for ever, with no way to find out why and nothing to click.
 *
 * So the port now opens first and this is what it serves in the meantime. A
 * startup failure becomes a sentence on the screen the operator is already
 * staring at, instead of a silence.
 */

type BootState = 'starting' | 'ready' | 'failed';

export interface BootStatus {
  state: BootState;
  /** What the server is doing right now — shown while `starting`. */
  step: string;
  /** Why it stopped, in words an operator can act on. Only when `failed`. */
  message: string | null;
  /** The underlying error, for the log and for anyone reading the response. */
  detail: string | null;
}

let status: BootStatus = {
  state: 'starting',
  step: 'Starting up',
  message: null,
  detail: null,
};

export function bootStatus(): BootStatus {
  return { ...status };
}

export function bootStep(step: string): void {
  if (status.state !== 'starting') return;
  status = { ...status, step };
}

export function bootReady(): void {
  status = { state: 'ready', step: 'Ready', message: null, detail: null };
}

export function bootFailed(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  status = { state: 'failed', step: status.step, message: explain(detail), detail };
}

/** Test seam. */
export function resetBootStatus(): void {
  status = { state: 'starting', step: 'Starting up', message: null, detail: null };
}

/**
 * Turn the error into the thing to actually do about it.
 *
 * The three cases below are the ones that have actually happened on a shop PC,
 * and each has a fix the operator can carry out without reading a stack trace.
 * Anything unrecognised falls through to the raw message rather than a shrug —
 * an unfamiliar error is still more use than "something went wrong".
 */
function explain(detail: string): string {
  const lower = detail.toLowerCase();

  if (lower.includes('root') || lower.includes('administrator') || lower.includes('privileged')) {
    return 'PostgreSQL refuses to run as an administrator. Close this and start OrderBook from a normal user account.';
  }

  if (lower.includes('eaddrinuse') || lower.includes('address already in use')) {
    return 'Something else on this PC is already using the port OrderBook needs. It is usually another copy of the Master Panel still running — close it and start this one again.';
  }

  if (lower.includes('pg_version') || lower.includes('data directory') || lower.includes('incompatible')) {
    return 'The existing database folder was created by a different version of PostgreSQL and cannot be opened. Nothing has been changed or deleted — see README.md under “Upgrading across a PostgreSQL major version”.';
  }

  return detail;
}
