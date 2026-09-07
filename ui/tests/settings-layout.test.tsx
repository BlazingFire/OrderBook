/**
 * The Settings skeleton both panels build on: tabs switch the panel, and the
 * remembered tab survives a reload only when it still names a real tab.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsPage, requestSettingsTab, useSettingsTab } from '../src/SettingsLayout.js';

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const TABS = [
  { id: 'appearance', label: 'Appearance', render: () => <div data-testid="pane-appearance" /> },
  { id: 'developer', label: 'Developer', render: () => <div data-testid="pane-developer" /> },
];
const IDS = TABS.map((tab) => tab.id);

/** A screen the way both panels write one: the hook feeds the page. */
function Harness({ storageKey = 'ob.settings.tab.test' }: { storageKey?: string }) {
  const [active, setActive] = useSettingsTab(storageKey, IDS, 'appearance');
  return (
    <>
      {/* The hook's own answer, separately from the page — which falls back to
          the first tab on its own and would hide a hook that stopped validating. */}
      <span data-testid="active">{active}</span>
      <SettingsPage title="Settings" tabs={TABS} activeId={active} onChange={setActive} />
    </>
  );
}

describe('SettingsPage', () => {
  it('renders every tab and only the active panel', () => {
    render(<SettingsPage title="Settings" tabs={TABS} activeId="appearance" onChange={() => {}} />);

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByTestId('pane-appearance')).toBeTruthy();
    // A hidden tab's content is not rendered at all — its data is not fetched
    // until somebody opens it.
    expect(screen.queryByTestId('pane-developer')).toBeNull();
  });

  it('switches the panel when a tab is clicked', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('tab', { name: 'Developer' }));

    expect(screen.getByTestId('pane-developer')).toBeTruthy();
    expect(screen.queryByTestId('pane-appearance')).toBeNull();
  });
});

describe('useSettingsTab', () => {
  it('remembers the chosen tab in localStorage and restores it', () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Developer' }));
    expect(window.localStorage.getItem('ob.settings.tab.test')).toBe('developer');
    first.unmount();

    render(<Harness />);
    expect(screen.getByTestId('pane-developer')).toBeTruthy();
  });

  it('ignores a stored id that names no tab', () => {
    // A permission withdrawn, or a tab renamed: the stored id outlives it.
    window.localStorage.setItem('ob.settings.tab.test', 'company');

    render(<Harness />);

    expect(screen.getByTestId('active').textContent).toBe('appearance');
    expect(screen.getByTestId('pane-appearance')).toBeTruthy();
  });

  it('takes an external request, including one made before it mounted', async () => {
    // The shell's Help menu fires while the operator is on another screen;
    // the request must wait for the Settings screen rather than be lost.
    requestSettingsTab('developer');
    render(<Harness />);
    expect(screen.getByTestId('pane-developer')).toBeTruthy();

    await act(async () => requestSettingsTab('appearance'));
    expect(screen.getByTestId('pane-appearance')).toBeTruthy();
  });
});
