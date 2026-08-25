/**
 * Minimal `.env` loader.
 *
 * Settings like the database connection string belong in a file the operator
 * edits once, not an environment variable they have to re-export in every
 * terminal. `.env` is gitignored, so credentials stay off the repository.
 *
 * Dependency-free on purpose: this runs before anything else during startup,
 * and the format we need is a handful of `KEY=value` lines.
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Loads each file in order, skipping any that do not exist.
 *
 * A real environment variable always wins over the file, so a one-off
 * `$env:DATABASE_URL=...` still overrides `.env` for that run — the behaviour
 * people expect from dotenv.
 */
export function loadEnvFiles(...files: string[]): void {
  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Split on \r?\n: a .env written by Notepad on Windows has CRLF endings,
    // and a stray \r would end up inside the value.
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      if (!key || key in process.env) continue;

      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

/**
 * Set one `KEY=value` in a `.env`, preserving everything else in the file.
 *
 * Rewrites the matching line in place rather than appending, so moving a
 * panel's storage twice leaves one line rather than two — with a dotenv file
 * the last assignment wins, but a file that accumulates stale paths is one
 * somebody eventually reads and believes.
 *
 * The value is quoted whenever it contains a space, because a Windows path
 * under `C:\Program Files` would otherwise be truncated by `loadEnvFiles`'s
 * own trimming when it is read back.
 */
export async function writeEnvValue(file: string, key: string, value: string): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    // No file yet — the panel is running entirely on defaults.
  }

  const line = `${key}=${/\s/.test(value) ? `"${value}"` : value}`;
  const lines = existing.split(/\r?\n/);
  const index = lines.findIndex((entry) => entry.trim().startsWith(`${key}=`));

  if (index === -1) {
    // Keep exactly one trailing newline whether or not the file had one.
    const body = existing.trimEnd();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body ? `${body}\n${line}\n` : `${line}\n`, { mode: 0o600 });
    return;
  }

  lines[index] = line;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.join('\n'), { mode: 0o600 });
}
