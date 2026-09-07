/**
 * The command line the shell hands the OS to uninstall a panel.
 *
 * The flags here are a contract with `tools/uninstall/`: PowerShell rejects a
 * parameter it does not know, but a flag that silently stopped being passed
 * would fall back to the script's default — and the default for data is to
 * erase it. So the exact shape, and where `keepData` lands in it, is pinned.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { uninstallCommand, uninstallScriptsDir } from '../lib/uninstall.js';

const SCRIPTS = path.resolve('/Program Files/OrderBook Master Panel/resources/uninstall');

describe('the Windows uninstall command', () => {
  it('runs the PowerShell script with the panel, no prompts, and keeps data on request', () => {
    const command = uninstallCommand({
      platform: 'win32',
      panel: 'master',
      keepData: true,
      scriptsDir: SCRIPTS,
    });

    expect(command).toEqual({
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(SCRIPTS, 'uninstall-orderbook.ps1'),
        '-Panel',
        'master',
        '-Yes',
        '-KeepData',
      ],
    });
  });

  it('omits -KeepData when the person asked for the data to go too', () => {
    const command = uninstallCommand({
      platform: 'win32',
      panel: 'office',
      keepData: false,
      scriptsDir: SCRIPTS,
    });

    expect(command?.args).not.toContain('-KeepData');
    expect(command?.args.slice(-3)).toEqual(['-Panel', 'office', '-Yes']);
  });
});

describe('the macOS uninstall command', () => {
  it('runs the bash script inside Terminal so the sudo prompt has somewhere to appear', () => {
    const command = uninstallCommand({
      platform: 'darwin',
      panel: 'office',
      keepData: false,
      scriptsDir: '/Applications/OrderBook Office Panel.app/Contents/Resources/uninstall',
    });

    expect(command).toEqual({
      file: 'osascript',
      args: [
        '-e',
        `tell application "Terminal" to do script "bash '/Applications/OrderBook Office Panel.app/Contents/Resources/uninstall/uninstall-orderbook.sh' --panel office --yes"`,
      ],
    });
  });

  it('appends --keep-data after --yes', () => {
    const command = uninstallCommand({
      platform: 'darwin',
      panel: 'master',
      keepData: true,
      scriptsDir: '/tmp/u',
    });

    expect(command?.args[1]).toMatch(/--panel master --yes --keep-data"$/);
  });

  it('survives an apostrophe in the path, through both the shell and AppleScript', () => {
    // Shell-quoting closes the single-quoted string, escapes the quote and
    // reopens it (`'\''`), and that backslash then has to survive AppleScript's
    // own string literal — hence the doubled backslash the test expects.
    const command = uninstallCommand({
      platform: 'darwin',
      panel: 'master',
      keepData: true,
      scriptsDir: "/Users/pat/O'Brien's Apps",
    });

    expect(command?.args[1]).toBe(
      `tell application "Terminal" to do script "bash '/Users/pat/O'\\\\''Brien'\\\\''s Apps/uninstall-orderbook.sh' --panel master --yes --keep-data"`,
    );
  });
});

describe('platforms we ship no uninstaller for', () => {
  it('returns null rather than guessing at a command', () => {
    for (const platform of ['linux', 'freebsd', 'sunos'] as const) {
      expect(
        uninstallCommand({ platform, panel: 'master', keepData: true, scriptsDir: SCRIPTS }),
      ).toBeNull();
    }
  });
});

describe('where the scripts are', () => {
  it('is beside the panel in a packaged build', () => {
    expect(uninstallScriptsDir(true, '/app/resources', '/ignored')).toBe(
      path.join('/app/resources', 'uninstall'),
    );
  });

  it('is the repository tools folder when run from source', () => {
    // `here` is `<panel>/electron/dist`; `tools/` is a sibling of the panel.
    const here = path.resolve('/repo/master/electron/dist');
    expect(uninstallScriptsDir(false, '/unused', here)).toBe(path.resolve('/repo/tools/uninstall'));
  });
});

/*
 * The seams the pure functions above cannot see.
 *
 * Everything above is a string compared against a string. These are compared
 * against the repository, because they only break on a machine somebody is
 * uninstalling — the worst place to learn that a file moved. `shell.ts` names
 * `uninstall-orderbook.ps1` a second time, to check it is there before the
 * point of no return, and both `installer.nsh` files read it out of the
 * `resources/uninstall` folder, which is `extraResources` `to:` and nothing else.
 */
describe('the scripts the command lines point at', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const toolsDir = path.join(repo, 'tools', 'uninstall');

  it('really ship under tools/uninstall, under the names the commands use', () => {
    const windows = uninstallCommand({
      platform: 'win32',
      panel: 'master',
      keepData: false,
      scriptsDir: toolsDir,
    });

    // `-File <path>` — the same path `shell.ts` checks with `existsSync`.
    const script = windows?.args[windows.args.indexOf('-File') + 1] ?? '';
    expect(existsSync(script)).toBe(true);
    expect(existsSync(path.join(toolsDir, 'uninstall-orderbook.sh'))).toBe(true);
  });

  it.each(['master', 'office'])('are where the %s uninstaller looks for them', (panel) => {
    const builder = readFileSync(path.join(repo, panel, 'electron-builder.yml'), 'utf8');
    const nsh = readFileSync(path.join(repo, panel, 'installer', 'installer.nsh'), 'utf8');

    // The pair, in one match: `toContain('to: uninstall')` also passes on
    // `to: uninstallX`, and on the `to: panel` entry's neighbour.
    expect(builder).toMatch(/- from: \.\.\/tools\/uninstall\r?\n\s+to: uninstall\r?\n/);
    expect(nsh).toContain(String.raw`$INSTDIR\resources\uninstall\uninstall-orderbook.ps1`);
    // Packaged, the shell resolves that same folder for its own spawn.
    expect(uninstallScriptsDir(true, String.raw`C:\Panel\resources`, '')).toBe(
      path.join(String.raw`C:\Panel\resources`, 'uninstall'),
    );
  });
});
