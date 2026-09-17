/**
 * The Settings skeleton both panels build on: tabs switch the panel, the
 * remembered tab survives a reload only when it still names a real tab, and
 * the language picker is the one control here that changes the whole product.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppearanceSettings,
  SettingsPage,
  requestSettingsTab,
  useSettingsTab,
} from '../src/SettingsLayout.js';

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

describe('the language picker', () => {
  /**
   * `window.location` is not writable in jsdom, so the whole object is
   * replaced for the duration — `reload` is the only member these tests touch
   * and the component reads nothing else from it.
   */
  const realLocation = window.location;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, reload },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('offers every shipped language, each named in its own script', () => {
    render(<AppearanceSettings />);

    // Deliberately not translated: a picker that renames the language you
    // cannot read into the language you cannot read is useless.
    expect(screen.getByRole('button', { name: 'English' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'हिन्दी' })).toBeTruthy();
  });

  it('stores the choice and reloads, which is the only way the whole panel changes', () => {
    // Before this control existed `ob.locale` was read on every render and
    // written nowhere in the tree, so the Hindi catalogue shipped unreachable.
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));

    expect(window.localStorage.getItem('ob.locale')).toBe('hi');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the language already in use is picked again', () => {
    // Otherwise clicking the highlighted button would throw away whatever
    // somebody had half-typed on another screen, for no change at all.
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ob.locale')).toBeNull();
  });

  it('starts on the stored language rather than always on English', () => {
    window.localStorage.setItem('ob.locale', 'hi');
    render(<AppearanceSettings />);

    expect(screen.getByRole('button', { name: 'हिन्दी' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
