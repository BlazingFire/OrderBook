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
