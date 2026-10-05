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

import { groupLabel, moduleLabel } from './permissionLabels';

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

  return { held, total, changes, viewOnly, groups };
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

/** True when a catalogue entry (module, capability or group) matches what was typed. */
export function matchesQuery(query: string, ...haystack: string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystack.some((text) => text.toLowerCase().includes(needle));
}
