/**
 * Minimal leveled logger. Deliberately dependency-free: this software runs on
 * an offline shop PC where the useful output is a readable console, not a log
 * aggregation pipeline.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const activeLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

/** Property names whose values are credentials: a pairing password, a panel's old secret, a token, a key. */
const SECRET_NAME = /password|secret|token|passphrase|apikey|authorization/i;

/**
 * A copy of `value` with every credential-named property replaced, so a request body or an error
 * that carries one (`previousPanelSecret`, `pairingPassword`) cannot put it in the console or a log
 * file. Defence in depth: nothing logs a request body today, and this keeps it that way when something does.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = SECRET_NAME.test(key) ? '[redacted]' : redactSecrets(inner, depth + 1);
  }
  // An Error keeps its message and stack, which Object.entries does not see.
  if (value instanceof Error) {
    return Object.assign(new Error(value.message), { name: value.name, stack: value.stack }, copy);
  }
  return copy;
}

function write(level: Level, scope: string, message: string, rawDetail?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;
  const detail = redactSecrets(rawDetail);

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (detail === undefined) {
    stream(line);
  } else {
    stream(line, detail);
  }
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
