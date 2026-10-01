/**
 * The command line the shell hands the OS to uninstall a panel.
 *
 * The flags here are a contract with `tools/uninstall/`: PowerShell rejects a
 * parameter it does not know, but a flag that silently stopped being passed
 * would fall back to the script's default — and the default for data is to
 * erase it. So the exact shape, and where `keepData` lands in it, is pinned.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sweepCommand, uninstallCommand, uninstallScriptsDir } from '../lib/uninstall.js';

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

/*
 * The whole-machine sweep the standalone clean-install tool runs.
 *
 * Two differences from the per-panel command above, and both matter: it asks
 * for every panel at once, and it can ask without doing anything. The dry run
 * is what the tool's detect and verify passes are built on, so a `-DryRun`
 * that silently stopped being passed would turn "here is what I found" into
 * an erase nobody asked for.
 */
describe('the whole-machine sweep', () => {
  it('asks Windows for every panel, and changes nothing on a dry run', () => {
    expect(
      sweepCommand({ platform: 'win32', panel: 'all', dryRun: true, scriptsDir: SCRIPTS }),
    ).toEqual({
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(SCRIPTS, 'uninstall-orderbook.ps1'),
        '-Panel',
        'all',
        '-DryRun',
      ],
    });
  });

  it('never passes -Yes and -DryRun together', () => {
    // -Yes answers the confirmation; -DryRun means there is nothing to
    // confirm. Passing both reads like a belt-and-braces mistake and is how a
    // detect pass turns into a wipe.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const dry = sweepCommand({ platform, panel: 'all', dryRun: true, scriptsDir: SCRIPTS });
      expect(dry?.args).not.toContain('-Yes');
      expect(dry?.args).not.toContain('--yes');

      const real = sweepCommand({ platform, panel: 'all', dryRun: false, scriptsDir: SCRIPTS });
      expect(real?.args.some((arg) => arg === '-Yes' || arg === '--yes')).toBe(true);
      expect(real?.args).not.toContain('-DryRun');
      expect(real?.args).not.toContain('--dry-run');
    }
  });

  it('never passes the keep-data flag — this tool is the one that erases', () => {
    // The clean-install tool exists to leave nothing behind. If it ever grew a
    // keep-data mode it would need its own confirmation, and this assertion is
    // where that conversation starts.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const dryRun of [true, false]) {
        const command = sweepCommand({ platform, panel: 'all', dryRun, scriptsDir: SCRIPTS });
        expect(JSON.stringify(command?.args).toLowerCase()).not.toContain('keepdata');
        expect(JSON.stringify(command?.args)).not.toContain('--keep-data');
      }
    }
  });

  it('runs the POSIX script directly, so its output comes back to us', () => {
    // Not through osascript, unlike the per-panel macOS command: that wrapper
    // hands the script's output to Terminal, and this tool has to read it.
    const command = sweepCommand({
      platform: 'darwin',
      panel: 'all',
      dryRun: true,
      scriptsDir: SCRIPTS,
    });
    expect(command?.file).toBe('bash');
    expect(command?.args).toEqual([
      path.posix.join(SCRIPTS, 'uninstall-orderbook.sh'),
      '--panel',
      'all',
      '--dry-run',
    ]);
  });

  it('is null on a platform with no script, like the per-panel command', () => {
    expect(
      sweepCommand({ platform: 'freebsd', panel: 'all', dryRun: true, scriptsDir: SCRIPTS }),
    ).toBeNull();
  });
});

/*
 * The Windows script runs on PowerShell 2.0 too: the Windows 7 Office build
 * ships it (docs/WINDOWS7.md), and Windows 7 has nothing newer. PowerShell 2.0
 * cannot run in CI, so this list of what 3.0 and later added is the guard, and
 * the dry run below proves the 2.0-shaped script still works on 5.1.
 */
describe('the Windows uninstall script on PowerShell 2.0', () => {
  const SCRIPT = path.resolve('tools', 'uninstall', 'uninstall-orderbook.ps1');
  const source = readFileSync(SCRIPT, 'utf8');
  // Comment lines dropped: saying what is missing is not using it.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  const NEWER_THAN_2: [string, RegExp][] = [
    ['Get-Content -Raw', /-Raw\b/i],
    ['$PSCommandPath', /\$PSCommandPath\b/i],
    ['$PSScriptRoot', /\$PSScriptRoot\b/i],
    ['$PSItem', /\$PSItem\b/i],
    ['Get-ChildItem -Directory', /\s-Directory\b/i],
    ['the -in / -notin operators', /\s-(not)?in\s/i],
    ['[ordered]', /\[ordered\]/i],
    ['[pscustomobject]', /\[pscustomobject\]/i],
    ['.ForEach( / .Where(', /\.(ForEach|Where)\(/i],
    ['-ErrorAction Ignore', /-ErrorAction\s+Ignore\b/i],
    ['::new(', /::new\(/i],
    ['ConvertFrom-Json / ConvertTo-Json', /Convert(From|To)-Json/i],
    ['HashSet', /HashSet/i],
  ];

  it.each(NEWER_THAN_2)('uses nothing PowerShell 2.0 lacks: %s', (_name, pattern) => {
    expect(code).not.toMatch(pattern);
  });

  it('keeps the flags its four callers pass', () => {
    const param = /param\(([\s\S]*?)\n\)/.exec(source)?.[1] ?? '';
    const names = [...param.matchAll(/\$(\w+)/g)].map((match) => match[1]);
    expect(names).toEqual(['Panel', 'KeepData', 'Yes', 'LeftoversOnly', 'DryRun', 'Elevated']);
    expect(param).toContain("[ValidateSet('master', 'office', 'all')]");
  });

  it.skipIf(process.platform !== 'win32')(
    'completes a dry run on this PC',
    () => {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SCRIPT,
          '-Panel',
          'office',
          '-DryRun',
        ],
        { encoding: 'utf8', timeout: 90_000 },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Dry run complete. Nothing was changed.');
    },
    120_000,
  );
});
