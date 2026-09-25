/**
 * Which handler a chord reaches, and whether every chord the palette offers
 * does something.
 *
 * The first half pins the rule `record.save` depends on: a dialog mounted
 * inside a screen answers Ctrl+S while it is open, however many times the tree
 * has re-rendered or re-run its effects since. `useCommand` used to re-push its
 * registration whenever the provider's api object changed identity — which it
 * does on every palette or help-sheet open and close — and React re-runs
 * effects children first, so the screen behind an open `PartyFormModal` ended
 * up above it and Ctrl+S saved the lead instead of the party. A screen hidden
 * and shown again by `<Activity>`, or a parent whose handler came back from
 * `null`, did the same.
 *
 * The second half pins two chords that had no reader: `view.toggleSidebar`
 * flipped a `data-sidebar-collapsed` attribute nothing styled, and a palette
 * row runs its command through `run()`, which never reached the provider's own
 * keydown switch — so "Keyboard shortcuts" and "Toggle sidebar" picked from the
 * palette did nothing at all.
 *
 * The last half pins what the palette lists: only commands that would do
 * something now. It used to list every screen in the panel's nav, including
 * the ones the sidebar does not offer this person (picking one closed the
 * palette and did nothing), "New record" for a role that cannot create one,
 * and "Find", which only the chord answers.
 */

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppShell } from '../src/AppShell.js';
import { KeyboardOverlays } from '../src/CommandPalette.js';
import { KeyboardProvider, useCommand, useKeyboard } from '../src/KeyboardProvider.js';
import { ScreenHost } from '../src/ScreenHost.js';
import { t } from '../src/i18n.js';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

function press(init: Partial<KeyboardEventInit> & { key: string; code: string }): void {
  act(() => {
    fireEvent.keyDown(document.body, { ctrlKey: true, ...init });
  });
}

const ctrlS = () => press({ key: 's', code: 'KeyS' });
const ctrlK = () => press({ key: 'k', code: 'KeyK' });
const ctrlSlash = () => press({ key: '/', code: 'Slash' });

/**
 * Stands in for `PartyFormModal`: always mounted, and answering `record.save`
 * only while open. Deliberately not a `role="dialog"` — `record.save` is a
 * global command, so the modality filter is not what is under test, and jsdom
 * has no `checkVisibility` for that filter to call.
 */
function Dialog({ open, log }: { open: boolean; log: string[] }) {
  useCommand('record.save', open ? () => log.push('dialog') : null);
  return open ? <div data-testid="dialog" /> : null;
}

/** Stands in for `AddLeadScreen`, which registers its own `record.save`. */
function Screen({
  dialogOpen,
  busy = false,
  log,
}: {
  dialogOpen: boolean;
  busy?: boolean;
  log: string[];
}) {
  useCommand('record.save', busy ? null : () => log.push('screen'));
  return <Dialog open={dialogOpen} log={log} />;
}

/** Reads and drives the provider's state the way the palette and help sheet do. */
function Probe() {
  const keyboard = useKeyboard();
  return (
    <div>
      <span data-testid="palette">{String(keyboard.paletteOpen)}</span>
      <span data-testid="help">{String(keyboard.helpOpen)}</span>
      <button type="button" onClick={() => keyboard.setPaletteOpen(false)}>
        close palette
      </button>
      <button type="button" onClick={() => keyboard.setHelpOpen(false)}>
        close help
      </button>
      <button type="button" onClick={() => keyboard.run('keys.help')}>
        run help
      </button>
      <button type="button" onClick={() => keyboard.run('view.toggleSidebar')}>
        run sidebar
      </button>
    </div>
  );
}

describe('useCommand priority', () => {
  it('keeps an open dialog above its screen after the palette opens and closes', () => {
    const log: string[] = [];
    const { rerender } = render(
      <KeyboardProvider panel="office">
        <Probe />
        <Screen dialogOpen={false} log={log} />
      </KeyboardProvider>,
    );

    ctrlS();
    expect(log).toEqual(['screen']);

    rerender(
      <KeyboardProvider panel="office">
        <Probe />
        <Screen dialogOpen log={log} />
      </KeyboardProvider>,
    );
    ctrlS();
    expect(log.at(-1)).toBe('dialog');

    // Ctrl+K is global, so it opens the palette over the dialog.
    ctrlK();
    expect(screen.getByTestId('palette').textContent).toBe('true');
    fireEvent.click(screen.getByText('close palette'));
    expect(screen.getByTestId('palette').textContent).toBe('false');

    ctrlS();
    expect(log.at(-1)).toBe('dialog');

    // The help sheet changes the same state, and is global too.
    ctrlSlash();
    expect(screen.getByTestId('help').textContent).toBe('true');
    fireEvent.click(screen.getByText('close help'));

    ctrlS();
    expect(log.at(-1)).toBe('dialog');
  });

  it('keeps the dialog on top when the screen’s own handler comes back from null', () => {
    const log: string[] = [];
    const tree = (busy: boolean) => (
      <KeyboardProvider panel="office">
        <Screen dialogOpen busy={busy} log={log} />
      </KeyboardProvider>
    );
    const { rerender } = render(tree(true));

    ctrlS();
    expect(log).toEqual(['dialog']);

    // The screen finishing a save re-registers it; the dialog is still open.
    rerender(tree(false));
    ctrlS();
    expect(log.at(-1)).toBe('dialog');
  });

  it('keeps the dialog on top after its screen is hidden and shown again', async () => {
    const log: string[] = [];
    const tree = (activeId: string, dialogOpen: boolean) => (
      <KeyboardProvider panel="office">
        <ScreenHost
          activeId={activeId}
          screens={[
            { id: 'lead', render: () => <Screen dialogOpen={dialogOpen} log={log} /> },
            { id: 'orders', render: () => <div /> },
          ]}
        />
      </KeyboardProvider>
    );
    const { rerender } = render(tree('lead', false));
    rerender(tree('lead', true));

    ctrlS();
    expect(log).toEqual(['dialog']);

    // The palette can navigate away with the dialog still open, and coming
    // back re-runs every effect on the pane — children first.
    await act(async () => rerender(tree('orders', true)));
    await act(async () => rerender(tree('lead', true)));

    ctrlS();
    expect(log.at(-1)).toBe('dialog');
  });

  it('answers from a dialog that mounted open with its screen, then falls through', () => {
    const log: string[] = [];
    const tree = (open: boolean) => (
      <KeyboardProvider panel="office">
        <Screen dialogOpen={open} log={log} />
      </KeyboardProvider>
    );
    const { rerender } = render(tree(true));

    ctrlS();
    rerender(tree(false));
    ctrlS();

    expect(log).toEqual(['dialog', 'screen']);
  });
});

/** Both panels resolve `collapsed` from their own state; this is that, reduced. */
function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <KeyboardProvider panel="master">
      <AppShell
        groups={[
          { label: 'Work', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }] },
        ]}
        activeId="dashboard"
        onNavigate={() => undefined}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
        topbar={null}
        footer={null}
        rail="synced"
        railLabel=""
        onRailClick={() => undefined}
      >
        <Probe />
      </AppShell>
    </KeyboardProvider>
  );
}

function sidebarCollapsed(): boolean {
  return (
    document.querySelector('.ob-sidebar')?.classList.contains('ob-sidebar--collapsed') ?? false
  );
}

describe('commands the provider answers itself', () => {
  it('collapses and expands the sidebar on its chord', () => {
    render(<Shell />);
    expect(sidebarCollapsed()).toBe(false);

    press({ key: '\\', code: 'Backslash' });
    expect(sidebarCollapsed()).toBe(true);

    press({ key: '\\', code: 'Backslash' });
    expect(sidebarCollapsed()).toBe(false);
  });

  it('runs a palette row the same as its chord', () => {
    render(<Shell />);

    fireEvent.click(screen.getByText('run sidebar'));
    expect(sidebarCollapsed()).toBe(true);

    fireEvent.click(screen.getByText('run help'));
    expect(screen.getByTestId('help').textContent).toBe('true');
  });
});

function OpenPalette() {
  const keyboard = useKeyboard();
  return (
    <button type="button" onClick={() => keyboard.setPaletteOpen(true)}>
      open palette
    </button>
  );
}

describe('what the palette lists', () => {
  function rowLabels(): string[] {
    return [...document.querySelectorAll('.ob-navitem-label')].map((row) => row.textContent ?? '');
  }

  it('lists only the commands that would do something now', () => {
    const went: string[] = [];
    render(
      <KeyboardProvider
        panel="master"
        onNavigate={(tab) => went.push(tab)}
        canNavigate={(tab) => tab === 'dashboard' || tab === 'orders'}
        shellCommands={{ 'view.refresh': () => undefined, 'record.new': null }}
      >
        <Screen dialogOpen={false} log={[]} />
        <OpenPalette />
        <KeyboardOverlays />
      </KeyboardProvider>,
    );
    fireEvent.click(screen.getByText('open palette'));
    const labels = rowLabels();

    // Offered by the sidebar, answered by the shell, the screen or the provider.
    expect(labels).toContain(t('nav.master.dashboard'));
    expect(labels).toContain(t('nav.master.leadsOrders'));
    expect(labels).toContain(t('keys.command.refresh'));
    expect(labels).toContain(t('keys.command.save'));
    expect(labels).toContain(t('keys.command.help'));

    // Not offered to this person, withheld from this role, or chord-only.
    expect(labels).not.toContain(t('nav.master.panels'));
    expect(labels).not.toContain(t('nav.master.access'));
    expect(labels).not.toContain(t('keys.command.new'));
    expect(labels).not.toContain(t('keys.command.find'));

    fireEvent.click(screen.getByText(t('nav.master.leadsOrders')));
    expect(went).toEqual(['orders']);
  });

  it('drops a screen’s command while the screen has nothing to do', () => {
    render(
      <KeyboardProvider panel="office">
        <Screen dialogOpen={false} busy log={[]} />
        <OpenPalette />
        <KeyboardOverlays />
      </KeyboardProvider>,
    );
    fireEvent.click(screen.getByText('open palette'));

    expect(rowLabels()).not.toContain(t('keys.command.save'));
  });
});
