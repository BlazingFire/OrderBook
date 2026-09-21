/**
 * The sidebar's second tier: an item with children carries a chevron, unfolds
 * on its own while the current page is inside it, folds by hand, and the
 * brand mark goes home. `graftSubNav` hangs an open operation under a child.
 */

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
        id: 'documents',
        label: 'Documents',
        icon: 'copy',
        children: [
          { id: 'documents.templates', label: 'Templates', icon: 'edit' },
          { id: 'documents.exports', label: 'Exports', icon: 'download' },
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
    expect(screen.queryByTitle('Templates')).toBeNull();
    cleanup();

    shell('documents.exports');
    expect(screen.getByTitle('Templates')).toBeTruthy();
    expect(screen.getByTitle('Exports').getAttribute('aria-current')).toBe('page');
  });

  it('unfolds and folds by the chevron, and unfolds on choosing the parent', () => {
    const onNavigate = shell('dashboard');
    const chevron = screen.getByRole('button', { expanded: false });
    fireEvent.click(chevron);
    expect(screen.getByTitle('Templates')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByTitle('Templates')).toBeNull();

    fireEvent.click(screen.getByTitle('Documents'));
    expect(onNavigate).toHaveBeenCalledWith('documents');
    expect(screen.getByTitle('Templates')).toBeTruthy();
  });

  it('sends the brand mark to the dashboard', () => {
    const onNavigate = shell('documents.templates');
    fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });
});

describe('graftSubNav', () => {
  it('hangs an open operation under a child, and flattens every depth', () => {
    const grafted = graftSubNav(groups[0]!.items, {
      parentId: 'documents.templates',
      items: [{ id: 'documents.editor', label: 'Quotation A4', icon: 'edit' }],
      activeId: 'documents.editor',
    });
    const templates = grafted[1]!.children![0]!;
    expect(templates.children?.map((item) => item.id)).toEqual(['documents.editor']);
    expect(flattenNav(grafted).map((item) => item.id)).toEqual([
      'dashboard',
      'documents',
      'documents.templates',
      'documents.editor',
      'documents.exports',
    ]);
    expect(graftSubNav(groups[0]!.items, null)).toBe(groups[0]!.items);
  });
});
