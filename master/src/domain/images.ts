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

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
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
