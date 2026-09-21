/**
 * `Select` wears the `<select>` API over the `SuggestInput` field. Two things
 * matter: a caller sees the option *value* in `event.target.value` while the
 * person sees the option *label*, and nothing typed off the list ever leaves.
 */

import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Select } from '../src/SuggestInput.js';
import { useEnterToAdvance } from '../src/useEnterToAdvance.js';

afterEach(cleanup);

function Form({ onValue }: { onValue: (value: string) => void }) {
  const fields = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('call');
  useEnterToAdvance(fields);
  return (
    <div ref={fields}>
      <Select
        value={value}
        aria-label="Source"
        onChange={(event) => {
          setValue(event.target.value);
          onValue(event.target.value);
        }}
      >
        <option value="call">Phone call</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="walk_in">Walk-in</option>
      </Select>
      <input data-testid="next" />
    </div>
  );
}

describe('Select', () => {
  it('shows the label, emits the value, and Enter steps on', () => {
    const seen: string[] = [];
    render(<Form onValue={(value) => seen.push(value)} />);
    const field = screen.getByLabelText('Source') as HTMLInputElement;
    expect(field.value).toBe('Phone call');

    field.focus();
    fireEvent.change(field, { target: { value: 'walk' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(seen).toEqual(['walk_in']);
    expect(field.value).toBe('Walk-in');
    expect(document.activeElement).toBe(screen.getByTestId('next'));
  });

  it('never emits a word that is not on the list', () => {
    const seen: string[] = [];
    render(<Form onValue={(value) => seen.push(value)} />);
    const field = screen.getByLabelText('Source') as HTMLInputElement;

    field.focus();
    fireEvent.change(field, { target: { value: 'carrier pigeon' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);

    expect(seen).toEqual([]);
    expect(field.value).toBe('Phone call');
  });
});
