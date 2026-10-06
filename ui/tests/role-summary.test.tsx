/**
 * What a role's card says, and what the permission grid does with a search.
 * The summary is derived from keys and the catalogue alone: the server sends
 * no role description.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildPermissionCatalogue } from '@orderbook/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermissionGrid } from '../src/PermissionGrid.js';
import { matchesQuery, permissionChange, summariseRole } from '../src/roleSummary.js';

afterEach(cleanup);

const catalogue = buildPermissionCatalogue();

describe('summariseRole', () => {
  it('splits modules into the ones a role can change and the ones it can only view', () => {
    const summary = summariseRole(['leads.view', 'orders.view', 'orders.edit'], catalogue);
    expect(summary.changes).toEqual(['Final Orders']);
    expect(summary.viewOnly).toEqual(['Pending Orders']);
    expect(summary.held).toBe(3);
    expect(summary.total).toBeGreaterThan(30);
  });

  it('counts capability groups the role holds at least one key of', () => {
    const summary = summariseRole(['lead.convert'], catalogue);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]!.held).toBe(1);
  });

  it('says nothing for a role with no permissions', () => {
    const summary = summariseRole([], catalogue);
    expect(summary).toMatchObject({ held: 0, changes: [], viewOnly: [], groups: [] });
  });
});

describe('permissionChange', () => {
  it('counts what a person gains and loses going between two roles', () => {
    expect(permissionChange(['a', 'b'], ['b', 'c', 'd'])).toEqual({ gained: 2, lost: 1 });
    expect(permissionChange(['a'], ['a'])).toEqual({ gained: 0, lost: 0 });
  });
});

describe('matchesQuery', () => {
  it('matches any field, ignoring case and spaces at the ends, and everything when empty', () => {
    expect(matchesQuery(' CONV ', 'Convert a pending order', 'lead.convert')).toBe(true);
    expect(matchesQuery('zzz', 'Convert', 'lead.convert')).toBe(false);
    expect(matchesQuery('', 'anything')).toBe(true);
  });
});

describe('PermissionGrid search and select-all', () => {
  const noop = () => undefined;

  it('shows only the matching rows and capabilities, and says so when nothing matches', () => {
    const { rerender } = render(
      <PermissionGrid catalogue={catalogue} tier="admin" selected={new Set()} onToggle={noop} onToggleMany={noop} query="convert" />,
    );
    expect(screen.queryByText('Parties')).toBeNull();
    expect(screen.getAllByRole('checkbox').length).toBeLessThan(5);

    rerender(
      <PermissionGrid catalogue={catalogue} tier="admin" selected={new Set()} onToggle={noop} onToggleMany={noop} query="zzz-nothing" />,
    );
    expect(screen.getByRole('status').textContent).toContain('zzz-nothing');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('select-all on the modules section turns on only the rows on screen', () => {
    const onToggleMany = vi.fn();
    render(
      <PermissionGrid catalogue={catalogue} tier="admin" selected={new Set()} onToggle={noop} onToggleMany={onToggleMany} query="parties" />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Select all' });
    fireEvent.click(buttons[0]!);
    const keys = onToggleMany.mock.calls[0]![0] as string[];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('parties.'))).toBe(true);
    expect(onToggleMany.mock.calls[0]![1]).toBe(true);
  });
});

describe('what a card says about parties', () => {
  it('lists the Parties actions a role holds, because creating parties changes who sees what', () => {
    const summary = summariseRole(['parties.view', 'parties.create', 'parties.edit', 'leads.view'], catalogue);
    expect(summary.parties).toEqual(['View', 'Create', 'Edit']);
    expect(summariseRole(['leads.view'], catalogue).parties).toEqual([]);
  });
});

describe('what a card says about the notice board', () => {
  it('reads nothing, reading, or reading and managing', () => {
    expect(summariseRole(['leads.view'], catalogue).notices).toBe('none');
    expect(summariseRole(['notices.view'], catalogue).notices).toBe('read');
    expect(summariseRole(['notices.view', 'notices.manage'], catalogue).notices).toBe('manage');
    // Managing without reading is still managing: the key is the stronger statement.
    expect(summariseRole(['notices.manage'], catalogue).notices).toBe('manage');
  });
});
