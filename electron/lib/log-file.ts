/**
 * A log file for the desktop shell and the server it hosts.
 *
 * A packaged, windowed Electron app has no console: `process.stdout.write`
 * goes to a stream nobody can read. The shell nevertheless forwarded the
 * child's stdout and stderr there, and the crash dialog told the operator "the
 * log is in <dataDir>" — a directory whose only log file came from PostgreSQL.
 * When a shop PC would not start, there was genuinely nothing to go on.
 *
 * Both the shell's own lines and the child's output go here, formatted the
 * same way as `master/src/lib/logger.ts` so the two read as one stream.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export interface LogFile {
  write(line: string): void;
  /** Raw child output, which already carries its own newlines. */
  writeRaw(chunk: string): void;
  readonly path: string;
  close(): void;
}

function rotate(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_BYTES) return;

    // Oldest first, so each rename lands on a free name.
    const oldest = `${file}.${KEEP}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let index = KEEP - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${index + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // A log that cannot rotate must not stop the app from starting.
  }
}

/**
 * @param tee also write to stdout — useful unpackaged, pointless packaged.
 */
export function openLogFile(file: string, tee = false): LogFile {
  let stream: fs.WriteStream | null = null;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    stream = fs.createWriteStream(file, { flags: 'a' });
    /*
     * Without this, a failed write raises an unhandled `error` event and takes
     * the process down — and worse, a stalled writer back-pressures the pipe
     * the child is writing into until the child blocks. That is the same
     * failure class `master/tests/postgres-launcher.test.ts` exists for. If
     * the log breaks, drop the log, not the application.
     */
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }

  const writeRaw = (chunk: string): void => {
    if (tee) process.stdout.write(chunk);
    try {
      stream?.write(chunk);
    } catch {
      stream = null;
    }
  };

  return {
    path: file,
    writeRaw,
    write(line) {
      writeRaw(`${new Date().toISOString()} ${line}\n`);
    },
    close() {
      try {
        stream?.end();
      } catch {
        // Nothing useful to do while shutting down.
      }
      stream = null;
    },
  };
}
