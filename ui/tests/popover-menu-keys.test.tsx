import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Popover } from '../src/Popover';

afterEach(cleanup);

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>trigger</button>
      <Popover open={open} onClose={() => setOpen(false)} anchorStyle={{ top: 0 }}>
        <div role="menu">
          <button role="menuitem">One</button>
          <button role="menuitem" disabled>Two</button>
          <button role="menuitem">Three</button>
        </div>
      </Popover>
    </>
  );
}

describe('a popover menu', () => {
  it('focuses the first item, arrows/Home/End skip disabled ones, Escape returns focus to the trigger', () => {
    render(<Host />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    fireEvent.click(trigger);
    const [one, three] = [screen.getByText('One'), screen.getByText('Three')];
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
