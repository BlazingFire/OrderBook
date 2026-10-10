/**
 * The app scale a fresh install starts at (owner, 2026-10-07): 150 % on a 4K
 * screen at 100-125 % Windows scaling, 100 % everywhere else, and a scale the
 * operator saved always wins.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { SCALE_DEFAULT, loadScale, screenDefaultScale } from '../src/theme.js';

describe('screenDefaultScale', () => {
  it('starts 4K at 100 % and 125 % Windows scaling at 150 %', () => {
    expect(screenDefaultScale(3840, 1)).toBe(SCALE_DEFAULT * 1.5);
    expect(screenDefaultScale(3072, 1.25)).toBe(SCALE_DEFAULT * 1.5);
  });

  it('leaves 1080p, 1440p and a 4K screen already scaled 150 % or more alone', () => {
    expect(screenDefaultScale(1920, 1)).toBe(SCALE_DEFAULT);
    expect(screenDefaultScale(1536, 1.25)).toBe(SCALE_DEFAULT);
    expect(screenDefaultScale(2560, 1)).toBe(SCALE_DEFAULT);
    expect(screenDefaultScale(2560, 1.5)).toBe(SCALE_DEFAULT);
    expect(screenDefaultScale(1920, 2)).toBe(SCALE_DEFAULT);
  });
});

describe('loadScale', () => {
  afterEach(() => window.localStorage.removeItem('ob.scale'));

  it('prefers a saved scale over the screen default', () => {
    window.localStorage.setItem('ob.scale', '15');
    expect(loadScale()).toBe(15);
  });

  it('falls back to the screen default when nothing is saved', () => {
    window.localStorage.removeItem('ob.scale');
    expect(loadScale()).toBe(
      screenDefaultScale(window.screen.width, window.devicePixelRatio || 1, window.innerWidth),
    );
  });

  it('starts a small laptop window tighter than a desktop one', () => {
    expect(screenDefaultScale(1920, 1, 1024)).toBe(12);
    expect(screenDefaultScale(1920, 1, 1366)).toBe(13);
    expect(screenDefaultScale(1920, 1, 1920)).toBe(SCALE_DEFAULT);
  });
});
