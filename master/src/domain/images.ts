/**
 * Pure rules for the image pipeline (`7-IMAGE-PIPELINE.md` §2, §3) — no I/O,
 * no `sharp`, importable by any layer. The actual decode/resize/encode work
 * happens once, in `services/image.service.ts`, against the numbers this file
 * computes.
 */

import {
  IMAGE_VARIANT_LONG_EDGES,
  MAX_IMAGE_SOURCE_BYTES,
  type ImageVariant,
} from '@orderbook/shared';

import { ValidationError } from '../lib/errors.js';

export interface ImageVariantSpec {
  name: ImageVariant;
  longEdge: number;
  quality: number;
}

/**
 * §2.2 — generated once at import, in this fetch order (cheapest/most-needed
 * first). Names match `IMAGE_VARIANTS` in `shared/src/domain/entities.ts`
 * (which office/web consults without needing this file's size/quality specs).
 */
export const IMAGE_VARIANT_SPECS: readonly ImageVariantSpec[] = (
  [
    ['thumb', 78],
    ['micro', 60],
    ['large', 82],
    ['master', 90],
  ] as const
).map(([name, quality]) => ({ name, longEdge: IMAGE_VARIANT_LONG_EDGES[name], quality }));

export const MAX_SOURCE_BYTES = MAX_IMAGE_SOURCE_BYTES;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Long-edge-capped, aspect-ratio-preserved target size — never upscales a crop smaller than the variant's long edge. */
export function variantDimensions(
  sourceWidth: number,
  sourceHeight: number,
  longEdge: number,
): { width: number; height: number } {
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= longEdge) return { width: sourceWidth, height: sourceHeight };

  const scale = longEdge / longest;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/**
 * Validates a crop rect against the (already-rotated) source dimensions. The
 * editor sends pixel coordinates in that rotated space — see
 * `ImageCropInput` in `shared/src/domain/inputs.ts`.
 *
 * **The rounding is clamped, not blind.** The bounds check tolerates half a
 * pixel of overhang, because the browser computes the rotated frame with
 * trigonometry while sharp rounds it to whole pixels — for any angle that is
 * not a multiple of 90° the two disagree by a fraction. Rounding `x` and
 * `width` independently could then push their sum back over the edge: a
 * 1000×750 source at 45° gives sharp 1237 and the browser 1237.437, so
 * `x = 500.9` and `width = 736.537` pass the ≤ 1237.5 check and round to
 * 501 + 737 = 1238. `sharp.extract` rejects that with a plain
 * `extract_area: bad extract area`, which is not a `ValidationError`, so the
 * shop saw **HTTP 500 "Something went wrong"** — after the upload, and leaving
 * an empty variant directory behind.
 *
 * Reachable by using the Straighten slider and dragging the crop flush against
 * an edge, which is what the editor's own clamp does.
 */
export function assertCropRect(rect: CropRect, rotatedWidth: number, rotatedHeight: number): CropRect {
  const { x, y, width, height } = rect;

  if (![x, y, width, height].every((n) => Number.isFinite(n))) {
    throw new ValidationError('validation.image.crop.invalid');
  }
  if (width < 1 || height < 1) {
    throw new ValidationError('validation.image.crop.tooSmall');
  }
  if (x < 0 || y < 0 || x + width > rotatedWidth + 0.5 || y + height > rotatedHeight + 0.5) {
    throw new ValidationError('validation.image.crop.outOfBounds');
  }

  // The origin first, so there is always at least one pixel left to take.
  const left = Math.min(Math.round(x), Math.max(0, rotatedWidth - 1));
  const top = Math.min(Math.round(y), Math.max(0, rotatedHeight - 1));

  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(Math.round(width), rotatedWidth - left)),
    height: Math.max(1, Math.min(Math.round(height), rotatedHeight - top)),
  };
}

/** Rotation is normalized to one of the four 90° quadrants plus a bounded fine adjustment (§3.2 — "90° buttons plus a ±15° slider"). */
export function assertRotation(rotationDeg: number): number {
  if (!Number.isFinite(rotationDeg)) throw new ValidationError('validation.image.rotation.invalid');
  // Wrap to (-180, 180] so e.g. 370° and -350° both mean "10°".
  let deg = rotationDeg % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  return deg;
}
