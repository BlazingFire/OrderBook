/**
 * Every keyboard command, declared once.
 *
 * The titles reuse the catalogue keys the sidebar already renders —
 * `nav.master.dashboard`, `nav.leads` and the rest — rather than minting a
 * second set. That is not tidiness: a palette whose entry for a screen is
 * spelled differently from the sidebar's entry for the same screen is a palette
 * people stop trusting, and two sets of strings drift the first time somebody
 * renames a tab.
 *
 * `navOrder` is a screen's place in its sidebar and the Alt digits follow
 * it, and both are **declared here rather than taken from the rendered
 * sidebar index**. The sidebar filters out the screens a person's permissions
 * exclude, so a rendered index would move Alt+3 for somebody who cannot see
 * one of the screens above it — a shortcut that means something different per
 * person is worse than no shortcut.
 */

import type { MessageKey } from '../i18n/keys.js';

export type CommandScope =
  /** Always available, dialogs included. */
  | 'global'
  /**
   * Only when no dialog is open.
   *
   * The resolver skips these entirely while a `[role="dialog"]` exists, so F2
   * cannot fire on the screen behind a scrim. A dialog that wants a shortcut
   * registers its own inside itself.
   */
  | 'screen';

export interface CommandDef {
  id: string;
  titleToken: MessageKey;
  scope: CommandScope;
  /** The panel this command exists on. `both` for the chrome. */
  panel: 'master' | 'office' | 'both';
  /** The screen id a nav command opens. */
  tab?: string;
  /**
   * The screen's place in its panel's sidebar, from 1. Absent for anything
   * that is not a nav destination. The Alt digit is in `defaultChord`, since a
   * row with an explicit chord or none does not use a digit up.
   */
  navOrder?: number;
  /** The chord this ships bound to, in `parseChord` form. */
  defaultChord?: string;
  /** Platform-specific override. When present and the platform matches, takes precedence over defaultChord. */
  platformDefaultChord?: { darwin: string };
}

/**
 * One sidebar row: its screen id, its title token and, optionally, its chord.
 *
 * Leave the chord out and the row takes the next free Alt digit — counted only
 * over rows that left it out, so a row with an explicit chord or with `null`
 * does not use one up. A string is an explicit chord; `null` means no chord at
 * all, which the palette still reaches by name.
 *
 * An explicit chord has no darwin `Meta+` twin. Alt/Option plus a letter
 * already matches on the physical key on a Mac, and `Meta+C` or `Meta+P` would
 * take Copy and Print away from a Mac browser on the shop LAN.
 */
export type NavEntry = [id: string, token: MessageKey, chord?: string | null];

/**
 * The Master's nav order, matching its own sidebar: Work, Catalogue, Admin,
 * System (`keys-nav-order.test.ts` holds this list to the sidebar).
 *
 * The digits match the Office's, so Alt+3 is Pending Orders on both panels.
 * Reports and the Admin screens have no chord; nobody reads Alt+0 as "the
 * tenth", and the palette reaches every one of them by name.
 */
const MASTER_NAV: NavEntry[] = [
  ['basicHome', 'nav.basicHome'],
  ['dashboard', 'nav.master.dashboard'],
  ['leads', 'nav.leads'],
  ['orders', 'nav.orders'],
  ['conflicts', 'nav.master.conflicts'],
  ['reports', 'nav.reports', null],
  ['products', 'nav.products'],
  ['parties', 'nav.master.parties'],
  ['partyAccess', 'nav.master.partyAccess'],
  ['panels', 'nav.master.panels', null],
  ['access', 'nav.master.access', null],
  ['fields', 'nav.master.fields', null],
  ['logs', 'nav.master.logs', null],
  ['recycleBin', 'nav.master.recycleBin', null],
  ['integrations', 'nav.master.integrations', null],
  ['settings', 'nav.master.settings'],
  ['updates', 'nav.updates', null],
];

/**
 * The Office panel's nav order — **its own sidebar's**. It shares the Master's
 * chord map for every screen both panels have, and has no Admin group.
 */
const OFFICE_NAV: NavEntry[] = [
  ['basicHome', 'nav.basicHome'],
  ['dashboard', 'nav.dashboard'],
  ['leads', 'nav.leads'],
  ['orders', 'nav.orders'],
  ['conflicts', 'nav.conflicts'],
  ['products', 'nav.products'],
  ['parties', 'nav.parties'],
  ['partyAccess', 'nav.partyAccess'],
  ['settings', 'nav.settings'],
  ['updates', 'nav.updates', null],
];

/** Builds one panel's nav commands. Exported for `keys.test.ts`. */
export function navCommands(panel: 'master' | 'office', entries: NavEntry[]): CommandDef[] {
  let digit = 0;
  return entries.map(([tab, titleToken, chord], index) => {
    // Only a row that left its chord out takes a digit, and only nine exist.
    const auto = chord === undefined && digit < 9 ? (digit += 1) : undefined;
    return {
      id: `nav.${panel}.${tab}`,
      titleToken,
      scope: 'screen' as const,
      panel,
      tab,
      // The sidebar position, whatever the chord is.
      navOrder: index + 1,
      defaultChord: auto ? `Alt+${auto}` : (chord ?? undefined),
      platformDefaultChord: auto ? { darwin: `Meta+${auto}` } : undefined,
    };
  });
}

export const COMMANDS: readonly CommandDef[] = [
  {
    id: 'palette.open',
    titleToken: 'keys.command.palette',
    scope: 'global',
    panel: 'both',
    defaultChord: 'Ctrl+K',
    platformDefaultChord: { darwin: 'Meta+K' },
  },
  {
    id: 'palette.search',
    titleToken: 'keys.command.search',
    scope: 'screen',
    panel: 'both',
    defaultChord: '/',
  },
  {
    id: 'record.save',
    titleToken: 'keys.command.save',
    // Global, so Ctrl+S inside an open editor saves the editor. The top of the
    // registration stack wins, which is the dialog when one is open.
    scope: 'global',
    panel: 'both',
    defaultChord: 'Ctrl+S',
    platformDefaultChord: { darwin: 'Meta+S' },
  },
  {
    id: 'record.new',
    titleToken: 'keys.command.new',
    scope: 'screen',
    // Both panels: on each it opens New pending order (a lead), and on the
    // Master only for a role with `leads.create` — the shell registers `null`
    // for everyone else, so the palette entry is absent rather than inert.
    panel: 'both',
    defaultChord: 'Ctrl+Shift+N',
    platformDefaultChord: { darwin: 'Meta+Shift+N' },
  },
  {
    id: 'view.reset',
    titleToken: 'keys.command.reset',
    scope: 'screen',
    panel: 'both',
    defaultChord: 'Ctrl+Shift+R',
    platformDefaultChord: { darwin: 'Meta+Shift+R' },
  },
  {
    id: 'view.refresh',
    titleToken: 'keys.command.refresh',
    scope: 'screen',
    panel: 'both',
    defaultChord: 'F5',
  },
  {
    id: 'keys.help',
    titleToken: 'keys.command.help',
    scope: 'global',
    panel: 'both',
    defaultChord: 'Ctrl+/',
    platformDefaultChord: { darwin: 'Meta+/' },
  },
  /*
   * `edit.undo` (Ctrl+Z) and `edit.duplicate` (Ctrl+D) were here and are gone.
   *
   * Nothing ever handled either one: no `useCommand` registration, no shell
   * command, no `tab`. They reached the palette and the help sheet, advertised
   * a chord, and did nothing when pressed. Ctrl+Z was worse than inert — it
   * shadowed the Electron Edit menu's own undo accelerator, so pressing it
   * while typing into a lead cancelled the browser's undo and did not
   * substitute one.
   *
   * `nav.prev` / `nav.next` (Alt+Arrow) went with them. They additionally bound
   * a chord `matchesChord` can never match, because `codeFor` has no entry for
   * an arrow key — so they could not have fired even with a handler.
   *
   * `shared/tests/keys-implemented.test.ts` is what keeps this list honest.
   */
  {
    id: 'view.toggleSidebar',
    titleToken: 'keys.command.toggleSidebar',
    scope: 'screen',
    panel: 'both',
    defaultChord: 'Ctrl+\\',
    platformDefaultChord: { darwin: 'Meta+\\' },
  },
  {
    id: 'view.find',
    titleToken: 'keys.command.find',
    scope: 'screen',
    panel: 'both',
    defaultChord: 'Ctrl+F',
    platformDefaultChord: { darwin: 'Meta+F' },
  },
  ...navCommands('master', MASTER_NAV),
  ...navCommands('office', OFFICE_NAV),
];

export const COMMANDS_BY_ID: ReadonlyMap<string, CommandDef> = new Map(
  COMMANDS.map((command) => [command.id, command]),
);

/** The commands one panel offers, in the order a list should show them. */
export function commandsFor(panel: 'master' | 'office'): CommandDef[] {
  return COMMANDS.filter((command) => command.panel === panel || command.panel === 'both');
}
