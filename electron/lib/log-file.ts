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

/**
 * Shift `file` to `file.1`, `.1` to `.2` and so on, dropping the oldest.
 * Returns false, having touched nothing, when the live file cannot be moved —
 * on Windows another program holding it open (an editor, a technician's
 * `Get-Content -Wait`, a virus scanner) is enough. Moving the live file first
 * is what keeps a failed attempt from pushing the old files down regardless.
 */
function rotate(file: string): boolean {
  const moving = `${file}.rotating`;
  try {
    fs.renameSync(file, moving);
  } catch {
    return false;
  }
  try {
    // Oldest first, so each rename lands on a free name.
    const oldest = `${file}.${KEEP}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let index = KEEP - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${index + 1}`);
    }
    fs.renameSync(moving, `${file}.1`);
  } catch {
    // A log that cannot rotate must not stop the app from starting.
  }
  return true;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * @param tee also write to stdout — useful unpackaged, pointless packaged.
 * @param maxBytes the size at which the file rotates; a test passes a small one.
 */
export function openLogFile(file: string, tee = false, maxBytes = MAX_BYTES): LogFile {
  let stream: fs.WriteStream | null = null;
  let written = 0;

  const open = (): void => {
    try {
      const opened = fs.createWriteStream(file, { flags: 'a' });
      /*
       * Without this, a failed write raises an unhandled `error` event and
       * takes the process down — and worse, a stalled writer back-pressures
       * the pipe the child is writing into until the child blocks. That is the
       * same failure class `master/tests/postgres-launcher.test.ts` exists
       * for. If the log breaks, drop the log, not the application.
       */
      opened.on('error', () => {
        if (stream === opened) stream = null;
      });
      stream = opened;
      written = sizeOf(file);
    } catch {
      stream = null;
    }
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (sizeOf(file) >= maxBytes) rotate(file);
    open();
  } catch {
    stream = null;
  }

  const writeRaw = (chunk: string): void => {
    if (tee) process.stdout.write(chunk);
    if (!stream) return;
    try {
      stream.write(chunk);
      written += Buffer.byteLength(chunk);
      /*
       * Rotate while running too, not only at start: a Master left on for
       * weeks would otherwise grow one file without bound. The old stream's
       * unflushed lines follow its handle into `.1`, which is where they
       * belong; Windows allows the rename because Node opens files shareable
       * for delete.
       */
      if (written >= maxBytes) {
        stream.end();
        stream = null;
        const rotated = rotate(file);
        open();
        // A file that would not move waits another full size before the
        // next try, rather than retrying on every line.
        if (!rotated) written = 0;
      }
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
