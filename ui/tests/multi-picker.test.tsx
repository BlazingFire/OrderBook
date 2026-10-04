/**
 * `MultiPicker`: a searchable checklist ("Add several people"). Keyboard from the search box,
 * the selection owned by the host, and Escape that clears a typed search before it closes a dialog.
 */

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MultiPicker, type MultiPickerOption } from '../src/MultiPicker.js';
import { t } from '../src/i18n.js';

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(cleanup);

const OPTIONS: MultiPickerOption[] = [
  { key: 'a', label: 'Asha Rao', hint: 'Sales' },
  { key: 'b', label: 'Bela Shah', hint: 'Dispatch' },
  { key: 'c', label: 'Chirag Mehta', hint: 'Sales' },
];

let selection: Set<string> = new Set();

function Host({ options = OPTIONS }: { options?: MultiPickerOption[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  selection = selected;
  return (
    <MultiPicker
      options={options}
      selected={selected}
      onChange={setSelected}
      ariaLabel="People"
      searchPlaceholder="Search"
      emptyLabel="Everyone is already assigned"
    />
  );
}

const search = () => screen.getByRole('combobox') as HTMLInputElement;
const rows = () => screen.getAllByRole('option');

describe('MultiPicker', () => {
  it('ticks a row on a click, unticks it on the next, and counts what is ticked', () => {
    render(<Host />);
    fireEvent.click(rows()[0]!);
    fireEvent.click(rows()[2]!);
    expect([...selection].sort()).toEqual(['a', 'c']);
    expect(screen.getByText(t('multiPicker.selected', { count: 2 }))).toBeTruthy();

    fireEvent.click(rows()[0]!);
    expect([...selection]).toEqual(['c']);
  });

  it('filters on the name and on the hint, and "select all shown" ticks only what is shown', () => {
    render(<Host />);
    fireEvent.change(search(), { target: { value: 'sales' } });
    expect(rows().map((row) => row.getAttribute('title'))).toEqual(['Asha Rao · Sales', 'Chirag Mehta · Sales']);

    fireEvent.click(screen.getByRole('button', { name: t('multiPicker.selectShown') }));
    expect([...selection].sort()).toEqual(['a', 'c']);
    // Everything shown is ticked: the button has nothing left to do.
    expect((screen.getByRole('button', { name: t('multiPicker.selectShown') }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: t('multiPicker.clear') }));
    expect(selection.size).toBe(0);
  });

  it('works from the search box: arrows move, Enter ticks, Ctrl+A ticks all shown', () => {
    render(<Host />);
    search().focus();
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(rows()[1]!.getAttribute('data-active')).toBe('true');
    expect(search().getAttribute('aria-activedescendant')).toBe(rows()[1]!.id);
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect([...selection]).toEqual(['b']);

    fireEvent.keyDown(search(), { key: 'a', ctrlKey: true });
    expect([...selection].sort()).toEqual(['a', 'b', 'c']);
    fireEvent.keyDown(search(), { key: 'End' });
    expect(rows()[2]!.getAttribute('data-active')).toBe('true');
  });

  it('leaves the caret in the search box when a row is clicked', () => {
    render(<Host />);
    act(() => search().focus());
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      rows()[0]!.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
  });

  it('clears a typed search on Escape and only then lets the dialog have the key', () => {
    render(<Host />);
    fireEvent.change(search(), { target: { value: 'be' } });

    const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      search().dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(true);
    expect(search().value).toBe('');

    const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      search().dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
  });

  it('says why the list is empty: nothing to offer, or nothing matching', () => {
    const { unmount } = render(<Host options={[]} />);
    expect(screen.getByText('Everyone is already assigned')).toBeTruthy();
    unmount();

    render(<Host />);
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.getByText(t('common.noMatches'))).toBeTruthy();
  });
});
