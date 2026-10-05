/** A NaN or fractional limit/offset (a socket payload skips the HTTP parse) must not reach `LIMIT`. */

import { describe, expect, it } from 'vitest';

import { clampPaging } from '../src/domain/paging.js';

const LIMITS = { defaultLimit: 50, maxLimit: 200 };

describe('clampPaging', () => {
  it('treats NaN and Infinity as not asked', () => {
    expect(clampPaging({ limit: Number.NaN, offset: Number.NaN }, LIMITS)).toEqual({ limit: 50, offset: 0 });
    expect(clampPaging({ limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }, LIMITS)).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  it('floors a fractional limit and clamps the rest', () => {
    expect(clampPaging({ limit: 2.9, offset: -3 }, LIMITS)).toEqual({ limit: 2, offset: 0 });
    expect(clampPaging({ limit: 1e9 }, LIMITS).limit).toBe(200);
  });
});
