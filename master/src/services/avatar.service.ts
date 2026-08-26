/**
 * Profile pictures for people.
 *
 * Deliberately its own service rather than a branch inside `image.service.ts`:
 * that pipeline is built around a product's *gallery* — captions, a primary
 * flag, ordering, four landscape-ish variants — and none of that applies to one
 * square picture of a face that replaces whatever was there before.
 *
 * What it does borrow is the shape, because that shape is right: decode once,
 * auto-orient from EXIF, derive every size from a single normalized raster, and
 * never re-encode an already-encoded variant, so repeated changes in one
 * session cannot compound quality loss.
 *
 * Storage mirrors the image pipeline too — variants as files under the images
 * directory, keyed by an id minted per upload, with the row keeping only what a
 * client needs to build a URL and paint a placeholder. A new id per upload is
 * what makes the URL immutable, so every variant can be served
 * `Cache-Control: immutable` and a changed picture is a changed URL rather than
 * a cache to bust.
 */

import { AVATAR_LONG_EDGE, MAX_AVATAR_SOURCE_BYTES, type User } from '@orderbook/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import { publishChange } from './change-bus.js';

/**
 * Three square sizes, and no more. `full` is what a profile screen shows,
 * `thumb` a dialog header, `micro` a roster row or the status footer — asking
 * for a 1080px file to paint a 24px circle is the mistake these exist to stop.
 */
const VARIANT_SPECS = [
  { name: 'full', size: AVATAR_LONG_EDGE, quality: 86 },
  { name: 'thumb', size: 240, quality: 80 },
  { name: 'micro', size: 64, quality: 60 },
] as const;

export type AvatarVariantName = (typeof VARIANT_SPECS)[number]['name'];

function avatarDir(tenantId: string, avatarId: string): string {
  return path.join(config.imagesDir, tenantId, 'avatars', avatarId);
}

/** `variant` is untrusted input — this is the only place a filename is built from it. */
export function avatarFilePath(tenantId: string, avatarId: string, variant: string): string | null {
  if (!VARIANT_SPECS.some((spec) => spec.name === variant)) return null;
  return path.join(avatarDir(tenantId, avatarId), `${variant}.webp`);
}

/**
 * Who may change whose picture.
 *
 * A person always owns their own, which is the common case and needs no
 * permission at all — it is their face. Changing somebody else's is a roster
 * edit and needs `users.manage`.
 */
function assertMayEdit(actor: ActorContext, userId: string): void {
  if (actor.userId === userId) return;
  requirePermission(actor, 'users.manage');
}

export async function uploadAvatar(
  input: { userId: string; fileBuffer: Buffer },
  actor: ActorContext,
): Promise<User> {
  assertMayEdit(actor, input.userId);

  if (input.fileBuffer.length === 0) throw new ValidationError('validation.avatar.fileRequired');
  // Checked before any decode: a decoder is the wrong place to discover that
  // somebody has sent a 400MB TIFF.
  if (input.fileBuffer.length > MAX_AVATAR_SOURCE_BYTES) {
    throw new ValidationError('validation.avatar.tooLarge');
  }

  const existing = await userRepo.findById(actor.tenantId, input.userId);
  if (!existing) throw new NotFoundError('User');

  const avatarId = randomUUID();
  const stored = await normalizeAndStore(actor.tenantId, avatarId, input.fileBuffer);

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    await userRepo.updateUserColumns(
      actor.tenantId,
      input.userId,
      {
        avatar_id: avatarId,
        avatar_blurhash: stored.blurhash,
        avatar_size: stored.size,
        avatar_byte_size: stored.byteSize,
        avatar_uploaded_at: new Date(),
      },
      { hlc, fieldHlc: { ...existing.sync.fieldHlc, avatar: hlc } },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: input.userId,
        action: 'avatar_set',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { avatarId, byteSize: stored.byteSize },
      },
      actor,
      trx,
    );
  });

  // The old files go only after the row no longer points at them, so a crash
  // between the two leaves an orphaned directory rather than a broken picture.
  await removeStoredAvatar(actor.tenantId, existing.avatar?.id ?? null);

  return reload(actor.tenantId, input.userId);
}

export async function removeAvatar(userId: string, actor: ActorContext): Promise<User> {
  assertMayEdit(actor, userId);

  const existing = await userRepo.findById(actor.tenantId, userId);
  if (!existing) throw new NotFoundError('User');
  // Captured out of the record: the narrowing does not survive into the
  // transaction's closure, and the id is wanted after the row stops naming it.
  const previous = existing.avatar;
  if (!previous) return existing;

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    await userRepo.updateUserColumns(
      actor.tenantId,
      userId,
      {
        avatar_id: null,
        avatar_blurhash: null,
        avatar_size: null,
        avatar_byte_size: null,
        avatar_uploaded_at: null,
      },
      { hlc, fieldHlc: { ...existing.sync.fieldHlc, avatar: hlc } },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: userId,
        action: 'avatar_cleared',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { avatarId: previous.id },
      },
      actor,
      trx,
    );
  });

  await removeStoredAvatar(actor.tenantId, previous.id);
  return reload(actor.tenantId, userId);
}

async function reload(tenantId: string, userId: string): Promise<User> {
  const user = await userRepo.findById(tenantId, userId);
  if (!user) throw new NotFoundError('User');
  publishChange({ entity: 'user', id: userId, action: 'updated', payload: user });
  return user;
}

async function removeStoredAvatar(tenantId: string, avatarId: string | null): Promise<void> {
  if (!avatarId) return;
  await rm(avatarDir(tenantId, avatarId), { recursive: true, force: true });
}

/**
 * Decode once, auto-orient, square-crop from the centre, then derive every size
 * from that single raster.
 *
 * The centre crop is deliberate and unconditional. An avatar is shown as a
 * circle or a rounded square everywhere it appears, so a non-square source has
 * to lose something no matter what; doing it once here means every size agrees,
 * rather than each render inventing its own crop.
 */
async function normalizeAndStore(
  tenantId: string,
  avatarId: string,
  fileBuffer: Buffer,
): Promise<{ size: number; blurhash: string; byteSize: number }> {
  let square: sharp.Sharp;
  let edge: number;

  try {
    const oriented = sharp(fileBuffer, { failOn: 'error' }).rotate();
    const meta = await oriented.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width === 0 || height === 0) throw new ValidationError('validation.avatar.unreadable');

    // Never upscale: a 300px source stays 300px rather than being blown up to
    // 1080 and looking worse than the file that was uploaded.
    edge = Math.min(width, height, AVATAR_LONG_EDGE);
    square = sharp(fileBuffer, { failOn: 'error' })
      .rotate()
      .resize(edge, edge, { fit: 'cover', position: 'centre' });
  } catch (caught) {
    if (caught instanceof ValidationError) throw caught;
    throw new ValidationError('validation.avatar.unreadable');
  }

  const master = await square.webp({ quality: 90 }).toBuffer();
  const dir = avatarDir(tenantId, avatarId);
  await mkdir(dir, { recursive: true });

  let byteSize = 0;
  for (const spec of VARIANT_SPECS) {
    const target = Math.min(spec.size, edge);
    const encoded = await sharp(master)
      .resize(target, target, { fit: 'cover' })
      .webp({ quality: spec.quality })
      .toBuffer();
    await writeFile(path.join(dir, `${spec.name}.webp`), encoded);
    if (spec.name === 'full') byteSize = encoded.length;
  }

  // Blurhash wants raw RGBA, and a tiny raster is plenty for four-by-four
  // components — encoding from the full-size image would be pure waste.
  const { data, info } = await sharp(master)
    .resize(32, 32, { fit: 'cover' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const blurhash = encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 4);

  return { size: edge, blurhash, byteSize };
}
