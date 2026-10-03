/**
 * Write the SHA-256 of the PowerShell scripts an installer runs elevated into an
 * NSIS include (1.4 R8), at the one moment that cannot be skipped: when `makensis`
 * compiles the installer. The installer headers run it with `!system`, so it runs
 * for a normal build, for `electron-builder --prepackaged` (which skips
 * `afterPack`), and for a rebuilt installer alike, and a failure stops the compile.
 * A hash written any earlier could be stale, and a stale hash silently makes the
 * installer refuse its own script.
 *
 *   node tools/bake-script-hashes.cjs <installer folder>
 *
 * Writes `<installer folder>/script-hashes.nsh` (gitignored):
 *  - `UNINSTALL_SCRIPT_SHA256`: `tools/uninstall/uninstall-orderbook.ps1`, always;
 *  - `UPDATE_DIRS_SHA256`: `apply-update/update-dirs.ps1`, only where the folder
 *    has one (the Master's).
 *
 * The hash is of the exact bytes the installer embeds with `File`.
 */

'use strict';

const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256 = (file) => nodeCrypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The include's text for an installer folder, or throws if a script that must exist is missing. */
function bakeScriptHashes(installerDir) {
  const uninstall = path.join(installerDir, '..', '..', 'tools', 'uninstall', 'uninstall-orderbook.ps1');
  if (!fs.existsSync(uninstall)) throw new Error(`the uninstall script is missing: ${uninstall}`);
  const lines = [
    '; Written by tools/bake-script-hashes.cjs when the installer is compiled. Do not edit, do not commit.',
    `!define UNINSTALL_SCRIPT_SHA256 "${sha256(uninstall)}"`,
  ];
  const updateDirs = path.join(installerDir, 'apply-update', 'update-dirs.ps1');
  if (fs.existsSync(updateDirs)) lines.push(`!define UPDATE_DIRS_SHA256 "${sha256(updateDirs)}"`);
  const target = path.join(installerDir, 'script-hashes.nsh');
  fs.writeFileSync(target, `${lines.join('\r\n')}\r\n`);
  return { target, lines };
}

module.exports = { bakeScriptHashes };

if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: node tools/bake-script-hashes.cjs <installer folder>');
    process.exit(2);
  }
  try {
    const { target } = bakeScriptHashes(path.resolve(folder));
    console.log(`baked ${path.basename(target)}`);
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
}
