/**
 * The shell's one genuinely dangerous power: launching an executable.
 *
 * The previous check was `typeof filePath === 'string' && endsWith('.exe')`,
 * which accepts any path on the machine — so a compromised renderer could ask
 * the shell to run anything already on disk. These vectors are the reason the
 * check moved out of the main process and into a pure function.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { installerExtension, resolveInstaller } from '../lib/installer.js';

const UPDATES = path.resolve('/data/OrderBook/office/updates');

describe('resolving an installer path', () => {
  it('accepts a setup file inside the panel updates folder', () => {
    const candidate = path.join(UPDATES, 'OrderBook-Office-1.0.3-Setup.exe');
    expect(resolveInstaller(candidate, UPDATES, 'win32')).toBe(path.resolve(candidate));
  });

  it('refuses a path outside the folder', () => {
    expect(resolveInstaller(path.resolve('/windows/system32/cmd.exe'), UPDATES, 'win32')).toBeNull();
  });

  it('refuses traversal back out of the folder', () => {
    const escape = path.join(UPDATES, '..', '..', 'evil.exe');
    expect(resolveInstaller(escape, UPDATES, 'win32')).toBeNull();
  });

  it('refuses a sibling folder that merely shares a prefix', () => {
    // `startsWith` containment would accept this; `path.relative` does not.
    expect(resolveInstaller(`${UPDATES}-evil/setup.exe`, UPDATES, 'win32')).toBeNull();
  });

  it('refuses anything that is not this platform’s installer', () => {
    for (const name of ['run.bat', 'run.ps1', 'run.cmd', 'setup', 'setup.dmg']) {
      expect(resolveInstaller(path.join(UPDATES, name), UPDATES, 'win32')).toBeNull();
    }
  });

  it('refuses when we never learned the allowed folder', () => {
    // A panel too old to report `installerDir` must not fall back to trusting
    // the renderer — refusing is recoverable, running an arbitrary path is not.
    expect(resolveInstaller(path.join(UPDATES, 'setup.exe'), null, 'win32')).toBeNull();
  });

  it('refuses a non-string, including the shapes a hostile caller would try', () => {
    for (const value of [undefined, null, 42, {}, ['a.exe']]) {
      expect(resolveInstaller(value, UPDATES, 'win32')).toBeNull();
    }
  });

  it('takes a .dmg on macOS and refuses a .exe there', () => {
    expect(installerExtension('darwin')).toBe('.dmg');
    expect(resolveInstaller(path.join(UPDATES, 'OrderBook.dmg'), UPDATES, 'darwin')).not.toBeNull();
    expect(resolveInstaller(path.join(UPDATES, 'OrderBook.exe'), UPDATES, 'darwin')).toBeNull();
  });
});
