/**
 * The handful of settings the shell owns, in a small JSON file beside the
 * panel's data.
 *
 * Deliberately not in PostgreSQL: the shell has to read this before the server
 * exists, and on the Office panel there is no database at all. Deliberately
 * not in `userData` either, for the same reason the data directory is not —
 * an operator should not have to find an Electron cache folder.
 *
 * There is exactly one field, and it is not the setting itself. Whether the
 * app starts with Windows is owned by the OS (`app.getLoginItemSettings()`);
 * what we need to remember is only whether we have already applied the
 * first-run default, because `setLoginItemSettings({openAtLogin: true})` ran
 * on *every* packaged launch and silently turned auto-start back on for anyone
 * who had turned it off.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ShellSettings {
  autoStartDefaultApplied: boolean;
}

const DEFAULTS: ShellSettings = { autoStartDefaultApplied: false };

export function readShellSettings(file: string): ShellSettings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
    const record = parsed as Record<string, unknown>;
    return {
      autoStartDefaultApplied: record.autoStartDefaultApplied === true,
    };
  } catch {
    // Absent or corrupt reads as "nothing applied yet", which is safe: the
    // worst case is offering the first-run default once more.
    return { ...DEFAULTS };
  }
}

/**
 * Temp-then-rename, the same pattern `office/src/sync/outbox.store.ts` uses:
 * a half-written settings file must never be readable, because the next boot
 * reads it before anything else exists to notice.
 */
export function writeShellSettings(file: string, settings: ShellSettings): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // A setting that will not persist is not worth failing a launch over.
  }
}
