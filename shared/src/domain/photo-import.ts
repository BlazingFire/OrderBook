/**
 * Bulk product photo import (Products -> Photo import on the Master): a folder
 * of images named by code, each attached to its sub product through the
 * ordinary one-photo upload, so the pipeline, the permission and the change
 * events are the ones a single photo already uses.
 *
 * A file is matched by its name without the extension, ignoring case, to a
 * variant code (`OPT-0011.jpg`) and, failing that, to a sub product's alias.
 * Photos belong to the sub product, not the variant (`product_images` has no
 * variant column), so a file matched through a colour's code lands in its sub
 * product's gallery captioned with that colour's label.
 *
 * **Slots.** `OPT-0011.jpg` is the sub product's photo 1, its primary;
 * `OPT-0011_2.jpg` is photo 2, and so on, in the gallery's own order (primary
 * first, then by sequence). A file whose slot is empty adds a photo. A file
 * whose slot is taken is skipped, or with "replace" swaps that one photo and
 * no other: a `_2` never touches the primary, and a new photo 1 becomes the
 * primary.
 *
 * Pure: the screen hands in the files and the products it already loaded, and
 * the uploader as functions, so the matching and the run are tested here
 * without a browser or a server.
 */

import type { Product } from './entities.js';

export const PHOTO_IMPORT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

export type PhotoPlanStatus =
  /** Matched, and its slot is empty: the photo is added. */
  | 'new'
  /** Matched, and the sub product already has a photo in that slot: skipped or replaced, as chosen. */
  | 'hasPhoto'
  /** An image whose name is no code or alias in the catalogue. */
  | 'unmatched'
  /** The same name as another file (another extension or case, or another folder): `duplicateOf` is imported instead. */
  | 'duplicate'
  /** Not a jpg, jpeg, png or webp file, by its name or by its first bytes. */
  | 'notImage';

/** What the planner reads from a file: its name and, when the screen read them, its first bytes. */
export interface PhotoFileLike {
  name: string;
  /** The first 12 bytes or more; absent means the bytes were not read and only the name is judged. */
  head?: Uint8Array;
}

export interface PhotoPlanRow<F> {
  file: F;
  fileName: string;
  status: PhotoPlanStatus;
  /** The code or alias the name matched, as the catalogue spells it. */
  matchedAs?: string;
  productId?: string;
  productName?: string;
  /** The colour's label when matched through a variant code of a multi-variant sub product. */
  caption?: string | null;
  /** 1 for `CODE.jpg` (the primary), N for `CODE_N.jpg`. */
  slot?: number;
  /** The photo in that slot when the plan was made: what "replace" removes. */
  slotImageId?: string;
  /** Every photo the sub product had when the plan was made. */
  existingImageIds?: string[];
  /** For a duplicate: the file imported in its place. */
  duplicateOf?: string;
}

/** `OPT-0011_2.JPG` -> `{ code: 'opt-0011', full: 'opt-0011_2', base: 'OPT-0011_2', slot: 2 }`; null when not an image name. */
export function photoFileKey(fileName: string): { code: string; full: string; base: string; slot: number } | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (!(PHOTO_IMPORT_EXTENSIONS as readonly string[]).includes(extension)) return null;
  const base = fileName.slice(0, dot).trim();
  if (!base) return null;
  const full = base.toLowerCase();
  // `_1` and `_0` are not slots: `CODE.jpg` is photo 1, so a `_1` would be a second spelling of it.
  const suffix = /_([2-9]|[1-9]\d+)$/.exec(full);
  return suffix
    ? { code: full.slice(0, suffix.index), full, base, slot: Number(suffix[1]) }
    : { code: full, full, base, slot: 1 };
}

/** JPEG, PNG or WebP by the first bytes; the extension alone lets a renamed text file through. */
export function isImageBytes(head: Uint8Array): boolean {
  const at = (index: number) => head[index];
  const ascii = (from: number, text: string) => [...text].every((char, index) => at(from + index) === char.charCodeAt(0));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return true;
  if (at(0) === 0x89 && ascii(1, 'PNG\r\n\u001a\n')) return true;
  return ascii(0, 'RIFF') && ascii(8, 'WEBP');
}

interface Target {
  product: Product;
  matchedAs: string;
  caption: string | null;
}

function targetsByName(products: readonly Product[]): Map<string, Target> {
  const byCode = new Map<string, Target>();
  for (const product of products) {
    for (const variant of product.variants) {
      byCode.set(variant.code.toLowerCase(), {
        product,
        matchedAs: variant.code,
        caption: product.hasVariants ? variant.label : null,
      });
    }
  }

  // An alias two sub products share names neither, and a code always wins
  // over an alias that happens to spell it.
  const aliasCount = new Map<string, number>();
  for (const product of products) {
    const alias = product.alias?.trim().toLowerCase();
    if (alias) aliasCount.set(alias, (aliasCount.get(alias) ?? 0) + 1);
  }
  const targets = new Map(byCode);
  for (const product of products) {
    const alias = product.alias?.trim();
    const key = alias?.toLowerCase();
    if (!alias || !key || aliasCount.get(key) !== 1 || byCode.has(key)) continue;
    targets.set(key, { product, matchedAs: alias, caption: null });
  }
  return targets;
}

/** The gallery's own order: the primary first, then by sequence. */
function galleryOrder(product: Product): string[] {
  return [...product.images]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sequence - b.sequence)
    .map((image) => image.id);
}

const byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The preview: one row per file, in file-name order. Of two files with the
 * same name ignoring case and extension, the one spelled exactly as the
 * catalogue spells the code is imported, else the first alphabetically; the
 * other is a duplicate naming it.
 */
export function planPhotoImport<F extends PhotoFileLike>(
  files: readonly F[],
  products: readonly Product[],
): PhotoPlanRow<F>[] {
  const targets = targetsByName(products);
  const keyed = files.map((file) => {
    const key = photoFileKey(file.name);
    const target = key ? targets.get(key.code) : undefined;
    const exact = Boolean(key && target && key.base === `${target.matchedAs}${key.slot > 1 ? key.full.slice(key.code.length) : ''}`);
    return { file, key, target, exact };
  });

  // Who wins a shared name is decided before anything is labelled, and never by the folder's order.
  const winners = new Map<string, string>();
  for (const entry of [...keyed].sort(
    (a, b) => Number(b.exact) - Number(a.exact) || byCodepoint(a.file.name, b.file.name),
  )) {
    if (!entry.key || (entry.file.head && !isImageBytes(entry.file.head))) continue;
    if (!winners.has(entry.key.full)) winners.set(entry.key.full, entry.file.name);
  }

  const rows = keyed.map(({ file, key, target }): PhotoPlanRow<F> => {
    const base = { file, fileName: file.name };
    if (!key || (file.head && !isImageBytes(file.head))) return { ...base, status: 'notImage' };
    const winner = winners.get(key.full) as string;
    if (winner !== file.name) return { ...base, status: 'duplicate', duplicateOf: winner };
    if (!target) return { ...base, status: 'unmatched' };

    const gallery = galleryOrder(target.product);
    const slotImageId = gallery[key.slot - 1];
    return {
      ...base,
      status: slotImageId ? 'hasPhoto' : 'new',
      matchedAs: target.matchedAs,
      productId: target.product.id,
      productName: target.product.name,
      caption: target.caption,
      slot: key.slot,
      ...(slotImageId ? { slotImageId } : {}),
      existingImageIds: gallery,
    };
  });
  return rows.sort((a, b) => a.fileName.localeCompare(b.fileName, 'en', { numeric: true }) || byCodepoint(a.fileName, b.fileName));
}

export type PhotoImportMode = 'skip' | 'replace';

export type PhotoResult = 'imported' | 'skipped' | 'failed';

export interface PhotoImportOutcome<F> {
  row: PhotoPlanRow<F>;
  result: PhotoResult;
  /** Why a file failed, as the screen should show it. */
  error?: string;
}

export interface PhotoImportDeps<F> {
  /** Adds the photo; answers the new photo's id when it knows it (needed to make a new photo 1 primary). */
  upload: (productId: string, file: F, caption: string | null) => Promise<string | null | undefined | void>;
  removeImage: (productId: string, imageId: string) => Promise<unknown>;
  /** Makes a photo the primary; only a replaced photo 1 asks. */
  setPrimary?: (productId: string, imageId: string) => Promise<unknown>;
  /** Milliseconds to wait before retrying, when the error is the Master's rate limit; null otherwise. */
  retryAfterMs: (error: unknown) => number | null;
  errorText: (error: unknown) => string;
  wait?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  /** Checked between files: true stops the run, and what is left is reported as skipped. */
  stopped?: () => boolean;
}

/** Retries per file on a rate-limit refusal before it counts as failed. */
const RATE_LIMIT_RETRIES = 5;

async function withRetry<T>(work: () => Promise<T>, deps: PhotoImportDeps<never>): Promise<T> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const ms = deps.retryAfterMs(error);
      if (ms === null || attempt >= RATE_LIMIT_RETRIES) throw error;
      await wait(ms);
    }
  }
}

/**
 * Upload the plan one file at a time (the Master encodes one photo at a time
 * anyway), a sub product's files together. Safe to run again: with "skip", a
 * taken slot is left alone, so a second run adds only what the first did not.
 *
 * "Replace" uploads a sub product's new photos first, and removes the photos
 * they replace only once every new one is in, so a failed upload never leaves
 * a sub product with fewer photos than it had. A new photo 1 is made primary
 * before the old one goes.
 */
export async function runPhotoImport<F>(
  plan: readonly PhotoPlanRow<F>[],
  mode: PhotoImportMode,
  deps: PhotoImportDeps<F>,
): Promise<PhotoImportOutcome<F>[]> {
  const retryDeps = deps as unknown as PhotoImportDeps<never>;
  const outcomes: PhotoImportOutcome<F>[] = [];
  const groups = new Map<string, PhotoPlanRow<F>[]>();
  for (const row of plan) {
    const wanted = row.status === 'new' || (row.status === 'hasPhoto' && mode === 'replace');
    if (!wanted || !row.productId) {
      outcomes.push({ row, result: 'skipped' });
      continue;
    }
    groups.set(row.productId, [...(groups.get(row.productId) ?? []), row]);
  }

  const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
  let done = 0;
  deps.onProgress?.(done, total);

  for (const [productId, rows] of groups) {
    // Photo 1 first, so the gallery fills in its own order.
    rows.sort((a, b) => (a.slot ?? 1) - (b.slot ?? 1));
    let allIn = true;
    const replaced: Array<{ row: PhotoPlanRow<F>; newId: string | null }> = [];
    for (const row of rows) {
      if (deps.stopped?.()) {
        outcomes.push({ row, result: 'skipped' });
        allIn = false;
        continue;
      }
      try {
        const newId = await withRetry(() => deps.upload(productId, row.file, row.caption ?? null), retryDeps);
        outcomes.push({ row, result: 'imported' });
        if (row.slotImageId) replaced.push({ row, newId: typeof newId === 'string' ? newId : null });
      } catch (error) {
        outcomes.push({ row, result: 'failed', error: deps.errorText(error) });
        allIn = false;
      }
      done += 1;
      deps.onProgress?.(done, total);
    }

    if (!allIn) continue;
    for (const { row, newId } of replaced) {
      try {
        if (row.slot === 1 && newId && deps.setPrimary) {
          await withRetry(() => deps.setPrimary!(productId, newId), retryDeps);
        }
        await withRetry(() => deps.removeImage(productId, row.slotImageId as string), retryDeps);
      } catch (error) {
        // The new photo is in; an old one left over is shown, not hidden.
        const outcome = outcomes.find((entry) => entry.row === row);
        if (outcome) outcome.error = deps.errorText(error);
      }
    }
  }

  const order = new Map(plan.map((row, index) => [row, index]));
  return outcomes.sort((a, b) => (order.get(a.row) ?? 0) - (order.get(b.row) ?? 0));
}

/** The id of the photo an upload just added: uploads take the next sequence, so it is the highest. */
export function newestImageId(product: Pick<Product, 'images'>): string | null {
  return [...product.images].sort((a, b) => b.sequence - a.sequence)[0]?.id ?? null;
}
