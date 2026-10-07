/**
 * The product's one confirmation dialog.
 *
 * There used to be three mechanisms: this Modal shape, hand-rolled per screen
 * (`AccessScreen.tsx`'s deactivate confirm), and raw `window.confirm()` in four
 * places. In Electron `window.confirm` renders the bare Chromium dialog — no
 * app theme, no translation, the page origin in its title bar on Windows — and
 * it blocks the renderer while it is up. Worse, one of the call sites fired it
 * from inside an already-open `Modal`, which is exactly the two-competing-
 * dismiss-mechanisms state `Modal.tsx`'s own doc comment forbids: Escape then
 * has two meanings and the operator cannot tell which one they are getting.
 *
 * Two ways to use it:
 *
 *  · **Declarative** — render `<ConfirmDialog open={…} …/>` from state, for a
 *    confirm that belongs to a specific row or record the screen already holds.
 *  · **`useConfirm()`** — `if (await confirm({ title, body })) …`, for a confirm
 *    inside an event handler that has nothing to hang state off. This is what
 *    replaces a `window.confirm` without restructuring the caller: it returns
 *    the same boolean, it just does not block the renderer to get it.
 *
 * `tone="danger"` colours the confirm button only. The dialog never pre-selects
 * the destructive choice: `Modal`'s own focus lands on the first focusable
 * element, which is Cancel.
 */

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from './Button.js';
import { Modal } from './Modal.js';
import { t } from './i18n.js';

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  /** Defaults to `common.confirm`. */
  confirmLabel?: string;
  /** Defaults to `common.cancel`. */
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmRequest & {
  open: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title={title}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            busy={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {typeof body === 'string' ? <p className="ob-body ob-confirm-body">{body}</p> : body}
    </Modal>
  );
}

type Settle = (answer: boolean) => void;

const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<boolean>>(
  // Outside a provider there is nobody to ask, so nothing destructive proceeds.
  // Returning `true` would make a missing provider silently delete things.
  () => Promise.resolve(false),
);

/**
 * Hosts the one dialog every `useConfirm()` caller shares. Mounted once, near
 * the root, beside `ToastProvider` — a per-screen provider would put the dialog
 * inside a pane that can be hidden mid-question.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const settle = useRef<Settle | null>(null);

  const ask = useCallback((next: ConfirmRequest): Promise<boolean> => {
    // A second question while one is open answers the first with "no" rather
    // than leaving its promise unsettled forever — an abandoned `await` in a
    // save path is a screen that never re-enables its buttons.
    settle.current?.(false);
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      settle.current = resolve;
    });
  }, []);

  function answer(value: boolean): void {
    const resolve = settle.current;
    settle.current = null;
    setRequest(null);
    resolve?.(value);
  }

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <ConfirmDialog
        open={request !== null}
        title={request?.title ?? ''}
        body={request?.body}
        confirmLabel={request?.confirmLabel}
        cancelLabel={request?.cancelLabel}
        tone={request?.tone}
        onConfirm={() => answer(true)}
        onCancel={() => answer(false)}
      />
    </ConfirmContext.Provider>
  );
}

/** `if (await confirm({ title: … })) …` — the themed replacement for `window.confirm`. */
export function useConfirm(): (request: ConfirmRequest) => Promise<boolean> {
  return useContext(ConfirmContext);
}
