/**
 * The shell's one genuinely dangerous power: launching an executable.
 *
 * The previous check was `typeof filePath === 'string' && endsWith('.exe')`,
 * which accepts any path on the machine — so a compromised renderer could ask
 * the shell to run anything already on disk. These vectors are the reason the
 * check moved out of the main process and into a pure function.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approveInstaller,
  digestOf,
  installerExtension,
  resolveInstaller,
} from '../lib/installer.js';

const UPDATES = path.resolve('/data/OrderBook/office/updates');

describe('resolving an installer path', () => {
  it('accepts a setup file inside the panel updates folder', () => {
    const candidate = path.join(UPDATES, 'OrderBook-Office-1.0.3-Setup.exe');
    expect(resolveInstaller(candidate, UPDATES, 'win32')).toBe(path.resolve(candidate));
  });

  it('refuses a path outside the folder', () => {
    expect(
      resolveInstaller(path.resolve('/windows/system32/cmd.exe'), UPDATES, 'win32'),
    ).toBeNull();
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

/**
 * Containment says *where* a file is. It cannot say *what* it is — and the
 * folder it guards is on disk, writable by whoever can write it. So the shell
 * hashes the bytes itself, in the process that is about to run them, with
 * nothing happening in between.
 */
describe('approving an installer before it is launched', () => {
  let dir: string;
  let staging: string;
  let good: string;
  let digest: string;

  /** Where the approved copy lands. Per-user in the shell; a temp dir here. */
  const stagedName = 'OrderBook-Office-1.0.3-Setup.exe';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orderbook-installer-'));
    staging = await mkdtemp(path.join(os.tmpdir(), 'orderbook-staging-'));
    good = path.join(dir, 'OrderBook-Office-1.0.3-Setup.exe');

    const bytes = Buffer.from('pretend this is a hundred megabytes of installer');
    await writeFile(good, bytes);
    digest = createHash('sha256').update(bytes).digest('hex');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  });

  it('accepts a contained file, and runs the staged copy rather than the original', async () => {
    // The path returned is deliberately not the one passed in. The releases
    // folder stays writable by whoever is logged in, so the bytes that were
    // hashed there could be swapped before they are spawned; the copy in the
    // per-user staging folder cannot.
    expect(await approveInstaller(good, digest, dir, 'win32', staging)).toEqual({
      path: path.join(staging, stagedName),
    });

    expect(await digestOf(path.join(staging, stagedName))).toBe(digest);
  });

  it('accepts the digest whatever case it is written in', async () => {
    expect(await approveInstaller(good, digest.toUpperCase(), dir, 'win32', staging)).toEqual({
      path: path.join(staging, stagedName),
    });
  });

  it('clears a staged copy left by a different version', async () => {
    // The case the old cleanup could not see. It removed only the exact
    // basename it was about to write, and setup filenames carry their version —
    // so a refused or successful install stranded its own 150 MB copy the
    // moment the next release had a different number. Nothing else ever
    // removed one: the app quits at the point of a successful install.
    const stranded = path.join(staging, 'OrderBook-Office-0.9.0-Setup.exe');
    await writeFile(stranded, Buffer.from('last month s installer'));

    await approveInstaller(good, digest, dir, 'win32', staging);

    expect(await readdir(staging)).toEqual([stagedName]);
  });

  it('leaves nothing staged when the bytes do not match', async () => {
    // A refused installer that stayed on disk would be a file the next attempt
    // could find already there.
    const wrong = path.join(dir, 'OrderBook-Office-2.0.0-Setup.exe');
    await writeFile(wrong, Buffer.from('not what the manifest describes'));

    const verdict = await approveInstaller(wrong, digest, dir, 'win32', staging);

    expect('refused' in verdict).toBe(true);
    await expect(stat(path.join(staging, 'OrderBook-Office-2.0.0-Setup.exe'))).rejects.toThrow();
  });

  it('refuses bytes that changed after the panel checked them', async () => {
    // The whole point. The panel hashed this file when it downloaded it; the
    // file has been sitting in a writable folder since, and something swapped
    // it. Size is not consulted, so padding to match buys nothing.
    const swapped = path.join(dir, 'OrderBook-Office-1.0.4-Setup.exe');
    await writeFile(swapped, Buffer.from('pretend this is somebody else s installer........'));

    const verdict = await approveInstaller(swapped, digest, dir, 'win32', staging);
    expect('refused' in verdict && verdict.refused).toMatch(/hashes to/);
  });

  it('refuses when no digest was supplied at all', async () => {
    // An older panel that does not report one must not be the reason an
    // unverified installer runs. Absent is a refusal, never a pass.
    for (const missing of [undefined, null, '', 'not-a-digest']) {
      const verdict = await approveInstaller(good, missing, dir, 'win32', staging);
      expect('refused' in verdict, String(missing)).toBe(true);
    }
  });

  it('still refuses anything outside the folder, digest or not', async () => {
    const outside = path.resolve('/windows/system32/cmd.exe');
    const verdict = await approveInstaller(outside, digest, dir, 'win32', staging);
    expect('refused' in verdict && verdict.refused).toMatch(/outside/);
  });

  it('refuses a file that is not there', async () => {
    const missing = path.join(dir, 'OrderBook-Office-9.9.9-Setup.exe');
    const verdict = await approveInstaller(missing, digest, dir, 'win32', staging);
    expect('refused' in verdict && verdict.refused).toMatch(/could not be read/);
  });

  it('hashes a file the same way the panel does', async () => {
    expect(await digestOf(good)).toBe(digest);
  });
});
