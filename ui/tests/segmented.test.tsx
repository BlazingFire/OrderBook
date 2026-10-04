/**
 * `Segmented`: a group of toggle buttons. The audit (Party Access D2.5) found it nameless to a
 * screen reader and unable to be switched off; both are covered here, with the behaviour every
 * one of its twenty-odd callers relies on.
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Segmented } from '../src/Tabs.js';

afterEach(cleanup);

function Level({ disabled, label }: { disabled?: boolean; label?: string }) {
  const [value, setValue] = useState<'view' | 'manage'>('view');
  return (
    <Segmented
      value={value}
      onChange={setValue}
      label={label}
      disabled={disabled}
      options={[
        { value: 'view', label: 'View' },
        { value: 'manage', label: 'Manage' },
      ]}
    />
  );
}

describe('Segmented', () => {
  it('marks the chosen option pressed and moves the choice on a click', () => {
    render(<Level />);
    expect(screen.getByRole('button', { name: 'View' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByRole('button', { name: 'Manage' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'View' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('names its group, so a screen reader hears whose level it is', () => {
    render(<Level label="Access level for Ravi" />);
    expect(screen.getByRole('group', { name: 'Access level for Ravi' })).toBeTruthy();
  });

  it('can be switched off: no button reacts', () => {
    render(<Level disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect((screen.getByRole('button', { name: 'Manage' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'View' }).getAttribute('aria-pressed')).toBe('true');
  });
});
