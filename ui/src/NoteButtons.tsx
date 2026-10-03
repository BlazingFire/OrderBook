/**
 * The Filling and Dispatch note buttons as a row or card action (1.4 R10).
 *
 * The record header already carries them; this is the same pair for a list
 * row, so a note is one click from the list. A click here must not also open
 * the record the row stands for, so both the click and the key stop at the
 * button — the same reason the board card's menu button stops propagation.
 */

import type { KeyboardEvent, MouseEvent } from 'react';
import type { NoteKind } from '@orderbook/shared';

import { Button } from './Button';
import { t } from './i18n.js';

function stop(event: MouseEvent | KeyboardEvent): void {
  event.stopPropagation();
}

export function NoteButtons({ onNote }: { onNote: (kind: NoteKind) => void }) {
  return (
    <span className="ob-note-buttons" onClick={stop} onKeyDown={stop}>
      <Button variant="secondary" size="sm" onClick={() => onNote('filling')}>
        {t('orderNote.filling')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => onNote('dispatch')}>
        {t('orderNote.dispatch')}
      </Button>
    </span>
  );
}
