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
 * `navOrder` is the number Alt+N binds to, and it is **declared here rather
 * than taken from the rendered sidebar index**. The sidebar filters out the
 * screens a person's permissions exclude, so a rendered index would move Alt+3
 * from Orders to Conflicts for one user and not another — a shortcut that means
 * something different per person is worse than no shortcut.
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
  /** 1–9, for Alt+N. Absent for anything that is not a nav destination. */
  navOrder?: number;
  /** The chord this ships bound to, in `parseChord` form. */
  defaultChord?: string;
}

/**
 * The Master's nav order, matching its own sidebar — Work then Admin, in the
 * order `workItems`/`adminItems` declare them.
 *
 * Fourteen screens and nine usable numbers, so the tail has no chord. That is
 * deliberate rather than a limit worked around: Alt+0 reads as "the tenth" to
 * nobody, and the palette reaches every one of them by name.
 */
const MASTER_NAV: Array<[id: string, token: MessageKey]> = [
  ['dashboard', 'nav.master.dashboard'],
  ['orders', 'nav.master.leadsOrders'],
  ['inventory', 'nav.master.inventory'],
  ['reports', 'nav.master.reports'],
  ['documents', 'nav.master.documents'],
  ['conflicts', 'nav.master.conflicts'],
  ['panels', 'nav.master.panels'],
  ['access', 'nav.master.access'],
  ['partyAccess', 'nav.master.partyAccess'],
  ['fields', 'nav.master.fields'],
  ['logs', 'nav.master.logs'],
  ['recycleBin', 'nav.master.recycleBin'],
  ['settings', 'nav.master.settings'],
  ['updates', 'nav.updates'],
];

/**
 * The Office panel's nav order — **its own sidebar's**, not the Master's.
 *
 * Conflicts sits fourth here and nowhere near fourth on the Master. Copying the
 * Master's order would have put Alt+4 on a different screen than the one the
 * office sidebar shows fourth, which is exactly the mismatch a numbered
 * shortcut cannot survive.
 */
const OFFICE_NAV: Array<[id: string, token: MessageKey]> = [
  ['dashboard', 'nav.dashboard'],
  ['leads', 'nav.leads'],
  ['orders', 'nav.orders'],
  ['conflicts', 'nav.conflicts'],
  ['products', 'nav.products'],
  ['parties', 'nav.parties'],
  ['partyAccess', 'nav.partyAccess'],
  ['settings', 'nav.settings'],
  ['updates', 'nav.updates'],
];

function navCommands(
  panel: 'master' | 'office',
  entries: Array<[string, MessageKey]>,
): CommandDef[] {
  return entries.map(([tab, titleToken], index) => ({
    id: `nav.${panel}.${tab}`,
    titleToken,
    scope: 'screen' as const,
    panel,
    tab,
    navOrder: index + 1,
    defaultChord: index < 9 ? `Alt+${index + 1}` : undefined,
  }));
}

export const COMMANDS: readonly CommandDef[] = [
  {
    id: 'palette.open',
    titleToken: 'keys.command.palette',
    scope: 'global',
    panel: 'both',
    defaultChord: 'Ctrl+K',
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
  },
  {
    id: 'record.new',
    titleToken: 'keys.command.new',
    scope: 'screen',
    panel: 'both',
    defaultChord: 'Ctrl+Shift+N',
  },
  {
    id: 'view.reset',
    titleToken: 'keys.command.reset',
    scope: 'screen',
    panel: 'both',
    defaultChord: 'Ctrl+Shift+R',
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
