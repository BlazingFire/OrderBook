/** "Caps Lock is on" under a password box: the usual reason a right password is refused. */

import { useState, type KeyboardEvent } from 'react';

import { t } from './i18n.js';

/** Spread the handlers onto the password input; render `<CapsLockHint on={…} />` under it. */
export function useCapsLock(): {
  on: boolean;
  handlers: {
    onKeyDown: (e: KeyboardEvent) => void;
    onKeyUp: (e: KeyboardEvent) => void;
    onBlur: () => void;
  };
} {
  const [on, setOn] = useState(false);
  const read = (event: KeyboardEvent): void => setOn(event.getModifierState('CapsLock'));
  return { on, handlers: { onKeyDown: read, onKeyUp: read, onBlur: () => setOn(false) } };
}

/**
 * Takes no room, shown or not. A line that appeared and vanished with Caps Lock moved the
 * Sign in button, and a click that began on the button (which blurs the box, which hides the
 * hint) then ended beside it. The wrapper cancels the form's flex gap with a negative margin
 * (the form's gap is `--s-16`), so the box and the button stay exactly where they were and
 * the hint sits in the space between them.
 */
export function CapsLockHint({ on }: { on: boolean }) {
  return (
    <div
      style={{ position: 'relative', height: 0, marginTop: 'calc(-1 * var(--s-16))' }}
      data-capslock-slot
    >
      {on && (
        <span
          className="ob-small"
          role="status"
          style={{
            position: 'absolute',
            top: 'calc(var(--s-4) / 2)',
            fontSize: '0.85em',
            left: 0,
            lineHeight: 1,
            color: 'var(--state-offline, var(--accent))',
          }}
        >
          {t('password.capsLock')}
        </span>
      )}
    </div>
  );
}
