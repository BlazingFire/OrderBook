/**
 * What a server process does with an error nobody caught.
 *
 * A shop PC that restarts its Master in the middle of the day over one failed
 * broadcast is worse than one that logs it and carries on, so a stray rejection or
 * exception is logged and the process keeps serving. But a process that keeps
 * throwing is in a state nobody can reason about, so past `max` such errors inside
 * `windowMs` it is told to stop, cleanly, and the desktop shell starts a fresh one.
 */

export interface CrashLogger {
  error(message: string, error?: unknown): void;
}

/** The slice of `process` this uses; a test passes an `EventEmitter`. */
export interface ProcessLike {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
}

export interface CrashGuardOptions {
  /** Errors tolerated inside the window. Default 5. */
  max?: number;
  /** Default one minute. */
  windowMs?: number;
  now?: () => number;
  /** Called once, when the limit is passed. */
  onRepeated: (reason: string) => void;
}

export function installCrashGuard(
  proc: ProcessLike,
  log: CrashLogger,
  options: CrashGuardOptions,
): void {
  const max = options.max ?? 5;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const times: number[] = [];
  let tripped = false;

  function seen(kind: string, error: unknown): void {
    log.error(kind, error);
    const at = now();
    times.push(at);
    while (times.length > 0 && at - (times[0] as number) > windowMs) times.shift();
    if (times.length > max && !tripped) {
      tripped = true;
      log.error(
        `More than ${max} unhandled errors in ${windowMs / 1000} seconds; stopping to restart clean`,
      );
      options.onRepeated('repeated unhandled errors');
    }
  }

  proc.on('unhandledRejection', (reason) => seen('Unhandled rejection', reason));
  proc.on('uncaughtException', (error) => seen('Uncaught exception', error));
}
