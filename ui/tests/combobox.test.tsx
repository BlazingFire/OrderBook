/**
 * `Combobox`: the keyboard, the empty and loading states, the long-list behaviour, and focus.
 * Found by the Party Access dropdown audit (D2.5); each case here is one defect that audit
 * fixed, or one promise it kept.
 */

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Combobox, type ComboboxOption } from '../src/Combobox.js';
import { t } from '../src/i18n.js';

const scrolled = vi.fn();

beforeEach(() => {
  scrolled.mockClear();
  Element.prototype.scrollIntoView = scrolled;
});
afterEach(cleanup);

const PEOPLE: ComboboxOption<string>[] = [
  { key: 'a', label: 'Asha Rao', value: 'a', hint: 'Sales' },
  { key: 'b', label: 'Bela Shah', value: 'b', hint: 'Dispatch' },
  { key: 'c', label: 'Chirag Mehta', value: 'c', hint: 'Sales' },
];

function field(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement;
}

const rows = () => screen.queryAllByRole('option');

function setup(props: Partial<Parameters<typeof Combobox<string>>[0]> = {}) {
  const picked: string[] = [];
  render(
    <Combobox<string>
      options={PEOPLE}
      ariaLabel="Add a person"
      onSelect={(option) => picked.push(option.value)}
      {...props}
    />,
  );
  return picked;
}

describe('Combobox: filtering', () => {
  it('filters on the label and on the hint, case-insensitively', () => {
    setup();
    fireEvent.change(field(), { target: { value: 'BEL' } });
    expect(rows().map((row) => row.textContent)).toEqual(['Bela ShahDispatch']);

    // A role is a hint, and typing it finds everybody with that role.
    fireEvent.change(field(), { target: { value: 'sales' } });
    expect(rows().map((row) => row.textContent)).toEqual(['Asha RaoSales', 'Chirag MehtaSales']);
  });

  it('gives a long name a title with the whole of it, and keeps it on one line', () => {
    const long = 'Venkata Subramaniam Ramachandran Iyer-Natarajan';
    setup({ options: [{ key: 'l', label: long, value: 'l', hint: 'Regional manager' }] });
    fireEvent.focus(field());
    const row = rows()[0]!;
    expect(row.title).toBe(`${long} · Regional manager`);
    expect(within(row).getByText(long).className).toContain('ob-combobox-label');
  });
});

describe('Combobox: the keyboard', () => {
  it('opens on ArrowDown at the first row, then moves, and Enter picks', () => {
    const picked = setup();
    field().focus();
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(rows()).toHaveLength(0);

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.getAttribute('data-active')).toBe('true');

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(rows()[1]!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(picked).toEqual(['b']);
  });

  it('ArrowUp moves the highlight up and stops at the first row; PageUp jumps a page and stops there', () => {
    setup({
      options: Array.from({ length: 30 }, (_, at) => ({ key: `k${at}`, label: `Person ${at}`, value: `${at}` })),
    });
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: 'End' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(rows()[28]!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(field(), { key: 'PageUp' });
    expect(rows()[20]!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Home' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    fireEvent.keyDown(field(), { key: 'PageUp' });
    expect(rows()[0]!.getAttribute('data-active')).toBe('true');
  });

  it('keeps aria-activedescendant on the highlighted row', () => {
    setup();
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    const highlighted = rows()[1]!;
    expect(field().getAttribute('aria-activedescendant')).toBe(highlighted.id);
    expect(field().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
  });

  it('does not pick from a list that is closed (Enter after Escape picks nothing)', () => {
    const picked = setup();
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: 'Escape' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(picked).toEqual([]);
  });

  it('Home, End and PageDown move the highlight and stop at the ends', () => {
    setup({
      options: Array.from({ length: 30 }, (_, at) => ({ key: `k${at}`, label: `Person ${at}`, value: `${at}` })),
    });
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: 'End' });
    expect(rows().at(-1)!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(rows().at(-1)!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Home' });
    expect(rows()[0]!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(field(), { key: 'PageDown' });
    expect(rows()[8]!.getAttribute('data-active')).toBe('true');
  });

  it('scrolls the highlighted row into view when the keyboard moves it, not when the mouse does', () => {
    setup();
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(scrolled).toHaveBeenCalled();

    scrolled.mockClear();
    fireEvent.mouseEnter(rows()[0]!);
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('Combobox: Escape belongs to the list first, the dialog second', () => {
  it('claims Escape (defaultPrevented) only while a list is open', () => {
    setup();
    fireEvent.focus(field());

    const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      field().dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(0);

    const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      field().dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
  });
});

describe('Combobox: focus', () => {
  it('keeps the caret in the field after a pick by keyboard and by mouse, and clears the query', () => {
    const picked = setup();
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'chir' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(picked).toEqual(['c']);
    expect(field().value).toBe('');

    fireEvent.focus(field());
    fireEvent.mouseDown(rows()[0]!);
    expect(picked).toEqual(['c', 'a']);
  });

  it('puts the caret back in the field after a pick that took it away', () => {
    setup();
    fireEvent.focus(field());
    // A browser that moved focus off the field on the click: the pick must hand it back.
    act(() => field().blur());
    expect(document.activeElement).not.toBe(field());

    fireEvent.mouseDown(rows()[1]!);
    expect(document.activeElement).toBe(field());
  });

  it('closes the list when focus leaves the field (Tab), but not when the pointer is on a row', () => {
    render(
      <>
        <Combobox<string> options={PEOPLE} ariaLabel="Add" onSelect={() => undefined} />
        <button type="button">next</button>
      </>,
    );
    fireEvent.focus(field());
    expect(rows()).toHaveLength(3);

    fireEvent.blur(field(), { relatedTarget: rows()[0] });
    expect(rows()).toHaveLength(3);

    fireEvent.blur(field(), { relatedTarget: screen.getByText('next') });
    expect(rows()).toHaveLength(0);
  });
});

describe('Combobox: focus from code', () => {
  it('does not open on the one focus the host marks quiet, and opens on the next', () => {
    const quiet = { current: true };
    setup({ quietFocusRef: quiet });
    fireEvent.focus(field());
    expect(rows()).toHaveLength(0);
    expect(quiet.current).toBe(false);
    fireEvent.focus(field());
    expect(rows()).toHaveLength(3);
  });
});

describe('Combobox: empty, loading and long lists', () => {
  it('says everybody is already chosen when there was nothing to offer, and "No matches" when a filter found nothing', () => {
    const { rerender } = render(
      <Combobox<string> options={[]} ariaLabel="Add" emptyLabel="Everyone is already assigned" onSelect={() => undefined} />,
    );
    fireEvent.focus(field());
    expect(screen.getByText('Everyone is already assigned')).toBeTruthy();

    rerender(<Combobox<string> options={PEOPLE} ariaLabel="Add" emptyLabel="Everyone is already assigned" onSelect={() => undefined} />);
    fireEvent.change(field(), { target: { value: 'zzz' } });
    expect(screen.getByText(t('common.noMatches'))).toBeTruthy();
    expect(screen.queryByText('Everyone is already assigned')).toBeNull();
  });

  it('hands every change of the query to a host that searches, and shows what the host found', () => {
    const queries: string[] = [];
    function Host() {
      const [found, setFound] = useState<ComboboxOption<string>[]>([]);
      return (
        <Combobox<string>
          options={found}
          filter={false}
          ariaLabel="Find"
          onQueryChange={(query) => {
            queries.push(query);
            // The label does not contain the query: only `filter={false}` keeps it on screen.
            setFound(query ? [{ key: query, label: 'Rajesh Patel', value: query }] : []);
          }}
          onSelect={() => undefined}
        />
      );
    }
    render(<Host />);
    fireEvent.change(field(), { target: { value: 'ra' } });
    fireEvent.change(field(), { target: { value: 'xq' } });
    // `filter={false}`: the host's answer is shown as it is, although it does not contain the query.
    expect(rows().map((row) => row.textContent)).toEqual(['Rajesh Patel']);
    expect(queries).toEqual(['ra', 'xq']);
  });

  it('shows Searching… while the host is fetching and nothing has come back yet', () => {
    setup({ options: [], loading: true, filter: false });
    fireEvent.focus(field());
    expect(screen.getByText(t('common.searching'))).toBeTruthy();
  });

  it('shows the first 200 matches and says so', () => {
    setup({
      options: Array.from({ length: 260 }, (_, at) => ({ key: `k${at}`, label: `Person ${at}`, value: `${at}` })),
    });
    fireEvent.focus(field());
    expect(rows()).toHaveLength(200);
    expect(screen.getByText(t('common.refineSearch', { count: 200 }))).toBeTruthy();
  });
});
