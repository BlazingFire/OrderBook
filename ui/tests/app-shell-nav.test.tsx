/**
 * The sidebar's second tier: an item with children carries a chevron, unfolds
 * on its own while the current page is inside it, folds by hand, and the
 * brand mark goes home. `graftSubNav` hangs an open operation under a child.
 * Escape goes back a step (R8): a record's back button, else Home.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppShell, TopbarTitle, flattenNav, type NavGroup } from '../src/AppShell.js';
import { graftSubNav } from '../src/SubNavSlot.js';
import { t } from '../src/i18n.js';

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

function shell(activeId: string, onNavigate = vi.fn(), homeId?: string, children: ReactNode = <div />) {
  render(
    <AppShell
      groups={groups}
      activeId={activeId}
      onNavigate={onNavigate}
      homeId={homeId}
      collapsed={false}
      onToggleCollapsed={() => undefined}
      topbar={null}
      footer={null}
      rail="synced"
      railLabel=""
      onRailClick={() => undefined}
    >
      {children}
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

  it('sends the brand mark to the dashboard by default', () => {
    const onNavigate = shell('leads.list');
    fireEvent.click(screen.getByRole('button', { name: t('nav.home') }));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('sends the brand mark to the screen this person lands on', () => {
    // Office and Management land on Basic Home, and home is where they land.
    const onNavigate = shell('leads.list', vi.fn(), 'basicHome');
    fireEvent.click(screen.getByRole('button', { name: t('nav.home') }));
    expect(onNavigate).toHaveBeenCalledWith('basicHome');
  });
});

describe('Escape (R8)', () => {
  // jsdom has no `checkVisibility`: answer it from `display`, as `panel-harness.ts` does.
  beforeAll(() => {
    if ('checkVisibility' in Element.prototype) return;
    Object.defineProperty(Element.prototype, 'checkVisibility', {
      configurable: true,
      value(this: Element): boolean {
        if (window.getComputedStyle(this).display === 'none') return false;
        return this.parentElement ? this.parentElement.checkVisibility() : true;
      },
    });
  });

  /** Escape pressed on `target`; true when something claimed it. */
  function pressEscape(init: KeyboardEventInit = {}, target: Element = document.body): boolean {
    return !fireEvent.keyDown(target, { key: 'Escape', ...init });
  }

  it('goes Home from any other page, as the brand mark does', () => {
    const onNavigate = shell('leads.list', vi.fn(), 'basicHome');
    expect(pressEscape()).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith('basicHome');
  });

  it('does nothing at Home', () => {
    const onNavigate = shell('dashboard');
    expect(pressEscape()).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('goes back from a text field too, outside the order form', () => {
    const onNavigate = shell('leads.list', vi.fn(), undefined, <input aria-label="Search" />);
    pressEscape({}, screen.getByLabelText('Search'));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it("clicks an open record's back button rather than going Home", () => {
    const back = vi.fn();
    const onNavigate = shell(
      'leads.open',
      vi.fn(),
      undefined,
      <button type="button" data-esc-back onClick={back}>
        Back
      </button>,
    );
    expect(pressEscape()).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    // As a mouse would: the button has focus, so a field that saves on blur has saved.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }));
  });

  it('ignores a back button in a hidden pane', () => {
    const hidden = vi.fn();
    const shown = vi.fn();
    const onNavigate = shell(
      'leads.open',
      vi.fn(),
      undefined,
      <>
        <button type="button" data-esc-back onClick={shown}>
          Shown
        </button>
        <div style={{ display: 'none' }}>
          <button type="button" data-esc-back onClick={hidden}>
            Hidden
          </button>
        </div>
      </>,
    );
    pressEscape();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(hidden).not.toHaveBeenCalled();
    cleanup();

    // With only the hidden one, there is no record open here: Home.
    const onNavigateAgain = shell(
      'leads.list',
      vi.fn(),
      undefined,
      <div style={{ display: 'none' }}>
        <button type="button" data-esc-back onClick={hidden}>
          Hidden
        </button>
      </div>,
    );
    pressEscape();
    expect(hidden).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onNavigateAgain).toHaveBeenCalledWith('dashboard');
  });

  it.each([
    ['a dialog', <div role="dialog" />],
    ['a popover', <div className="ob-popover" />],
    ['an open list', <div role="listbox" />],
    ['a shortcut being recorded', <button type="button" data-key-capture="true" />],
  ])('leaves the key to %s', (_name, overlay) => {
    const back = vi.fn();
    const onNavigate = shell(
      'leads.open',
      vi.fn(),
      undefined,
      <>
        <button type="button" data-esc-back onClick={back}>
          Back
        </button>
        {overlay}
      </>,
    );
    expect(pressEscape()).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('is not held up by a dialog in a hidden pane', () => {
    const onNavigate = shell(
      'leads.list',
      vi.fn(),
      undefined,
      <div style={{ display: 'none' }}>
        <div role="dialog" />
      </div>,
    );
    pressEscape();
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('ignores a key already claimed, a modifier, a repeat and a composition', () => {
    const onNavigate = shell(
      'leads.list',
      vi.fn(),
      undefined,
      <input aria-label="Claims" onKeyDown={(event) => event.preventDefault()} />,
    );
    pressEscape({}, screen.getByLabelText('Claims'));
    pressEscape({ ctrlKey: true });
    pressEscape({ altKey: true });
    pressEscape({ shiftKey: true });
    pressEscape({ metaKey: true });
    pressEscape({ repeat: true });
    pressEscape({ isComposing: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('leaves the order form alone, even with a back button around it', () => {
    const back = vi.fn();
    for (const escHome of [undefined, 'false']) {
      const onNavigate = shell(
        'leads.open',
        vi.fn(),
        undefined,
        <>
          <button type="button" data-esc-back onClick={back}>
            Cancel
          </button>
          <div className="ob-order-page" data-esc-home={escHome} />
        </>,
      );
      expect(pressEscape()).toBe(false);
      expect(onNavigate).not.toHaveBeenCalled();
      cleanup();
    }
    expect(back).not.toHaveBeenCalled();
  });

  it('goes Home from a New Order form that says it is untouched', () => {
    const back = vi.fn();
    const onNavigate = shell(
      'leads.new',
      vi.fn(),
      'basicHome',
      <>
        <button type="button" data-esc-back onClick={back}>
          Back
        </button>
        <div className="ob-order-page" data-esc-home="true" />
      </>,
    );
    expect(pressEscape()).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith('basicHome');
    expect(back).not.toHaveBeenCalled();
  });
});

describe('TopbarTitle', () => {
  it('heads a page with its module icon, its group and its own name', () => {
    render(<TopbarTitle groups={groups} activeId="leads.followups" fallback="Somewhere" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Follow-ups');
    expect(screen.getByText('Work').className).toContain('ob-eyebrow');
    expect(document.querySelector('.ob-topbar-title svg')).not.toBeNull();
  });

  it('names the module before a sub-page, and not before a module page (U10 G6)', () => {
    render(<TopbarTitle groups={groups} activeId="leads.followups" fallback="Somewhere" />);
    expect(document.querySelector('.ob-topbar-parent')?.textContent).toBe('Leads ›');
    cleanup();

    render(<TopbarTitle groups={groups} activeId="leads" fallback="Somewhere" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Leads');
    expect(document.querySelector('.ob-topbar-parent')).toBeNull();
  });

  it('falls back to the given name for a page with no sidebar entry', () => {
    render(<TopbarTitle groups={groups} activeId="nowhere" fallback="Somewhere" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Somewhere');
    expect(screen.queryByText('Work')).toBeNull();
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
          {
            id: 'leads',
            label: 'Leads',
            icon: 'leads' as const,
            children: [{ id: 'leads.list', label: 'List', icon: 'leads' as const }],
          },
          {
            id: 'orders',
            label: 'Orders',
            icon: 'orders' as const,
            children: [{ id: 'orders.all', label: 'All stages', icon: 'orders' as const }],
          },
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
