/**
 * Switch off the two Electron fuses that let an environment variable or a command
 * line steer the packaged program (1.4 R8 hardening), as an electron-builder
 * `afterPack` hook for every Windows build.
 *
 * **Why.** The Master's nightly update task runs the shipped `.exe` as plain
 * Node (`ELECTRON_RUN_AS_NODE`, which the product itself relies on to start its
 * server, so that fuse stays ON). The task runs with administrator rights as an
 * account whose environment its other programs can change. With these two fuses
 * on, `NODE_OPTIONS=--require evil.js` in that environment, or `--inspect` on a
 * command line, would run attacker code elevated. With them off, Node ignores
 * both, however the program is started.
 *
 *  - `EnableNodeOptionsEnvironmentVariable` (index 2): off
 *  - `EnableNodeCliInspectArguments`        (index 3): off
 *
 * No dependency: a fuse is a byte after a fixed sentinel inside the exe
 * (https://www.electronjs.org/docs/latest/tutorial/fuses), which is all
 * `@electron/fuses` edits. The same wire format is in Electron 22 (the Windows 7
 * build), where indexes 0 to 3 exist.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const DISABLED = 0x30;
const ENABLED = 0x31;

/** The fuses this product switches off, by index in the V1 wire. */
const SWITCH_OFF = { 2: 'EnableNodeOptionsEnvironmentVariable', 3: 'EnableNodeCliInspectArguments' };

/**
 * Flip the listed fuses in an executable's bytes, in place.
 *
 * Throws unless the sentinel is found exactly once with a version-1 wire long
 * enough for every index: a fuse silently left on is the failure to avoid.
 * A fuse that was removed from the binary (`r`) is left alone.
 *
 * @returns the names of the fuses that were on and are now off
 */
function flipFuses(buffer, indexes = SWITCH_OFF) {
  const first = buffer.indexOf(SENTINEL);
  if (first === -1) throw new Error('the Electron fuse sentinel was not found in the executable');
  if (buffer.indexOf(SENTINEL, first + 1) !== -1) throw new Error('the Electron fuse sentinel was found twice');

  const version = buffer[first + SENTINEL.length];
  const length = buffer[first + SENTINEL.length + 1];
  if (version !== 1) throw new Error(`unknown Electron fuse wire version ${version}`);

  const wire = first + SENTINEL.length + 2;
  const turnedOff = [];
  for (const [rawIndex, name] of Object.entries(indexes)) {
    const index = Number(rawIndex);
    if (index >= length) throw new Error(`the fuse wire has ${length} fuses, so ${name} (index ${index}) is not there`);
    if (buffer[wire + index] === ENABLED) {
      buffer[wire + index] = DISABLED;
      turnedOff.push(name);
    }
  }
  return turnedOff;
}

/** The state of the same fuses, for a test or a build log: name to `true` (on) / `false` (off) / `null` (removed). */
function readFuses(buffer, indexes = SWITCH_OFF) {
  const first = buffer.indexOf(SENTINEL);
  if (first === -1) throw new Error('the Electron fuse sentinel was not found in the executable');
  const wire = first + SENTINEL.length + 2;
  const state = {};
  for (const [rawIndex, name] of Object.entries(indexes)) {
    const byte = buffer[wire + Number(rawIndex)];
    state[name] = byte === ENABLED ? true : byte === DISABLED ? false : null;
  }
  return state;
}

/** electron-builder `afterPack`: the Windows executable in the unpacked app folder. */
async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const bytes = fs.readFileSync(exe);
  const turnedOff = flipFuses(bytes);
  fs.writeFileSync(exe, bytes);
  console.log(`  fuses: ${path.basename(exe)} — ${turnedOff.length ? `switched off ${turnedOff.join(', ')}` : 'already off'}`);
}

module.exports = afterPack;
module.exports.flipFuses = flipFuses;
module.exports.readFuses = readFuses;
module.exports.SENTINEL = SENTINEL;
