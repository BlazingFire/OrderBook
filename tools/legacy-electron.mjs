/**
 * The Electron the Windows 7 Office build ships on (docs/WINDOWS7.md).
 *
 * 22.3.27 is the last 22.x, and 22 is the last Electron that runs on Windows 7,
 * 8 and 8.1 (Chromium 108, Node 16.17.1). `LEGACY_ELECTRON_CEILING` in
 * shared/src/domain/version.ts is the first major that does not, and the
 * running Office uses it to pick its update channel.
 *
 * Pinned here once. `tools/release.mjs` hands it to electron-builder as
 * `electronVersion` for `--os win7`, and `tools/legacy-smoke.mjs` downloads the
 * same binary to run against. It is not installed through npm: the `electron`
 * package's bin is called `electron` whatever the alias, and a second copy
 * would put the 22 binary behind `npx electron` and add a 100 MB download to
 * every `npm ci`.
 */
export const LEGACY_ELECTRON = '22.3.27';

/** The Node inside that Electron, which the smoke runs the Office server on. */
export const LEGACY_NODE = '16.17.1';
