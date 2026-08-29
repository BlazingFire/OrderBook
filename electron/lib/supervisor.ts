/**
 * Deciding what a server process exiting means.
 *
 * This is the module the owner's bug report was about. The old rule was: any
 * child exit at all — including a clean `0` — shows an error dialog and quits
 * the application. So a server that stopped for any reason took the window
 * with it, and the panel "closed by itself".
 *
 * The replacement is a bounded supervisor: an unexpected exit restarts the
 * server, up to a few times inside a window, and only then asks the operator
 * what to do. Pure, so all of it is testable without spawning anything.
 */

/** How long after launching an installer a child exit is still expected. */
export const UPDATE_WINDOW_MS = 60_000;

/** Restarts allowed inside {@link RESTART_WINDOW_MS} before we stop trying. */
export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;

export interface ExitContext {
  /** A quit is under way, so the child was asked to stop. */
  quitting: boolean;
  /** When we launched an installer, if we have. */
  updatingSince: number | null;
  /**
   * A relocation is under way: the server was stopped on purpose so it can be
   * started again against a different data directory. Without this the
   * supervisor reads that stop as a crash and starts a *second* server, and
   * the two race for the port — the first one to bind wins and the other dies
   * with `EADDRINUSE`, which then counts as another crash.
   */
  relocating: boolean;
  now: number;
}

/**
 * Is this exit one we asked for?
 *
 * Note the exit *code* is deliberately not consulted. A clean `0` we did not
 * ask for is still a crash — the server has no reason to stop on its own, and
 * treating `0` as fine is what left a live window over a dead backend.
 */
export function isExpectedExit(context: ExitContext): boolean {
  if (context.quitting || context.relocating) return true;
  return isUpdating(context.updatingSince, context.now);
}

/**
 * Are we inside the window where an installer is expected to replace us?
 *
 * The old flag was a boolean set before spawning the installer and cleared
 * only in the `catch`, so an installer that started and then died — or a UAC
 * prompt the operator cancelled — left it stuck on for the life of the
 * process, permanently suppressing every later crash report. A timestamp
 * expires on its own.
 */
export function isUpdating(updatingSince: number | null, now: number): boolean {
  if (updatingSince === null) return false;
  return now - updatingSince < UPDATE_WINDOW_MS;
}

/** Drop restarts that have aged out of the window. */
export function pruneRestarts(history: readonly number[], now: number): number[] {
  return history.filter((at) => now - at < RESTART_WINDOW_MS);
}

/**
 * May we restart again? Call with the already-pruned history.
 *
 * Bounded because an unbounded restart loop against a server that cannot start
 * — a corrupt cluster, a taken port — is a spinning process with no message,
 * which is worse than the dialog it replaced.
 */
export function canRestart(history: readonly number[], now: number): boolean {
  return pruneRestarts(history, now).length < RESTART_LIMIT;
}
