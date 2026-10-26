/**
 * The Arc action patterns built natively in the kit: ActionButton, ActionSwap,
 * HoldToConfirm, CopyButton, ButtonGroup. Native buttons, i18n strings,
 * reduced-motion safe; no motion/lucide/radix deps.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionButton, ActionSwap, ButtonGroup, CopyButton, HoldToConfirm } from '../src/ActionButtons.js';

afterEach(cleanup);

describe('ActionButton', () => {
  it('runs the action, shows pending then success, and resets to idle', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    render(
      <ActionButton
        label="Save"
        pendingLabel="Saving"
        successLabel="Saved"
        resetAfterMs={10}
        onAction={() => gate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Saving' })).toBeTruthy();
    resolve();
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy());
  });

  it('returns to idle and reports the error when the action rejects', async () => {
    const onActionError = vi.fn();
    render(
      <ActionButton label="Save" onAction={() => Promise.reject(new Error('nope'))} onActionError={onActionError} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy());
    expect(onActionError).toHaveBeenCalledTimes(1);
  });
});

describe('ActionSwap', () => {
  const states = [
    { id: 'follow', label: 'Follow' },
    { id: 'following', label: 'Following', tone: 'accent' as const },
  ];

  it('steps through states on press and reports the value', () => {
    const onValueChange = vi.fn();
    render(<ActionSwap states={states} onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(screen.getByRole('button', { name: 'Following' })).toBeTruthy();
    expect(onValueChange).toHaveBeenCalledWith('following', states[1]);
  });

  it('shows the failure label on rejection and stays put', async () => {
    render(
      <ActionSwap states={states} failureLabel="Retry" onAction={() => Promise.reject(new Error('no'))} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('HoldToConfirm', () => {
  it('confirms after a held press and shows the done label', async () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm label="Hold to delete" duration={30} onConfirm={onConfirm} />);
    const button = screen.getByRole('button', { name: 'Hold to delete' });
    fireEvent.pointerDown(button);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('rewinds on early release without confirming', async () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm label="Hold to delete" duration={5000} onConfirm={onConfirm} />);
    const button = screen.getByRole('button', { name: 'Hold to delete' });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    await new Promise((done) => setTimeout(done, 50));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Hold to delete' })).toBeTruthy();
  });
});

describe('CopyButton', () => {
  it('copies the value and confirms in place, then resets', async () => {
    let clipboard = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { clipboard = text; } },
    });
    render(<CopyButton value="P-0042" label="Copy code" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(await screen.findByRole('button', { name: 'Copy code: Copied' })).toBeTruthy();
    expect(clipboard).toBe('P-0042');
  });

  it('icon-only names itself by the label', () => {
    render(<CopyButton value="x" iconOnly />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});

describe('ButtonGroup', () => {
  it('renders segments with one group label and runs onSelect', () => {
    const onSelect = vi.fn();
    render(
      <ButtonGroup
        label="Record"
        items={[
          { id: 'edit', label: 'Edit', onSelect },
          { id: 'delete', label: 'Delete', destructive: true, onSelect },
        ]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Record' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
