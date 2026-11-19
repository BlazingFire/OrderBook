import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MenuSelect } from '../src/MenuSelect.js';

afterEach(cleanup);

const OPTIONS = [
  { value: '', label: 'Ask on every line' },
  { value: 'Box', label: 'Box' },
  { value: 'Grass', label: 'Grass' },
];

describe('MenuSelect', () => {
  it('opens on the chosen item, walks with the arrows, and picks on click', () => {
    const onChange = vi.fn();
    render(<MenuSelect value="Box" options={OPTIONS} ariaLabel="Packaging" onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: 'Packaging' });
    expect(trigger.textContent).toBe('Box');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const box = screen.getByRole('menuitemradio', { name: 'Box' });
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Grass' }));

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ask on every line' }));
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('draws the menu outside the cell, so a clipping table cell cannot hide it, and a second press closes it', () => {
    render(
      <table>
        <tbody>
          <tr>
            <td data-testid="cell">
              <MenuSelect
                value=""
                options={OPTIONS}
                ariaLabel="Packaging"
                onChange={() => undefined}
              />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    const trigger = screen.getByRole('button', { name: 'Packaging' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(screen.getByTestId('cell').contains(menu)).toBe(false);
    expect(menu.closest('.ob-popover')?.getAttribute('style')).toContain('position: fixed');

    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not report a pick of the value it already holds', () => {
    const onChange = vi.fn();
    render(<MenuSelect value="" options={OPTIONS} ariaLabel="Packaging" onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Packaging' });
    expect(trigger.hasAttribute('data-empty')).toBe(true);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ask on every line' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
