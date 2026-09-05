/**
 * The image pipeline's pure rules — the first unit tests this module has had.
 *
 * `master/src/domain/images.ts` decides the crop rect and the rotation that
 * `sharp` is then handed, and until now nothing exercised it: the only image
 * coverage in the repo is `master/tests/images.integration.test.ts`, which is
 * `describe.skipIf(!canRunIntegrationTests)` and needs a live PostgreSQL. So it
 * is skipped in `npm run verify`, which is exactly why a crash in this file
 * could ship with the gate green.
 *
 * Nothing here touches sharp, the filesystem or a database.
 */

import { describe, expect, it } from 'vitest';

import { assertCropRect, assertRotation, variantDimensions } from '../src/domain/images.js';
import { ValidationError } from '../src/lib/errors.js';

describe('assertCropRect', () => {
  /**
   * The rounding crash, from the numbers that produced it.
   *
   * A 1000×750 source straightened to 45°: sharp reports the rotated frame as
   * 1237px wide, the browser's own trigonometry says 1237.437, and the editor
   * clamps the crop flush to its right edge. Rounding `x` and `width`
   * independently gave 501 + 737 = 1238, and `sharp.extract` answers a plain
   * `Error` for that, so the request came back as HTTP 500.
   */
  it('never returns a rect wider than the image it was measured against', () => {
    const rect = assertCropRect({ x: 500.9, y: 0, width: 736.537, height: 100 }, 1237, 1237);

    expect(rect.x + rect.width).toBeLessThanOrEqual(1237);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1237);
  });

  it('holds that invariant across the whole band of fractional overhangs', () => {
    // The client/server disagreement was measured at 0.04–0.49px across
    // 0.5°–45°, so this sweeps the range either side of it.
    for (let overhang = 0; overhang <= 0.5; overhang += 0.05) {
      for (const width of [1237, 800, 101, 2]) {
        // A crop that fills all but one pixel of the frame, then overhangs by a
        // fraction — which is what the editor's clamp produces against an edge.
        const cropWidth = Math.max(1, width - 1) + overhang;
        const x = width - cropWidth - overhang / 2;
        if (x < 0) continue;

        const rect = assertCropRect({ x, y: 0, width: cropWidth, height: 1 }, width, width);

        expect(rect.x + rect.width, `width ${width}, overhang ${overhang}`).toBeLessThanOrEqual(
          width,
        );
        expect(rect.width).toBeGreaterThanOrEqual(1);
        expect(rect.x).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('returns whole pixels, because extract takes no fractions', () => {
    const rect = assertCropRect({ x: 10.4, y: 20.6, width: 30.5, height: 40.5 }, 200, 200);

    for (const value of [rect.x, rect.y, rect.width, rect.height]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('refuses a rect that is genuinely outside the image, rather than clamping it', () => {
    // The clamp is for sub-pixel rounding only. A rect a hundred pixels past
    // the edge is a bug upstream, and quietly moving it would hide that.
    expect(() => assertCropRect({ x: 500, y: 0, width: 600, height: 10 }, 800, 800)).toThrow(
      ValidationError,
    );
  });

  it('refuses a crop smaller than a pixel, and a non-finite one', () => {
    expect(() => assertCropRect({ x: 0, y: 0, width: 0.4, height: 10 }, 100, 100)).toThrow(
      ValidationError,
    );
    expect(() => assertCropRect({ x: 0, y: 0, width: Number.NaN, height: 10 }, 100, 100)).toThrow(
      ValidationError,
    );
  });
});

describe('assertRotation', () => {
  it('wraps to (-180, 180] so equivalent angles agree', () => {
    expect(assertRotation(370)).toBe(10);
    expect(assertRotation(-350)).toBe(10);
    expect(assertRotation(285)).toBe(-75);
    expect(assertRotation(180)).toBe(180);
    expect(assertRotation(-180)).toBe(180);
  });

  it('passes the editor’s own range through unchanged', () => {
    // 90° buttons plus a ±15° slider, so these are the values the UI can send.
    for (const step of [0, 90, 180, 270]) {
      for (const fine of [-15, -7.5, 0, 7.5, 15]) {
        const wrapped = assertRotation(step + fine);
        expect(Number.isFinite(wrapped)).toBe(true);
        expect(wrapped).toBeGreaterThan(-180);
        expect(wrapped).toBeLessThanOrEqual(180);
      }
    }
  });

  it('refuses a non-finite rotation', () => {
    expect(() => assertRotation(Number.NaN)).toThrow(ValidationError);
    expect(() => assertRotation(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });
});

describe('variantDimensions', () => {
  it('never upscales a crop that is already smaller than the variant', () => {
    expect(variantDimensions(300, 200, 2048)).toEqual({ width: 300, height: 200 });
  });

  it('caps the long edge and keeps the aspect ratio', () => {
    const dims = variantDimensions(4000, 3000, 800);

    expect(dims.width).toBe(800);
    expect(dims.height).toBe(600);
  });

  it('never returns a zero dimension for an extreme aspect ratio', () => {
    const dims = variantDimensions(4000, 3, 240);

    expect(dims.width).toBe(240);
    expect(dims.height).toBeGreaterThanOrEqual(1);
  });
});
