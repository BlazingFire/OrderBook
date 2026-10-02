/**
 * The server heap the shell asks for (`lib/memory.ts`), at the RAM sizes the
 * shop PCs actually have.
 */

import { describe, expect, it } from 'vitest';

import { rendererHeapFlag, serverHeapMb } from '../lib/memory.js';

const GB = 1024;

describe('serverHeapMb', () => {
  it('keeps the Master at 2048 MB or more on every PC', () => {
    expect(serverHeapMb(3 * GB, 'master', 'x64')).toBe(2048);
    expect(serverHeapMb(4 * GB, 'master', 'x64')).toBe(2048);
    expect(serverHeapMb(8 * GB, 'master', 'x64')).toBe(3441);
    expect(serverHeapMb(64 * GB, 'master', 'x64')).toBe(4096);
  });

  it('lets the Office drop to 1024 MB on a PC with 4.5 GB or less', () => {
    expect(serverHeapMb(3 * GB, 'office', 'x64')).toBe(1024);
    expect(serverHeapMb(4 * GB, 'office', 'x64')).toBe(1147);
    expect(serverHeapMb(4608, 'office', 'x64')).toBe(1290);
    // Just above the line the floor is back to 2048.
    expect(serverHeapMb(4609, 'office', 'x64')).toBe(2048);
    expect(serverHeapMb(8 * GB, 'office', 'x64')).toBe(2294);
    expect(serverHeapMb(64 * GB, 'office', 'x64')).toBe(4096);
  });

  it('never gives a 32-bit process more than 1024 MB', () => {
    for (const totalMb of [2 * GB, 3 * GB, 4 * GB, 8 * GB, 64 * GB]) {
      expect(serverHeapMb(totalMb, 'office', 'ia32')).toBe(1024);
      expect(serverHeapMb(totalMb, 'master', 'ia32')).toBe(1024);
    }
  });
});

describe('rendererHeapFlag', () => {
  it('caps the window at 1024 MB on a PC with 4.5 GB or less, and only there', () => {
    expect(rendererHeapFlag(3 * GB)).toBe('--max-old-space-size=1024');
    expect(rendererHeapFlag(4608)).toBe('--max-old-space-size=1024');
    expect(rendererHeapFlag(4609)).toBeNull();
    expect(rendererHeapFlag(8 * GB)).toBeNull();
  });
});
