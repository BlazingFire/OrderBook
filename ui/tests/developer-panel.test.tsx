/**
 * The Developer tab without a server behind it: the locked form hands the
 * password up, the unlocked view lists the tools, and a tool that erases
 * something stays disabled until the confirmation word is typed exactly.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeveloperStatus } from '@orderbook/shared';

import { DeveloperPanel, type DeveloperTool } from '../src/SettingsLayout.js';

afterEach(cleanup);

const LOCKED: DeveloperStatus = { unlocked: false, expiresAt: null, passwordOverridden: false };

function unlockedFor(seconds: number): DeveloperStatus {
  return {
    unlocked: true,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    passwordOverridden: false,
  };
}

function tool(overrides: Partial<DeveloperTool> = {}): DeveloperTool {
  return {
    id: 'wipe',
    title: 'Wipe',
    description: 'Erases the lot',
    action: 'Wipe now',
    run: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof DeveloperPanel>[0]> = {}) {
  const onUnlock = vi.fn(async () => undefined);
  const onLock = vi.fn(async () => undefined);
  const utils = render(
    <DeveloperPanel
      status={LOCKED}
      busy={false}
      error={null}
      onUnlock={onUnlock}
      onLock={onLock}
      tools={[]}
      {...props}
    />,
  );
  return { ...utils, onUnlock, onLock };
}

describe('DeveloperPanel, locked', () => {
  it('submits the typed password to onUnlock', async () => {
    const { onUnlock } = renderPanel();

    const field = screen.getByLabelText(/password/i, { selector: 'input' }) as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'Dev@OrderBook2026' } });
    await act(async () => {
      fireEvent.submit(field.closest('form') as HTMLFormElement);
    });

    expect(onUnlock).toHaveBeenCalledWith('Dev@OrderBook2026');
  });

  it('shows the error it is given', () => {
    renderPanel({ error: 'That developer password is not right' });
    expect(screen.getByRole('alert').textContent).toContain('not right');
  });

  it('treats an expired unlock as locked', () => {
    renderPanel({ status: unlockedFor(-5), tools: [tool()] });
    expect(screen.queryByText('Wipe now')).toBeNull();
    expect(screen.getByLabelText(/password/i, { selector: 'input' })).toBeTruthy();
  });
});

describe('DeveloperPanel, unlocked', () => {
  it('lists the tools and offers Lock', async () => {
    const plain = tool({ id: 'seed', title: 'Seed', action: 'Seed now' });
    const { onLock } = renderPanel({ status: unlockedFor(600), tools: [plain] });

    expect(screen.getByText('Seed')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('Seed now'));
    });
    expect(plain.run).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText(/^Lock$/i));
    });
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmWord tool disabled until the word matches exactly', async () => {
    const danger = tool({ danger: true, confirmWord: 'RESET', confirmDetails: ['The database'] });
    renderPanel({ status: unlockedFor(600), tools: [danger] });

    fireEvent.click(screen.getByText('Wipe now'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('The database');

    const confirm = screen
      .getAllByText('Wipe now')
      .map((el) => el.closest('button') as HTMLButtonElement)
      .find((button) => dialog.contains(button)) as HTMLButtonElement;
    const input = dialog.querySelector('input') as HTMLInputElement;
    expect(confirm.disabled).toBe(true);

    // Case matters: a confirmation that accepts `reset` is not a confirmation.
    fireEvent.change(input, { target: { value: 'reset' } });
    expect(confirm.disabled).toBe(true);
    expect(danger.run).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'RESET' } });
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(danger.run).toHaveBeenCalledTimes(1);
  });

  it('shows the unavailable line instead of a button', () => {
    renderPanel({
      status: unlockedFor(600),
      tools: [tool({ unavailable: 'Open this panel in its desktop app to uninstall it' })],
    });
    expect(screen.queryByText('Wipe now')).toBeNull();
    expect(screen.getByText(/desktop app/)).toBeTruthy();
  });
});
