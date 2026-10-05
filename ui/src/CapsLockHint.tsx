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

export function CapsLockHint({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      className="ob-small"
      role="status"
      style={{ color: 'var(--state-offline, var(--accent))' }}
    >
      {t('password.capsLock')}
    </span>
  );
}
