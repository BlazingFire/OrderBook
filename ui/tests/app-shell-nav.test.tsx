/**
 * The sidebar's second tier: an item with children carries a chevron, unfolds
 * on its own while the current page is inside it, folds by hand, and the
 * brand mark goes home. `graftSubNav` hangs an open operation under a child.
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell, flattenNav, type NavGroup } from '../src/AppShell.js';
import { graftSubNav } from '../src/SubNavSlot.js';

afterEach(cleanup);

const groups: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      {
        id: 'leads',
        label: 'Leads',
        icon: 'copy',
        children: [
          { id: 'leads.list', label: 'All leads', icon: 'edit' },
          { id: 'leads.followups', label: 'Follow-ups', icon: 'download' },
        ],
      },
    ],
  },
];

function shell(activeId: string, onNavigate = vi.fn()) {
  render(
    <AppShell
      groups={groups}
      activeId={activeId}
      onNavigate={onNavigate}
      collapsed={false}
      onToggleCollapsed={() => undefined}
      topbar={null}
      footer={null}
      rail="synced"
      railLabel=""
      onRailClick={() => undefined}
    >
      <div />
    </AppShell>,
  );
  return onNavigate;
}

describe('AppShell nav', () => {
  it('folds a sub-tier away until the current page is inside it', () => {
    shell('dashboard');
    expect(screen.queryByTitle('All leads')).toBeNull();
    cleanup();

    shell('leads.followups');
    expect(screen.getByTitle('All leads')).toBeTruthy();
    expect(screen.getByTitle('Follow-ups').getAttribute('aria-current')).toBe('page');
  });

  it('unfolds and folds by the chevron, and unfolds on choosing the parent', () => {
    const onNavigate = shell('dashboard');
    const chevron = screen.getByRole('button', { expanded: false });
    fireEvent.click(chevron);
    expect(screen.getByTitle('All leads')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByTitle('All leads')).toBeNull();

    fireEvent.click(screen.getByTitle('Leads'));
    expect(onNavigate).toHaveBeenCalledWith('leads');
    expect(screen.getByTitle('All leads')).toBeTruthy();
  });

  it('sends the brand mark to the dashboard', () => {
    const onNavigate = shell('leads.list');
    fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });
});

describe('graftSubNav', () => {
  it('hangs an open operation under a child, and flattens every depth', () => {
    const grafted = graftSubNav(groups[0]!.items, {
      parentId: 'leads.list',
      items: [{ id: 'leads.open', label: 'L-0042', icon: 'edit' }],
      activeId: 'leads.open',
    });
    const list = grafted[1]!.children![0]!;
    expect(list.children?.map((item) => item.id)).toEqual(['leads.open']);
    expect(flattenNav(grafted).map((item) => item.id)).toEqual([
      'dashboard',
      'leads',
      'leads.list',
      'leads.open',
      'leads.followups',
    ]);
    expect(graftSubNav(groups[0]!.items, null)).toBe(groups[0]!.items);
  });
});

describe('folding the modules left behind', () => {
  it('folds Orders when the person moves to Leads', () => {
    const groups = [
      {
        label: 'Work',
        items: [
          { id: 'leads', label: 'Leads', icon: 'leads' as const, children: [{ id: 'leads.list', label: 'List', icon: 'leads' as const }] },
          { id: 'orders', label: 'Orders', icon: 'orders' as const, children: [{ id: 'orders.all', label: 'All stages', icon: 'orders' as const }] },
        ],
      },
    ];
    function Harness() {
      const [active, setActive] = useState('dashboard');
      return (
        <AppShell
          groups={groups}
          activeId={active}
          onNavigate={setActive}
          collapsed={false}
          onToggleCollapsed={() => undefined}
          topbar={null}
          footer={null}
          rail="synced"
          railLabel=""
          onRailClick={() => undefined}
        >
          <div />
        </AppShell>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTitle('Orders'));
    expect(screen.queryByText('All stages')).not.toBeNull();

    fireEvent.click(screen.getByTitle('Leads'));
    expect(screen.queryByText('List')).not.toBeNull();
    expect(screen.queryByText('All stages')).toBeNull();
  });
});
