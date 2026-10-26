/**
 * SearchField, InlineEdit, UserMenu, SwipeActions, Reactions — kit-native Arc
 * patterns. Keyboard access, i18n strings, reduced-motion branches.
 */

import type React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InlineEdit } from '../src/InlineEdit.js';
import { Reactions } from '../src/Reactions.js';
import { SearchField } from '../src/SearchField.js';
import { SwipeActions, SwipeActionsRow } from '../src/SwipeActions.js';
import { UserMenu } from '../src/UserMenu.js';

afterEach(cleanup);

describe('SearchField', () => {
  it('is labelled, clearable, and clears with the clear button', () => {
    let value = 'Morbi';
    let rerenderView: ((node: React.ReactElement) => void) | null = null;
    const onValueChange = (next: string) => {
      value = next;
      rerenderView?.(<SearchField label="Search parties" value={value} onValueChange={onValueChange} />);
    };
    const { rerender } = render(
      <SearchField label="Search parties" value={value} onValueChange={onValueChange} />,
    );
    rerenderView = rerender;
    expect(screen.getByLabelText('Search parties')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect((screen.getByLabelText('Search parties') as HTMLInputElement).value).toBe('');
  });
});

describe('InlineEdit', () => {
  it('renames in place, saves on Enter, cancels on Escape', async () => {
    const onSave = vi.fn(async () => undefined);
    const { rerender } = render(<InlineEdit label="Task" value="Dust shelves" onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Task: Dust shelves' }));
    const field = screen.getByLabelText('Task') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Mop floor' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Mop floor'));
    // Controlled: the parent hands the saved value back in.
    rerender(<InlineEdit label="Task" value="Mop floor" onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Task: Mop floor' })).toBeTruthy();
  });

  it('rolls back and shows the error when saving fails', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('offline');
    });
    const { rerender } = render(<InlineEdit label="Task" value="Dust shelves" onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Task: Dust shelves' }));
    const field = screen.getByLabelText('Task') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Mop floor' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Rolled back to the saved value, still editing so the person can retry.
    expect((screen.getByLabelText('Task') as HTMLInputElement).value).toBe('Dust shelves');
    // Cancelling lands back on the text.
    fireEvent.keyDown(screen.getByLabelText('Task'), { key: 'Escape' });
    rerender(<InlineEdit label="Task" value="Dust shelves" onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Task: Dust shelves' })).toBeTruthy();
  });
});

describe('UserMenu', () => {
  it('opens the account menu with theme and sign out', async () => {
    const onSignOut = vi.fn();
    render(<UserMenu name="Owner" email="o@shop" role="Admin" onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu, Owner' }));
    expect(await screen.findByRole('menu', { name: 'Account menu, Owner' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('SwipeActions', () => {
  it('reveals the same actions in the More menu without swiping', () => {
    const onSelect = vi.fn();
    render(
      <SwipeActions label="Jobs">
        <SwipeActionsRow
          label="Sharma Tiles"
          trailing={[{ label: 'Print', icon: 'print', onSelect }]}
        >
          <span>row</span>
        </SwipeActionsRow>
      </SwipeActions>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Sharma Tiles' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('Reactions', () => {
  it('toggles a reaction and announces the count', () => {
    const onValueChange = vi.fn();
    render(
      <Reactions
        options={[{ id: 'seen', label: 'Seen', icon: 'eye' }]}
        defaultValue={[{ id: 'seen', count: 2, reacted: false }]}
        onValueChange={onValueChange}
      />,
    );
    const pill = screen.getByRole('button', { name: 'Seen, 2 reactions' });
    fireEvent.click(pill);
    expect(onValueChange).toHaveBeenCalledWith(
      [{ id: 'seen', count: 3, reacted: true }],
      { id: 'seen', reacted: true },
    );
  });
});
