/**
 * What a role lets its holder do, in a few lines a person can read before
 * giving it to somebody.
 *
 * Pure: it works from the permission keys a role holds and the catalogue the
 * server sent, and invents nothing. A role has no description field on the
 * server (the contract does not carry one), so the description is derived — the
 * modules the role can change, the modules it can only look at, and how much of
 * each capability group it holds.
 */

import type { PermissionCatalogue } from '@orderbook/shared';

import { actionLabel, groupLabel, moduleLabel } from './permissionLabels';

export interface RoleSummary {
  /** Keys held, out of every key in the catalogue (modules x actions, plus capabilities). */
  held: number;
  total: number;
  /** Module names where the role holds any action beyond viewing. */
  changes: string[];
  /** Module names where the role holds viewing and nothing else. */
  viewOnly: string[];
  /** Capability groups the role holds at least one key of. */
  groups: Array<{ key: string; label: string; held: number; total: number }>;
  /** The Parties actions the role holds (View, Create, Edit …), because creating parties is the one right that changes who sees what. */
  parties: string[];
  /** What the role holds on the notice board: nothing, reading, or reading and managing. */
  notices: 'none' | 'read' | 'manage';
}

export function summariseRole(
  permissions: readonly string[],
  catalogue: PermissionCatalogue,
): RoleSummary {
  const has = new Set(permissions);

  const changes: string[] = [];
  const viewOnly: string[] = [];
  let held = 0;
  let total = 0;

  for (const module of catalogue.modules) {
    const keys = module.actions.map((action) => ({ action, key: `${module.key}.${action}` }));
    total += keys.length;
    const mine = keys.filter(({ key }) => has.has(key));
    held += mine.length;
    if (mine.length === 0) continue;
    if (mine.every(({ action }) => action === 'view')) viewOnly.push(moduleLabel(module.key));
    else changes.push(moduleLabel(module.key));
  }

  const groups: RoleSummary['groups'] = [];
  for (const group of catalogue.groups) {
    const capabilities = catalogue.capabilities.filter((c) => c.group === group.key);
    total += capabilities.length;
    const mine = capabilities.filter((c) => has.has(c.key)).length;
    held += mine;
    if (mine > 0) {
      groups.push({
        key: group.key,
        label: groupLabel(group.key),
        held: mine,
        total: capabilities.length,
      });
    }
  }

  const partyModule = catalogue.modules.find((module) => module.key === 'parties');
  const parties = partyModule
    ? partyModule.actions
        .filter((action) => has.has(`parties.${action}`))
        .map((action) => actionLabel(action))
    : [];

  const notices = has.has('notices.manage') ? 'manage' : has.has('notices.view') ? 'read' : 'none';

  return { held, total, changes, viewOnly, groups, parties, notices };
}

/** Keys gained and lost going from one role's permissions to another's. */
export function permissionChange(
  from: readonly string[],
  to: readonly string[],
): { gained: number; lost: number } {
  const before = new Set(from);
  const after = new Set(to);
  return {
    gained: to.filter((key) => !before.has(key)).length,
    lost: from.filter((key) => !after.has(key)).length,
  };
}

/** One key across two roles: held by both, only the new one, only the old one, or neither. */
export type PermissionCellState = 'kept' | 'gained' | 'lost' | 'none';

export interface RoleComparison {
  /** One row per module; a cell is null where the module declares no such action. */
  modules: Array<{
    key: string;
    label: string;
    cells: Array<{ action: string; key: string; state: PermissionCellState | null }>;
  }>;
  /** Capability groups as counts: held before, held after, out of the group's size. */
  groups: Array<{ key: string; label: string; total: number; from: number; to: number }>;
  gained: number;
  lost: number;
}

/**
 * The person screen's matrix: what moving from one role's keys to another's
 * keeps, adds and takes away, laid out by the catalogue. Comparing a role with
 * itself is how the screen shows a role on its own (every held key "kept").
 */
export function compareRoles(
  from: readonly string[],
  to: readonly string[],
  catalogue: PermissionCatalogue,
): RoleComparison {
  const before = new Set(from);
  const after = new Set(to);
  const stateOf = (key: string): PermissionCellState =>
    before.has(key)
      ? after.has(key)
        ? 'kept'
        : 'lost'
      : after.has(key)
        ? 'gained'
        : 'none';

  const modules = catalogue.modules.map((module) => ({
    key: module.key,
    label: moduleLabel(module.key),
    cells: catalogue.actions.map((action) => {
      const key = `${module.key}.${action}`;
      return { action, key, state: module.actions.includes(action) ? stateOf(key) : null };
    }),
  }));

  const groups = catalogue.groups.map((group) => {
    const keys = catalogue.capabilities.filter((c) => c.group === group.key).map((c) => c.key);
    return {
      key: group.key,
      label: groupLabel(group.key),
      total: keys.length,
      from: keys.filter((key) => before.has(key)).length,
      to: keys.filter((key) => after.has(key)).length,
    };
  });

  return { modules, groups, ...permissionChange(from, to) };
}

/** True when a catalogue entry (module, capability or group) matches what was typed. */
export function matchesQuery(query: string, ...haystack: string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystack.some((text) => text.toLowerCase().includes(needle));
}
