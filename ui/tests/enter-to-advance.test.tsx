/**
 * The Enter/Escape walk the New Lead screen runs on.
 *
 * Four behaviours worth pinning, because each one was a decision rather than a
 * default: Enter goes forward and Escape comes back, buttons are stepped over
 * instead of being landed on, a select opens its list before it is left, and
 * Escape on the first field is not consumed — an overlay or a suggestion list
 * above it still needs that key.
 */

import { useRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { useEnterToAdvance, useEscapeToPrevious } from '../src/useEnterToAdvance.js';

afterEach(cleanup);

const showPicker = vi.fn();

beforeAll(() => {
  // jsdom has no `showPicker`, so without this every select would fall through
  // to the plain advance and the "open the list first" branch would never run.
  (HTMLSelectElement.prototype as unknown as { showPicker: () => void }).showPicker = showPicker;
});

function Form({ onSubmit }: { onSubmit?: () => void }) {
  const fields = useRef<HTMLDivElement>(null);
  useEnterToAdvance(fields, onSubmit);
  useEscapeToPrevious(fields);
  return (
    <div ref={fields}>
      {/*
       * A field with an Enter of its own, like the real party search box
       * choosing the row its list has highlighted. React delegates to the app
       * root, so this only ever runs if the hook listens from above it.
       */}
      <input
        data-testid="search"
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault();
        }}
      />
      <input data-testid="party" />
      <button type="button" data-testid="chip">
        Tomorrow
      </button>
      <select data-testid="source">
        <option value="">—</option>
        <option value="call">Call</option>
      </select>
      <input data-testid="notes" />
    </div>
  );
}

describe('useEnterToAdvance / useEscapeToPrevious', () => {
  it('walks forward on Enter and back on Escape, stepping over buttons', () => {
    const { getByTestId } = render(<Form />);
    const party = getByTestId('party');
    const source = getByTestId('source');
    const notes = getByTestId('notes');

    party.focus();
    fireEvent.keyDown(party, { key: 'Enter' });
    expect(document.activeElement).toBe(source);

    // The first Enter on a select opens its list rather than leaving it; the
    // native popup owns the arrows and its own Enter from there.
    showPicker.mockClear();
    fireEvent.keyDown(source, { key: 'Enter' });
    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(source);

    // The next one the page sees is the one after the popup closed.
    fireEvent.keyDown(source, { key: 'Enter' });
    expect(document.activeElement).toBe(notes);

    fireEvent.keyDown(notes, { key: 'Escape' });
    expect(document.activeElement).toBe(source);
    fireEvent.keyDown(source, { key: 'Escape' });
    expect(document.activeElement).toBe(party);
  });

  it('leaves a field that handled Enter itself where it is', () => {
    const { getByTestId } = render(<Form />);
    const search = getByTestId('search');
    search.focus();

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(document.activeElement).toBe(search);
  });

  it('leaves Escape alone on the first field', () => {
    const { getByTestId } = render(<Form />);
    const search = getByTestId('search');
    search.focus();

    const consumed = !fireEvent.keyDown(search, { key: 'Escape' });
    expect(consumed).toBe(false);
    expect(document.activeElement).toBe(search);
  });

  it('runs onSubmit from the last field', () => {
    const onSubmit = vi.fn();
    const { getByTestId } = render(<Form onSubmit={onSubmit} />);
    const notes = getByTestId('notes');
    notes.focus();

    fireEvent.keyDown(notes, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
