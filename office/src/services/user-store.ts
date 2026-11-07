/**
 * Who has signed in on this panel, and what this panel remembers about them.
 *
 * One record per person, written on a successful **online** sign-in and read on
 * an offline one. This is the panel's slice of the user replica the offline
 * promise needs (docs/ROLES_AND_USERS.md §15) — deliberately a slice, not a
 * copy of the `users` table: the Master serves no hashes to a panel, and a
 * panel has no business knowing about staff who have never used it.
 *
 * The cached permission set is what an offline session is enforced against. It
 * is a snapshot, so it can be stale — a permission revoked while this panel was
 * unreachable keeps working here until the link returns. That is inherent to
 * offline authorisation and is why the Master re-checks every mutation on push;
 * the local set governs which buttons appear, never what the Master accepts.
 */

import fs from 'node:fs/promises';

import type { RoleTierName } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { writeDurable } from '../lib/durable-file.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('user-store');

export interface KnownUser {
  userId: string;
  /** Lower-cased. The lookup key, matching the Master's case-insensitive rule. */
  username: string;
  displayName: string;
  roleId: string | null;
  roleName: string;
  roleTier: RoleTierName;
  /** Minted by this panel from the plaintext. Never the Master's hash. */
  verifier: string;
  /**
   * The Master's marker for the password this verifier was minted from.
   *
   * Offered back on reconnect so the Master can say whether it still matches.
   * Without it, an administrator resetting somebody's password would not reach
   * this panel at all, and the old password would keep working offline forever —
   * the exact thing a reset is supposed to stop.
   */
  credentialFingerprint: string;
  /** Already intersected with the tier ceiling by the Master. */
  permissions: string[];
  roleVersion: number;
  /**
   * The last session token the Master issued for this person on this panel.
   *
   * Persisted so a panel restart, or a Master that was merely asleep, does not
   * force everyone to type their password again. It is strictly less powerful
   * than the pairing secret already sitting in this same directory, and the
   * Master's session map is in memory — so a Master restart invalidates it and
   * the person signs in again.
   */
  masterToken: string | null;
  lastSignInAt: string;
  /**
   * The person's profile picture, so the sign-in screen can show a face.
   *
   * The id only — the bytes are cached separately under `avatarsDir`, keyed by
   * this id, because the sign-in screen has to render them with nobody signed
   * in and the Master very possibly switched off. `null` means either no
   * picture or one this panel has never been online to fetch; the screen falls
   * back to initials either way.
   */
  avatarId: string | null;
  /** Colour placeholder for the picture, painted before the bytes decode. */
  blurhash: string | null;
}

interface StoredFile {
  users: KnownUser[];
}

let cache: StoredFile | null = null;

async function load(): Promise<StoredFile> {
  if (cache) return cache;

  try {
    const raw = await fs.readFile(paths().usersFile, 'utf8');
    const parsed = JSON.parse(raw) as StoredFile;
    cache = { users: Array.isArray(parsed.users) ? parsed.users : [] };
  } catch {
    cache = { users: [] };
  }

  return cache;
}

async function persist(file: StoredFile): Promise<void> {
  // This file decides who may use the panel when the Master cannot be asked.
  await writeDurable(paths().usersFile, JSON.stringify(file, null, 2));
}

export async function findByUsername(username: string): Promise<KnownUser | null> {
  const file = await load();
  const key = username.trim().toLowerCase();

  // The **last** match, not the first. `remember` keeps one record per username
  // so there should never be two, but a file written before it did will still
  // hold the pair — and there the newest is the only defensible answer, because
  // it came from the most recent successful sign-in against the Master.
  // `findLast` would say this in one word, but it needs a newer `lib` than the
  // package targets and this list is a handful of people.
  return [...file.users].reverse().find((user) => user.username === key) ?? null;
}

export async function findByUserId(userId: string): Promise<KnownUser | null> {
  const file = await load();
  return file.users.find((user) => user.userId === userId) ?? null;
}

/** Everyone this panel could sign in offline, for revalidation on reconnect. */
export async function listKnown(): Promise<KnownUser[]> {
  return [...(await load()).users];
}

/**
 * Insert or replace a person's record after a successful online sign-in.
 *
 * Replaces on **username as well as user id**, which is not the same thing: the
 * Master's uniqueness index is partial on live rows, deliberately, so that a
 * username freed by somebody leaving can be given to the next person. Two
 * records could therefore hold one username under different ids, and this file
 * resolves a sign-in by username — so the leaver's record shadowed the new
 * hire's. The new hire was refused offline against a verifier that was never
 * hers, and the person the company had deleted could still sign in here by
 * pulling the network cable. A panel holds at most one record per name.
 */
export async function remember(user: KnownUser): Promise<void> {
  const file = await load();
  const username = user.username.trim().toLowerCase();
  const others = file.users.filter(
    (existing) => existing.userId !== user.userId && existing.username !== username,
  );

  cache = { users: [...others, { ...user, username }] };
  await persist(cache);
}

/** Update the pieces that change without the password being retyped. */
export async function update(userId: string, patch: Partial<KnownUser>): Promise<void> {
  const file = await load();
  const existing = file.users.find((user) => user.userId === userId);
  if (!existing) return;

  cache = {
    users: file.users.map((user) => (user.userId === userId ? { ...user, ...patch } : user)),
  };
  await persist(cache);
}

/**
 * Drop a person's ability to sign in on this panel offline.
 *
 * Called when the Master tells us their session is no longer valid — the account
 * was deactivated, deleted, or its role removed. Leaving the verifier behind
 * would let somebody the company has locked out keep working here simply by
 * unplugging the network cable.
 */
export async function forget(userId: string): Promise<void> {
  const file = await load();
  const users = file.users.filter((user) => user.userId !== userId);
  if (users.length === file.users.length) return;

  cache = { users };
  await persist(cache);
  log.info(`Removed the local sign-in record for ${userId}`);
}

/** Test seam — the cache outlives a temp directory being rebuilt. */
export function resetUserStore(): void {
  cache = null;
}
