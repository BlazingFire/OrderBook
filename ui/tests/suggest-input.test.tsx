/**
 * The type-or-pick field, against the real Enter walk it has to cooperate with.
 *
 * The whole reason this component exists rather than a `<select>` is one
 * sentence from the shop: *type "cartoon" or its word, show a suggestion, Enter
 * to select it and go to the next step.* That is two behaviours in one key, and
 * they are split across two files — the field commits the word, and
 * `useEnterToAdvance` moves the caret. The join between them is a **negative**:
 * the field must not call `preventDefault`, because the walk skips any Enter
 * that is already handled.
 *
 * A unit test of the field alone would pass with that contract broken, so this
 * renders both together and asserts on where the caret ends up.
 */

import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SuggestInput } from '../src/SuggestInput.js';
import { useEnterToAdvance } from '../src/useEnterToAdvance.js';

afterEach(cleanup);

const PACKAGING = [
  { value: 'Box', label: 'Box' },
  { value: 'Carton', label: 'Carton' },
  { value: 'Pallet', label: 'Pallet' },
];

/** The draft card's shape: the field, then the field it must hand on to. */
function Card({ initial = '' }: { initial?: string }) {
  const fields = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(initial);
  useEnterToAdvance(fields);

  return (
    <div ref={fields}>
      <SuggestInput
        value={value}
        options={PACKAGING}
        onChange={setValue}
        optionsLabel="Show packaging options"
      />
      <input data-testid="next" />
      <output data-testid="value">{value}</output>
    </div>
  );
}

function field(): HTMLInputElement {
  return screen.getByRole('combobox');
}

describe('a field somebody can type into or pick from', () => {
  it('LEAD-31: narrows the list to what has been typed', () => {
    render(<Card />);
    fireEvent.change(field(), { target: { value: 'cart' } });

    // Case-insensitive and mid-word, because "carto" is what a person in a
    // hurry actually types.
    expect(screen.getByRole('option', { name: 'Carton' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Box' })).toBeNull();
  });

  it('LEAD-31: Enter takes the suggestion and moves to the next field', () => {
    render(<Card />);
    const input = field();
    input.focus();
    fireEvent.change(input, { target: { value: 'cart' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Both halves of the one keypress. The second is the one that breaks
    // silently: a `preventDefault` in the field would leave the caret sitting
    // on packaging with the word correctly chosen, and nothing would say why.
    expect(screen.getByTestId('value').textContent).toBe('Carton');
    expect(document.activeElement).toBe(screen.getByTestId('next'));
  });

  it('LEAD-31: keeps a word that is on no list', () => {
    render(<Card />);
    const input = field();
    input.focus();
    // `line.packaging` ships unseeded and a shop extends it as new packaging
    // arrives, so a value nobody has added yet is legal — not a validation
    // error and not silently replaced by the nearest match.
    fireEvent.change(input, { target: { value: 'Shrink wrap' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('value').textContent).toBe('Shrink wrap');
    expect(document.activeElement).toBe(screen.getByTestId('next'));
  });

  it('LEAD-31: the arrow keys pick a different row', () => {
    render(<Card />);
    const input = field();
    // `fireEvent.focus`, not `input.focus()`: React 17 and later listen for
    // `focusin`, which jsdom's `.focus()` does not dispatch — so the DOM call
    // alone leaves the list shut and this would be testing the closed-list
    // case below instead of the one it is named for.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // First row is index 0, so one ArrowDown lands on the second.
    expect(screen.getByTestId('value').textContent).toBe('Carton');
  });

  it('LEAD-31: the first arrow on a shut list opens it without skipping the top row', () => {
    render(<Card />);
    const input = field();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('option', { name: 'Box' })).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Not 'Carton'. A list that was not showing has nothing to move *from*,
    // and moving anyway walks straight past whatever is at the top of it.
    expect(screen.getByTestId('value').textContent).toBe('Box');
  });

  it('LEAD-31: the arrows walk the chevron\'s full list without re-narrowing it', () => {
    render(<Card initial="Carton" />);
    const input = field();
    fireEvent.mouseDown(screen.getByLabelText('Show packaging options'));
    expect(screen.getAllByRole('option')).toHaveLength(3);

    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // The defect this pins: ArrowDown used to turn filtering back on, so a
    // field already holding "Carton" went from three rows to one on the very
    // press that was meant to walk them — the rows moved under the highlight.
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('value').textContent).toBe('Carton');
  });

  it('LEAD-31: the chevron shows every option, not just the one it holds', () => {
    render(<Card initial="Carton" />);

    // The dropdown half. Filtering by the committed value would show Carton and
    // nothing else, which would make the list useless for changing your mind.
    fireEvent.mouseDown(screen.getByLabelText('Show packaging options'));

    expect(screen.getByRole('option', { name: 'Box' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Pallet' })).toBeTruthy();
  });

  it('LEAD-31: Escape closes the list rather than the screen around it', () => {
    render(<Card />);
    const input = field();
    fireEvent.change(input, { target: { value: 'ca' } });
    expect(screen.queryByRole('option', { name: 'Carton' })).toBeTruthy();

    const claimed = !fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('option', { name: 'Carton' })).toBeNull();
    // Claimed only while a list was open — see the component. A field merely
    // focused must leave Escape for whatever is above it.
    expect(claimed).toBe(true);

    const spare = !fireEvent.keyDown(input, { key: 'Escape' });
    expect(spare).toBe(false);
  });

  it('LEAD-31: a list that merely opened on focus leaves Escape for the dialog', () => {
    render(<Card />);
    const input = field();
    fireEvent.focus(input);
    expect(screen.queryByRole('option', { name: 'Box' })).toBeTruthy();

    const claimed = !fireEvent.keyDown(input, { key: 'Escape' });

    // The list still closes — but the key is not claimed, so the Modal's own
    // Escape (on `document`, which honours `defaultPrevented`) still runs. In
    // the product dialog the first Escape used to do nothing anybody could
    // see: it shut a list that had opened itself, and the dialog stayed put.
    expect(screen.queryByRole('option', { name: 'Box' })).toBeNull();
    expect(claimed).toBe(false);
  });
});
