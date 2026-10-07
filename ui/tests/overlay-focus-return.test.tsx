import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Modal } from '../src/Modal';
import { t } from '../src/i18n';

Element.prototype.checkVisibility ??= () => true;
afterEach(cleanup);

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>New party</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Party">
        {/* autoFocus fires at commit, before the overlay's effect: the case that used to lose the opener */}
        <input aria-label="name" autoFocus />
        <button onClick={() => setOpen(false)}>Cancel</button>
      </Modal>
    </>
  );
}

describe('a dialog returns focus to what opened it', () => {
  for (const how of ['Escape', 'Cancel', 'Close'] as const) {
    it(`on ${how}, even with an autofocused field`, () => {
      render(<Host />);
      const opener = screen.getByRole('button', { name: 'New party' });
      opener.focus();
      fireEvent.click(opener);
      expect(document.activeElement).toBe(screen.getByLabelText('name'));
      if (how === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: how === 'Cancel' ? 'Cancel' : t('modal.close') }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  }
});
