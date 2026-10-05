/**
 * The frame a record or a large operation runs inside: what you are looking at,
 * what it is, and one way back that is always in the same place. The sidebar
 * entry published by `useSubNav` says where you are; this says what you are
 * looking at.
 *
 * Lifted out of the Master's `AccessScreen`, where it began as a private
 * helper, once the Office Panel needed the same frame for lead, order, party
 * and product detail.
 *
 * `title` is optional because the shell's topbar already shows the record's
 * name — `useSubNav` publishes the open record as a nested nav item, and the
 * topbar reads its label. A screen that prints the same name again an inch
 * lower is saying it twice; one that has nothing else in the head is left with
 * the back button alone, which is the whole point of the head.
 */

import type { ReactNode } from 'react';

import { Button } from './Button.js';

export interface EditorScreenProps {
  /** Omit where the topbar already names the record. */
  title?: string;
  meta?: ReactNode;
  /** Trailing controls — Save, Cancel. */
  actions?: ReactNode;
  /** Resolves false when the operation refused to close — an unsaved draft. May ask first (a themed dialog), hence the promise. */
  onBack: () => boolean | Promise<boolean>;
  backLabel: string;
  children: ReactNode;
}

export function EditorScreen({ title, meta, actions, onBack, backLabel, children }: EditorScreenProps) {
  return (
    <div className="ob-editorscreen">
      <header className="ob-editorscreen-head">
        <Button variant="ghost" size="sm" icon="collapse" onClick={() => void onBack()}>
          {backLabel}
        </Button>
        {title && (
          <h1 className="ob-title" style={{ margin: 0 }}>
            {title}
          </h1>
        )}
        {meta && <div className="ob-editorscreen-meta">{meta}</div>}
        {actions && <div className="ob-editorscreen-actions">{actions}</div>}
      </header>
      <div className="ob-editorscreen-body">{children}</div>
    </div>
  );
}
