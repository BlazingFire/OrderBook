/**
 * The one answer the shell derives three behaviours from: is this the
 * standalone `.exe`, and where does the person keep it?
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectStandaloneBuild, loginItemOptions } from '../lib/standalone.js';

const EXE = path.resolve('/Users/shop/Desktop/OrderBook-Master-1.2.0-Standalone.exe');

describe('detecting the standalone build', () => {
  it('recognises the variables the portable launcher sets', () => {
    const found = detectStandaloneBuild(
      { PORTABLE_EXECUTABLE_FILE: EXE, PORTABLE_EXECUTABLE_DIR: path.dirname(EXE) },
      true,
    );
    expect(found).toEqual({ executable: EXE, directory: path.dirname(EXE) });
  });

  it('derives the folder when the launcher gave only the file', () => {
    expect(detectStandaloneBuild({ PORTABLE_EXECUTABLE_FILE: EXE }, true)?.directory).toBe(
      path.dirname(EXE),
    );
  });

  it('is never a standalone build when run from source', () => {
    // The variables are inherited from whatever terminal started the panel;
    // a developer's leftover must not turn `npm run dev` into a portable copy.
    expect(detectStandaloneBuild({ PORTABLE_EXECUTABLE_FILE: EXE }, false)).toBeNull();
  });

  it('treats an installed build as installed', () => {
    expect(detectStandaloneBuild({}, true)).toBeNull();
    expect(detectStandaloneBuild({ PORTABLE_EXECUTABLE_FILE: '' }, true)).toBeNull();
    expect(detectStandaloneBuild({ PORTABLE_EXECUTABLE_FILE: '   ' }, true)).toBeNull();
  });
});

describe('the login item a standalone build registers', () => {
  it('names the file the person keeps, never the unpacked copy', () => {
    expect(loginItemOptions({ executable: EXE, directory: path.dirname(EXE) })).toEqual({
      path: EXE,
    });
  });

  it('adds nothing for an installed build, so Electron uses its own path', () => {
    expect(loginItemOptions(null)).toEqual({});
  });
});
