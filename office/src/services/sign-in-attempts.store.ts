/**
 * Failed sign-in attempts on this panel (docs/ROLES_AND_USERS.md §12).
 *
 * The Master enforces three failures then a sixty-second lock, but that counter
 * lives in its memory and guards its own sign-in path only. The panel's offline
 * path — the one reachable precisely when the Master cannot be asked — had no
 * counter, no lock and no back-off, so an unattended panel with the network
 * unplugged was an unthrottled guessing oracle against a locally-stored verifier.
 *
 * scrypt at N=16384 already caps that at a few dozen attempts a second, and the
 * panel's API is loopback-only, so this was bounded rather than wide open. It is
 * still the wrong shape for a door.
 *
 * **Persisted, deliberately.** An in-memory counter is reset by relaunching the
 * panel, which is not a meaningful obstacle to somebody sitting at the machine.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { paths } from '../config/paths.js';

interface Attempt {
  count: number;
  /** Epoch millis. Zero means not locked. */
  lockedUntil: number;
}

interface StoredFile {
  attempts: Record<string, Attempt>;
}

const MAX_FAILURES = 3;
const LOCKOUT_MS = 60_000;

let cache: StoredFile | null = null;

async function load(): Promise<StoredFile> {
  if (cache) return cache;

  try {
    const raw = await fs.readFile(paths().signInAttemptsFile, 'utf8');
    const parsed = JSON.parse(raw) as StoredFile;
    cache = { attempts: parsed.attempts ?? {} };
  } catch {
    cache = { attempts: {} };
  }

  return cache;
}

async function persist(file: StoredFile): Promise<void> {
  await fs.mkdir(path.dirname(paths().signInAttemptsFile), { recursive: true });
  await fs.writeFile(paths().signInAttemptsFile, JSON.stringify(file), { mode: 0o600 });
}

function key(username: string): string {
  return username.trim().toLowerCase();
}

/** Milliseconds remaining on a lock, or 0 when this username may try. */
export async function lockedFor(username: string, now = Date.now()): Promise<number> {
  const file = await load();
  const attempt = file.attempts[key(username)];
  if (!attempt) return 0;

  return attempt.lockedUntil > now ? attempt.lockedUntil - now : 0;
}

export async function recordFailure(username: string, now = Date.now()): Promise<void> {
  const file = await load();
  const id = key(username);
  const attempt = file.attempts[id] ?? { count: 0, lockedUntil: 0 };

  attempt.count += 1;

  if (attempt.count >= MAX_FAILURES) {
    attempt.lockedUntil = now + LOCKOUT_MS;
    attempt.count = 0;
  }

  cache = { attempts: { ...file.attempts, [id]: attempt } };
  await persist(cache);
}

export async function recordSuccess(username: string): Promise<void> {
  const file = await load();
  const id = key(username);
  if (!file.attempts[id]) return;

  const attempts = { ...file.attempts };
  delete attempts[id];

  cache = { attempts };
  await persist(cache);
}

/** Test seam — the cache outlives a temp directory being rebuilt. */
export function resetSignInAttempts(): void {
  cache = null;
}
