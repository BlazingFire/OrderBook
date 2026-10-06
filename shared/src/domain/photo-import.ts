/**
 * Bulk product photo import (Products -> Photo import on the Master): a folder
 * of images named by code, each attached to its sub product through the
 * ordinary one-photo upload, so the pipeline, the permission and the change
 * events are the ones a single photo already uses.
 *
 * A file is matched by its name without the extension, ignoring case, to a
 * variant code (`OPT-0011.jpg`) and, failing that, to a sub product's alias.
 * `OPT-0011_2.jpg` is a second photo for the same code. Photos belong to the
 * sub product, not the variant (`product_images` has no variant column), so a
 * file matched through a colour's code lands in its sub product's gallery
 * captioned with that colour's label.
 *
 * Pure: the screen hands in the files and the products it already loaded, and
 * the uploader as two functions, so the matching and the run are tested here
 * without a browser or a server.
 */

import type { Product } from './entities.js';

export const PHOTO_IMPORT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

export type PhotoPlanStatus =
  /** Matched to a sub product with no photo yet. */
  | 'new'
  /** Matched to a sub product that already has a photo: skipped or replaced, as chosen. */
  | 'hasPhoto'
  /** An image whose name is no code or alias in the catalogue. */
  | 'unmatched'
  /** The same name as an earlier file (another extension, or another folder). */
  | 'duplicate'
  /** Not a jpg, jpeg, png or webp file. */
  | 'notImage';

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
  /** The sub product's photos when the plan was made: what "replace" removes. */
  existingImageIds?: string[];
}

/** `OPT-0011_2.JPG` -> `{ code: 'opt-0011', full: 'opt-0011_2' }`; null when not an image name. */
export function photoFileKey(fileName: string): { code: string; full: string } | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (!(PHOTO_IMPORT_EXTENSIONS as readonly string[]).includes(extension)) return null;
  const full = fileName.slice(0, dot).trim().toLowerCase();
  if (!full) return null;
  return { code: full.replace(/_\d+$/, ''), full };
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

/**
 * The preview: one row per file, in file-name order. The first of two files
 * with the same name (ignoring case and extension) is the one imported.
 */
export function planPhotoImport<F extends { name: string }>(
  files: readonly F[],
  products: readonly Product[],
): PhotoPlanRow<F>[] {
  const targets = targetsByName(products);
  const seen = new Set<string>();
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  return sorted.map((file): PhotoPlanRow<F> => {
    const base = { file, fileName: file.name };
    const key = photoFileKey(file.name);
    if (!key) return { ...base, status: 'notImage' };
    if (seen.has(key.full)) return { ...base, status: 'duplicate' };
    seen.add(key.full);

    const target = targets.get(key.code);
    if (!target) return { ...base, status: 'unmatched' };
    const existing = target.product.images.map((image) => image.id);
    return {
      ...base,
      status: existing.length > 0 ? 'hasPhoto' : 'new',
      matchedAs: target.matchedAs,
      productId: target.product.id,
      productName: target.product.name,
      caption: target.caption,
      existingImageIds: existing,
    };
  });
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
  upload: (productId: string, file: F, caption: string | null) => Promise<unknown>;
  removeImage: (productId: string, imageId: string) => Promise<unknown>;
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

async function withRetry<T>(work: () => Promise<T>, deps: PhotoImportDeps<unknown>): Promise<T> {
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
 * sub product that already has a photo is left alone, so a second run adds
 * only what the first did not.
 *
 * "Replace" uploads the new photos first and removes the old ones only once
 * every new one is in, so a failed upload never leaves a sub product with no
 * photo where it had one.
 */
export async function runPhotoImport<F>(
  plan: readonly PhotoPlanRow<F>[],
  mode: PhotoImportMode,
  deps: PhotoImportDeps<F>,
): Promise<PhotoImportOutcome<F>[]> {
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
    let allIn = true;
    for (const row of rows) {
      if (deps.stopped?.()) {
        outcomes.push({ row, result: 'skipped' });
        allIn = false;
        continue;
      }
      try {
        await withRetry(() => deps.upload(productId, row.file, row.caption ?? null), deps as PhotoImportDeps<unknown>);
        outcomes.push({ row, result: 'imported' });
      } catch (error) {
        outcomes.push({ row, result: 'failed', error: deps.errorText(error) });
        allIn = false;
      }
      done += 1;
      deps.onProgress?.(done, total);
    }

    const old = rows[0]?.existingImageIds ?? [];
    if (mode === 'replace' && allIn && old.length > 0) {
      for (const imageId of old) {
        try {
          await withRetry(() => deps.removeImage(productId, imageId), deps as PhotoImportDeps<unknown>);
        } catch (error) {
          // The new photos are in; an old one left over is shown, not hidden.
          const first = outcomes.find((outcome) => outcome.row === rows[0]);
          if (first) first.error = deps.errorText(error);
        }
      }
    }
  }

  const order = new Map(plan.map((row, index) => [row, index]));
  return outcomes.sort((a, b) => (order.get(a.row) ?? 0) - (order.get(b.row) ?? 0));
}
