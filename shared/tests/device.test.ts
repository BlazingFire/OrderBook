/** When a PC's memory or processor count deserves a warning on the sign-in screen. */

import { describe, expect, it } from 'vitest';

import {
  FEW_CORES_MAX,
  LOW_MEMORY_BYTES,
  deviceWarnings,
  formatGigabytes,
  isDeviceInfo,
} from '../src/index.js';

const GB = 1024 ** 3;
const device = (gb: number, cpuCount: number) => ({ totalMemoryBytes: gb * GB, cpuCount });

describe('deviceWarnings', () => {
  it('warns about memory below 7.5 GB and only below it', () => {
    expect(LOW_MEMORY_BYTES).toBe(7.5 * GB);
    expect(deviceWarnings(device(4, 8)).lowMemory).toBe(true);
    expect(deviceWarnings(device(7.49, 8)).lowMemory).toBe(true);
    expect(deviceWarnings(device(7.5, 8)).lowMemory).toBe(false);
    // An "8 GB" PC reports a little under 8 and must not be warned about.
    expect(deviceWarnings(device(7.9, 8)).lowMemory).toBe(false);
    expect(deviceWarnings(device(16, 8)).lowMemory).toBe(false);
  });

  it('warns about two logical cores or fewer, and not about three', () => {
    expect(FEW_CORES_MAX).toBe(2);
    expect(deviceWarnings(device(16, 1)).fewCores).toBe(true);
    expect(deviceWarnings(device(16, 2)).fewCores).toBe(true);
    expect(deviceWarnings(device(16, 3)).fewCores).toBe(false);
  });

  it('can warn about both at once', () => {
    expect(deviceWarnings(device(4, 2))).toEqual({ lowMemory: true, fewCores: true });
  });

  it('says nothing when the figures are unknown or nonsense', () => {
    const none = { lowMemory: false, fewCores: false };
    expect(deviceWarnings(null)).toEqual(none);
    expect(deviceWarnings(undefined)).toEqual(none);
    expect(deviceWarnings({ totalMemoryBytes: 0, cpuCount: 0 })).toEqual(none);
    expect(deviceWarnings({ totalMemoryBytes: NaN, cpuCount: 'x' } as never)).toEqual(none);
  });
});

describe('isDeviceInfo and formatGigabytes', () => {
  it('accepts only the two numbers', () => {
    expect(isDeviceInfo(device(8, 4))).toBe(true);
    expect(isDeviceInfo({ totalMemoryBytes: 1 })).toBe(false);
    expect(isDeviceInfo(null)).toBe(false);
  });

  it('reads memory out in gigabytes of 1024³ bytes to one decimal', () => {
    expect(formatGigabytes(4 * GB)).toBe('4.0');
    expect(formatGigabytes(7.46 * GB)).toBe('7.5');
  });
});
