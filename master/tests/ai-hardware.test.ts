/**
 * What the machine can run, at the boundaries.
 *
 * The numbers are not arbitrary. A 7B model quantised to Q4_K_M is about
 * 4.7 GB of weights before any context at all, so 8 GB is where a local model
 * stops swapping and 16 GB is where it stops being the only thing the machine
 * can do. Somebody who is told this before they wait four minutes for a first
 * token is somebody who does not conclude the app is broken.
 */

import { describe, expect, it } from 'vitest';

import { tierFor } from '../src/ai/hardware.js';

describe('the hardware tier', () => {
  it('refuses to recommend a local model below eight gigabytes', () => {
    expect(tierFor(4)).toBe('unsupported');
    expect(tierFor(7.9)).toBe('unsupported');
  });

  it('allows it, with a warning, between eight and sixteen', () => {
    expect(tierFor(8)).toBe('marginal');
    expect(tierFor(12)).toBe('marginal');
  });

  it('is content from sixteen upwards', () => {
    expect(tierFor(16)).toBe('supported');
    expect(tierFor(32)).toBe('supported');
  });

  it('reads an Apple Silicon machine from the same number', () => {
    // Unified memory is the same pool for the GPU, so `os.totalmem()` is
    // already the honest figure and needs no per-platform branch.
    expect(tierFor(18)).toBe('supported');
  });
});
