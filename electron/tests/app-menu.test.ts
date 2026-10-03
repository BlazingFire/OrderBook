import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appMenuTemplate, shellKeyAction } from '../lib/app-menu.js';

const shell = readFileSync(path.resolve(import.meta.dirname, '..', 'shell.ts'), 'utf8');

describe('appMenuTemplate', () => {
  it('has no menu at all on Windows and Linux', () => {
    for (const platform of ['win32', 'linux', 'freebsd']) {
      expect(appMenuTemplate(platform), platform).toBeNull();
    }
  });

  it('keeps only what Copy and Paste need on macOS', () => {
    const template = appMenuTemplate('darwin');
    expect(template).not.toBeNull();
    const text = JSON.stringify(template);
    // The roles that make Cmd+C / Cmd+V / Cmd+X / Cmd+A work, and Quit via appMenu.
    for (const role of ['appMenu', 'cut', 'copy', 'paste', 'selectAll']) {
      expect(text, role).toContain(`"${role}"`);
    }
    // None of the old File / View / Help menus came back.
    for (const label of ['File', 'View', 'Help']) {
      expect(text, label).not.toContain(`"label":"${label}"`);
    }
    expect(text).not.toContain('reload');
    expect(text).not.toContain('toggleDevTools');
  });
});

describe('shellKeyAction', () => {
  const key = (init: Partial<Parameters<typeof shellKeyAction>[0]>) =>
    ({ type: 'keyDown', key: '', ...init }) as Parameters<typeof shellKeyAction>[0];

  it('toggles full screen on a bare F11 only', () => {
    expect(shellKeyAction(key({ key: 'F11' }), true)).toBe('toggleFullScreen');
    expect(shellKeyAction(key({ key: 'F11', shift: true }), true)).toBeNull();
    expect(shellKeyAction(key({ key: 'F11', type: 'keyUp' }), true)).toBeNull();
  });

  it('opens the developer tools only in a build that is not packaged', () => {
    const combo = key({ key: 'I', control: true, shift: true });
    expect(shellKeyAction(combo, false)).toBe('toggleDevTools');
    expect(shellKeyAction(combo, true)).toBeNull();
  });

  it('leaves every other key to the page, F5 and F1 included', () => {
    for (const k of ['F5', 'F1', 'r', 'Enter']) {
      expect(shellKeyAction(key({ key: k, control: k === 'r' }), false), k).toBeNull();
    }
  });
});

describe('shell.ts menu wiring', () => {
  it('builds the menu from appMenuTemplate and no longer defines a File/Edit/View/Help template', () => {
    expect(shell).toContain('appMenuTemplate(process.platform)');
    expect(shell).toContain('Menu.setApplicationMenu(');
    expect(shell).not.toMatch(/label: '&(File|Edit|View|Help)'/);
    expect(shell).not.toContain("'help.shortcuts'");
  });

  it('hides the menu bar and handles F11 in the main window', () => {
    expect(shell).toContain('window.setMenuBarVisibility(false)');
    expect(shell).toContain("window.webContents.on('before-input-event'");
    expect(shell).toContain('shellKeyAction(input, app.isPackaged)');
  });
});
