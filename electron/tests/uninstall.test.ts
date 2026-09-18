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

describe('Linux', () => {
  it('runs the same script directly, with no terminal in the middle', () => {
    // macOS goes through Terminal so the script's `sudo` has somewhere to ask.
    // A Linux install is per-user, so there is normally nothing to elevate
    // for, and picking a terminal emulator for an arbitrary desktop is a guess
    // with no good default.
    expect(
      uninstallCommand({ platform: 'linux', panel: 'office', keepData: false, scriptsDir: SCRIPTS }),
    ).toEqual({
      file: 'bash',
      args: [
        path.posix.join(SCRIPTS, 'uninstall-orderbook.sh'),
        '--panel',
        'office',
        '--yes',
      ],
    });
  });

  it('passes --keep-data in the same spelling the script declares', () => {
    const command = uninstallCommand({
      platform: 'linux',
      panel: 'master',
      keepData: true,
      scriptsDir: SCRIPTS,
    });
    expect(command?.args).toContain('--keep-data');
  });
});

describe('platforms we ship no uninstaller for', () => {
  it('returns null rather than guessing at a command', () => {
    for (const platform of ['freebsd', 'sunos', 'aix'] as const) {
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

/*
 * The one flag whose drift is silent.
 *
 * `-KeepData` / `--keep-data` is spelled in five places that never import one
 * another: this module, the two scripts, and both `installer.nsh` files. Four
 * of the five are not TypeScript, so nothing above this comment can see them.
 *
 * Renaming it on one side is not loud. PowerShell would reject an unknown
 * parameter, but the NSIS hook builds the flag as a *string* and the bash
 * script's `case` simply falls through to `*)`... which exits 2 — except the
 * NSIS call ignores the exit code. And the default on every side is to ERASE.
 * So the failure mode is a company that answered "keep my data" and lost it.
 */
describe('the keep-data flag', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const read = (...parts: string[]): string =>
    readFileSync(path.join(repo, ...parts), 'utf8');

  it('is spelled -KeepData everywhere Windows reads it', () => {
    const fromHere = uninstallCommand({
      platform: 'win32',
      panel: 'master',
      keepData: true,
      scriptsDir: '/x',
    });
    expect(fromHere?.args).toContain('-KeepData');

    // The script's own parameter declaration, which is what PowerShell binds.
    expect(read('tools', 'uninstall', 'uninstall-orderbook.ps1')).toMatch(
      /\[switch\]\$KeepData/,
    );

    // Both uninstallers hand the same string to the same script.
    for (const panel of ['master', 'office']) {
      expect(read(panel, 'installer', 'installer.nsh')).toContain('StrCpy $R7 "-KeepData"');
    }
  });

  it('is spelled --keep-data everywhere POSIX reads it', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const command = uninstallCommand({
        platform,
        panel: 'master',
        keepData: true,
        scriptsDir: '/x',
      });
      // macOS builds one shell string; Linux passes argv. Both must carry it.
      expect(JSON.stringify(command?.args)).toContain('--keep-data');
    }

    /*
     * The argument parser, not the whole file.
     *
     * The first version of this asserted `toContain('--keep-data)')` over the
     * script and passed happily while the case arm was renamed — because the
     * summary it prints says `Data:   KEPT (--keep-data)`, and that closing
     * parenthesis matched. A guard a status message can satisfy is not a guard.
     */
    const script = read('tools', 'uninstall', 'uninstall-orderbook.sh');
    const parser = script.slice(
      script.indexOf('while [ $# -gt 0 ]'),
      script.indexOf('\ndone', script.indexOf('while [ $# -gt 0 ]')),
    );
    expect(parser).not.toBe('');
    expect(parser).toMatch(/^\s*--keep-data\)/m);
  });

  it('is absent from every side when the data is meant to go', () => {
    // The other half: a flag that is always passed keeps data that was meant
    // to be erased, and the typed DELETE confirmation would have been a lie.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const command = uninstallCommand({
        platform,
        panel: 'master',
        keepData: false,
        scriptsDir: '/x',
      });
      expect(JSON.stringify(command?.args).toLowerCase()).not.toContain('keepdata');
      expect(JSON.stringify(command?.args)).not.toContain('--keep-data');
    }
  });
});
