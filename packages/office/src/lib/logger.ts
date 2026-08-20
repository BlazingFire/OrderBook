/** Same minimal leveled logger as the Master — see packages/master/src/lib/logger.ts. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const activeLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

function write(level: Level, scope: string, message: string, detail?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (detail === undefined) stream(line);
  else stream(line, detail);
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, detail) => write('debug', scope, message, detail),
    info: (message, detail) => write('info', scope, message, detail),
    warn: (message, detail) => write('warn', scope, message, detail),
    error: (message, detail) => write('error', scope, message, detail),
  };
}
