/**
 * The application menu, or the lack of one (1.4 R2).
 *
 * The owner does not want a menu bar: Windows and Linux windows carry none, and
 * every function the old File / Edit / View / Help menus offered has an in-app
 * home (list in `docs/STRUCTURE.md`, "Menubar"). macOS cannot do without one:
 * its Copy, Paste, Cut and Select All keys route through the application menu's
 * roles, so a Mac keeps the smallest menu that makes them work.
 *
 * Here rather than in `shell.ts` because that file imports `electron` and cannot
 * run under the suite; these decisions can.
 */

export type MenuItem = { role: string } | { type: 'separator' };

export interface MenuTemplateEntry {
  role?: string;
  label?: string;
  submenu?: MenuItem[];
}

/**
 * The template to build the menu from, or `null` for no menu at all.
 *
 * Only macOS gets one. Windows and Linux return `null`, which the shell hands
 * to `Menu.setApplicationMenu` to remove the bar from every window.
 */
export function appMenuTemplate(platform: string): MenuTemplateEntry[] | null {
  if (platform !== 'darwin') return null;
  return [
    // Quit, Hide and About live here, not in File: Cmd+Q and Cmd+H come from it.
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    // Cmd+M minimise, and the macOS window list.
    { role: 'windowMenu' },
  ];
}

/** What a key press the menu used to own should now do in the main process. */
export type ShellKeyAction = 'toggleFullScreen' | 'toggleDevTools';

/** The slice of Electron's `before-input-event` input this decision reads. */
export interface ShellKeyInput {
  type: string;
  key: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * The two accelerators the menu carried that no renderer command replaced.
 *
 * - **F11** toggles full screen (the View menu's `togglefullscreen`).
 * - **Ctrl+Shift+I** opens the developer tools, **in a build that is not
 *   packaged** only (the menu added the item under the same condition, and
 *   `devTools` is off in a packaged window regardless).
 *
 * Reload is not here: F5 (`view.refresh`) is a renderer command already.
 */
export function shellKeyAction(input: ShellKeyInput, isPackaged: boolean): ShellKeyAction | null {
  if (input.type !== 'keyDown') return null;
  const bare = !input.control && !input.meta && !input.shift && !input.alt;
  if (input.key === 'F11' && bare) return 'toggleFullScreen';
  if (
    !isPackaged &&
    input.key.toLowerCase() === 'i' &&
    input.shift &&
    (input.control || input.meta) &&
    !input.alt
  ) {
    return 'toggleDevTools';
  }
  return null;
}
