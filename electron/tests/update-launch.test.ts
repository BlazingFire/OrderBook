import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  INSTALLER_ARGUMENTS,
  isHighIntegrity,
  planInstallerLaunch,
  powershellQuote,
  unattendedInstallDue,
} from '../lib/update-launch.js';

const shell = readFileSync(path.resolve(import.meta.dirname, '..', 'shell.ts'), 'utf8');
const FILE = 'C:\\Users\\Z\\AppData\\Roaming\\Master\\pending-update\\OrderBook-Master-1.3.0-Setup.exe';

describe('planInstallerLaunch', () => {
  it('runs the setup silently and relaunches the app, however it is started', () => {
    expect(INSTALLER_ARGUMENTS).toEqual(['/S', '--force-run']);
  });

  it('elevates through PowerShell when somebody is there to answer UAC', () => {
    const plan = planInstallerLaunch({ platform: 'win32', file: FILE, unattended: false, elevated: false });
    expect(plan).toMatchObject({ how: 'elevate', command: 'powershell.exe' });
    const script = (plan as { args: string[] }).args.at(-1) ?? '';
    expect(script).toContain('-Verb RunAs');
    expect(script).toContain("-ArgumentList '/S','--force-run'");
    expect(script).toContain(`-FilePath '${FILE}'`);
  });

  it('runs the setup directly when this process is already elevated, nobody present or not', () => {
    for (const unattended of [false, true]) {
      expect(planInstallerLaunch({ platform: 'win32', file: FILE, unattended, elevated: true })).toEqual({
        how: 'spawn',
        command: FILE,
        args: ['/S', '--force-run'],
      });
    }
  });

  it('never starts a UAC prompt nobody can answer: an unattended, non-elevated install declines', () => {
    expect(planInstallerLaunch({ platform: 'win32', file: FILE, unattended: true, elevated: false })).toEqual({
      how: 'needs-approval',
    });
  });

  it('hands a macOS setup file to the OS', () => {
    expect(
      planInstallerLaunch({ platform: 'darwin', file: '/x/y.dmg', unattended: false, elevated: false }),
    ).toEqual({ how: 'open' });
  });
});

describe('powershellQuote', () => {
  it('doubles a single quote, so a path cannot break out of the literal', () => {
    expect(powershellQuote("C:\\Bob's\\a.exe")).toBe("'C:\\Bob''s\\a.exe'");
    expect(powershellQuote("x'; Remove-Item -Recurse C:\\ #")).toBe("'x''; Remove-Item -Recurse C:\\ #'");
  });
});

describe('isHighIntegrity', () => {
  it('reads the High Mandatory Level group', () => {
    expect(isHighIntegrity('Mandatory Label\\High Mandatory Level   Label   S-1-16-12288')).toBe(true);
    expect(isHighIntegrity('Mandatory Label\\Medium Mandatory Level   Label   S-1-16-8192')).toBe(false);
  });
});

describe('unattendedInstallDue', () => {
  const health = (auto: string | null, prepared: string | null) => ({
    autoUpdate: auto ? { version: auto } : null,
    installer: prepared ? { version: prepared } : null,
  });

  it('is due only for the build that is prepared, once', () => {
    expect(unattendedInstallDue(health('1.3.0', '1.3.0'), null)).toBe('1.3.0');
    expect(unattendedInstallDue(health('1.3.0', '1.3.0'), '1.3.0')).toBeNull();
    expect(unattendedInstallDue(health('1.3.1', '1.3.0'), null)).toBeNull();
    expect(unattendedInstallDue(health(null, '1.3.0'), null)).toBeNull();
    expect(unattendedInstallDue(health('1.3.0', null), null)).toBeNull();
  });
});

describe('shell.ts update wiring', () => {
  it('launches through planInstallerLaunch and watches for the nightly request', () => {
    expect(shell).toContain('planInstallerLaunch(');
    expect(shell).toContain('unattendedInstallDue(');
  });

  it('asks the page to save its work before the server is stopped', () => {
    const flush = shell.indexOf('await flushRenderer()');
    const stop = shell.indexOf('await stopServer();', flush);
    expect(flush).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(flush);
  });
});

describe('the installers start the new version afterwards (R7d)', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  for (const file of ['master/electron-builder.yml', 'office/electron-builder.yml', 'office/electron-builder.legacy.yml']) {
    it(`${file} runs the app when the wizard finishes`, () => {
      expect(readFileSync(path.join(repo, file), 'utf8')).toMatch(/^\s+runAfterFinish: true$/m);
    });
  }
});
