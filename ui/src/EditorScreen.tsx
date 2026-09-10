/**
 * The frame a record or a large operation runs inside: what you are looking at,
 * what it is, and one way back that is always in the same place. The sidebar
 * entry published by `useSubNav` says where you are; this says what you are
 * looking at.
 *
 * Lifted out of the Master's `AccessScreen`, where it began as a private
 * helper, once the Office Panel needed the same frame for lead, order, party
 * and product detail.
 */

import type { ReactNode } from 'react';

import { Button } from './Button.js';

export interface EditorScreenProps {
  title: string;
  meta?: ReactNode;
  /** Returns false when the operation refused to close — an unsaved draft. */
  onBack: () => boolean;
  backLabel: string;
  children: ReactNode;
}

export function EditorScreen({ title, meta, onBack, backLabel, children }: EditorScreenProps) {
  return (
    <div className="ob-editorscreen">
      <header className="ob-editorscreen-head">
        <Button variant="ghost" size="sm" icon="collapse" onClick={() => onBack()}>
          {backLabel}
        </Button>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {title}
        </h1>
        {meta && <div className="ob-editorscreen-meta">{meta}</div>}
      </header>
      <div className="ob-editorscreen-body">{children}</div>
    </div>
  );
}
