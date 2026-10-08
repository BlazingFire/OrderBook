/**
 * Rebinding, in Settings, written once for both panels.
 *
 * It sits beside theme, density and scale rather than in the company settings
 * table, and that is the whole argument for `localStorage`: **a keyboard is a
 * property of a machine.** The shop PC has a full-size board with a numeric
 * keypad and the office laptop does not, so syncing a remap between them would
 * push one person's answer onto the other's hardware. Stated cost: a remap does
 * not follow somebody from the Master to an Office panel.
 *
 * Capture rather than a text box. Asking a person to type `Ctrl+Shift+K` means
 * asking them to know how this file spells it — and they would find out by
 * getting it wrong.
 */

import { useState } from 'react';
import {
  chordFor,
  chordFromEvent,
  commandsFor,
  findConflicts,
  formatChord,
  isReservedChord,
} from '@orderbook/shared';

import { Button } from './Button';
import { useKeyboard } from './KeyboardProvider';
import { t } from './i18n';

export function ShortcutSettings() {
  const keyboard = useKeyboard();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  const conflicts = new Set(
    findConflicts(keyboard.panel, keyboard.bindings).flatMap((conflict) => conflict.commandIds),
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
        <p className="ob-small" style={{ flex: 1, margin: 0 }}>
          {t('keys.settings.hint')}
        </p>
        <Button variant="secondary" onClick={() => keyboard.resetBindings()}>
          {t('keys.settings.resetAll')}
        </Button>
      </div>

      {refused && (
        <p className="ob-small" style={{ marginTop: 'var(--s-8)' }}>
          {t('keys.settings.reserved')}
        </p>
      )}

      <dl className="ob-kv" style={{ marginTop: 'var(--s-12)' }}>
        {commandsFor(keyboard.panel).flatMap((command) => {
          const chord = chordFor(command.id, keyboard.bindings);
          const active = capturing === command.id;

          return [
            <dt key={`${command.id}-name`}>
              {t(command.titleToken)}
              {conflicts.has(command.id) && ` · ${t('keys.help.conflict')}`}
            </dt>,
            <dd key={`${command.id}-chord`} style={{ display: 'flex', gap: 'var(--s-4)' }}>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="ob-btn ob-btn--ghost"
                aria-label={t('keys.settings.change')}
                // While recording, the shell's Escape-back stands aside (`AppShell`).
                data-key-capture={active || undefined}
                onClick={() => {
                  setRefused(false);
                  setCapturing(active ? null : command.id);
                }}
                onKeyDown={(event) => {
                  if (!active) return;
                  // Everything, including Tab: while this row is capturing, the
                  // key somebody presses is the binding they mean, not a request
                  // to move focus.
                  event.preventDefault();
                  event.stopPropagation();

                  const next = chordFromEvent(event.nativeEvent);
                  if (!next) return;
                  if (isReservedChord(next)) {
                    // Escape and Tab belong to the overlay layer. Saying so is
                    // better than appearing to ignore the key.
                    setRefused(true);
                    setCapturing(null);
                    return;
                  }

                  keyboard.setBinding(command.id, formatChord(next));
                  setCapturing(null);
                }}
              >
                {active
                  ? t('keys.settings.press')
                  : chord
                    ? formatChord(chord)
                    : t('keys.help.unbound')}
              </button>
              <button
                type="button"
                className="ob-btn ob-btn--ghost"
                aria-label={t('keys.settings.clear')}
                title={t('keys.settings.clear')}
                onClick={() => keyboard.setBinding(command.id, null)}
              >
                ×
              </button>
            </dd>,
          ];
        })}
        {/* Not a command and not rebindable: Escape is reserved, and outside a
            dialog or list it goes back a step (`AppShell`, R8). */}
        <dt>{t('keys.help.back')}</dt>
        <dd style={{ display: 'flex' }}>
          <span style={{ flex: 1 }} />
          {formatChord({ key: 'Escape' })}
        </dd>
      </dl>
    </div>
  );
}
