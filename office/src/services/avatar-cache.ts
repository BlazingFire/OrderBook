/**
 * Profile pictures, kept on this panel so the sign-in screen has faces.
 *
 * The sign-in screen has to render a person's picture with **nobody signed in
 * and the Master very possibly switched off** — which is the normal state of an
 * Office panel. Neither the Master's avatar route nor its panel image route can
 * serve that: both want an acting user's token, and on the sign-in screen there
 * is not one.
 *
 * So the bytes are fetched at the one moment this panel is definitely online
 * and definitely authorised — the instant somebody signs in — and written next
 * to the rest of the panel's data. Every later read is a local file, and a
 * missing file simply means initials.
 *
 * One directory per avatar id, matching the image cache. Ids are minted per
 * upload and never reused, so a cached file can never be stale: a new picture
 * is a new id.
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AVATAR_VARIANTS, type AvatarVariant } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('avatar-cache');

/** The size the sign-in list draws. `full` would be a needless download. */
const CACHED_VARIANT: AvatarVariant = 'thumb';

/** `randomUUID()` on the Master, so anything else cannot name a cached file. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function avatarFile(avatarId: string, variant: string): string | null {
  // Express decodes route params after matching, so an encoded separator
  // arrives here as a real one and would walk `path.join` out of the cache
  // directory. Both halves are checked against a closed set.
  if (!UUID_PATTERN.test(avatarId)) return null;
  if (!(AVATAR_VARIANTS as readonly string[]).includes(variant)) return null;

  return path.join(paths().avatarsDir, avatarId, `${variant}.webp`);
}

export function isCached(avatarId: string): boolean {
  const file = avatarFile(avatarId, CACHED_VARIANT);
  return file !== null && existsSync(file);
}

/**
 * Fetch and store one avatar, if it is not already here.
 *
 * Never throws: a picture that could not be fetched costs the sign-in screen a
 * face, and nothing else. Sign-in must not fail because a decorative byte range
 * was unavailable.
 */
export async function cacheAvatar(
  avatarId: string,
  fetchFromMaster: (path: string) => Promise<Response>,
): Promise<void> {
  const file = avatarFile(avatarId, CACHED_VARIANT);
  if (!file || existsSync(file)) return;

  try {
    const response = await fetchFromMaster(
      `/api/panel/avatars/${encodeURIComponent(avatarId)}/${CACHED_VARIANT}`,
    );
    if (!response.ok) return;

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    log.warn(
      `Could not cache the profile picture ${avatarId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Drop one person's cached picture, when their profile is forgotten. */
export async function forgetAvatar(avatarId: string): Promise<void> {
  if (!UUID_PATTERN.test(avatarId)) return;
  await fs.rm(path.join(paths().avatarsDir, avatarId), { recursive: true, force: true }).catch(
    () => undefined,
  );
}
