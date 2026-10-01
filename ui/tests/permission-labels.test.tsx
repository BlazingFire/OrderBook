/**
 * The permission grid's names come from the catalogue.
 *
 * `permissionLabels.ts` used to build English from the key itself —
 * `stock.adjust` read "Stock adjust" — and never looked at the `permission.*`,
 * `module.*`, `action.*` and `capabilityGroup.*` tokens that
 * `shared/tests/i18n-coverage.test.ts` makes the catalogue carry for every
 * key. So the grid and the role summary stayed English in Hindi, and a
 * capability read as its key with the dots taken out.
 */

import { cleanup, render, screen } from '@testing-library/react';
import {
  ACTIONS,
  CAPABILITIES,
  CAPABILITY_GROUPS,
  EN_MESSAGES,
  HI_MESSAGES,
  MODULES,
  PERMISSIONS,
  buildPermissionCatalogue,
} from '@orderbook/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { PermissionGrid } from '../src/PermissionGrid.js';
import { actionLabel, capabilityLabel, groupLabel, moduleLabel } from '../src/permissionLabels.js';

const en = EN_MESSAGES as Record<string, string>;
const hi = HI_MESSAGES as Record<string, string>;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('permission labels', () => {
  it('reads modules and actions exactly as the grid always showed them in English', () => {
    expect(MODULES.map(moduleLabel)).toEqual([
      'Pending Orders',
      'Final Orders',
      'Parties',
      'Products',
      'Inventory',
      'Reports',
      'Roles',
      'Logs',
    ]);
    expect(ACTIONS.map(actionLabel)).toEqual([
      'View',
      'Create',
      'Edit',
      'Delete',
      'Export',
      'Bulk',
    ]);
  });

  it('names every capability, group and module action by its catalogue token', () => {
    for (const capability of CAPABILITIES) {
      expect(capabilityLabel(capability.key)).toBe(en[`permission.${capability.key}`]);
    }
    // The Integrations screen names every permission, module actions included.
    for (const permission of PERMISSIONS) {
      expect(capabilityLabel(permission)).toBe(en[`permission.${permission}`]);
    }
    for (const group of CAPABILITY_GROUPS) {
      expect(groupLabel(group)).toBe(en[`capabilityGroup.${group}`]);
    }
    expect(capabilityLabel('stock.adjust')).toBe('Adjust stock by physical count');
  });

  it('speaks Hindi when the panel does', () => {
    window.localStorage.setItem('ob.locale', 'hi');

    expect(moduleLabel('leads')).toBe(hi['module.leads']);
    expect(actionLabel('view')).toBe(hi['action.view']);
    expect(capabilityLabel('lead.convert')).toBe(hi['permission.lead.convert']);
    expect(groupLabel('admin')).toBe(hi['capabilityGroup.admin']);
    expect(moduleLabel('leads')).not.toBe('Pending Orders');
  });

  it('still names a key this bundle’s catalogue does not know', () => {
    // A Master newer than this panel can serve a catalogue with a key the
    // panel's messages have never heard of; the raw token is worse than a
    // name built from the key.
    expect(capabilityLabel('recycleBin.purgeAll')).toBe('Recycle bin purge all');
    expect(moduleLabel('warehouses')).toBe('Warehouses');
    expect(actionLabel('archive')).toBe('Archive');
    expect(groupLabel('finance')).toBe('Finance');
  });

  it('puts the names in the grid, the row toggle’s title included', () => {
    window.localStorage.setItem('ob.locale', 'hi');
    render(
      <PermissionGrid
        catalogue={buildPermissionCatalogue()}
        tier="admin"
        selected={new Set()}
        onToggle={() => undefined}
        onToggleMany={() => undefined}
      />,
    );

    const row = screen.getByText(hi['module.leads']!);
    expect(row.getAttribute('title')).toBe(
      hi['access.permissions.toggleRow']!.replace('{module}', hi['module.leads']!),
    );
    expect(screen.getByText(hi['permission.lead.convert']!)).toBeTruthy();
    expect(screen.getByText(hi['capabilityGroup.admin']!)).toBeTruthy();
  });
});
