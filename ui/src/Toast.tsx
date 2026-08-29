/**
 * Toasts (§9 Structure): bottom-left, above the footer, 4s, stacks to three.
 * Feedback keeps its name through the flow — the Save button produces a
 * "Saved" toast, never a generic "Success".
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastTone = 'ok' | 'error' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

const MAX_TOASTS = 3;
const TOAST_MS = 4000;

const TONE_DOT: Record<ToastTone, string> = {
  ok: 'var(--state-ok)',
  error: 'var(--state-conflict)',
  info: 'var(--accent)',
};

interface ToastApi {
  push: (message: string, opts?: { tone?: ToastTone; action?: ToastAction }) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<ToastApi['push']>(
    (message, opts) => {
      const id = nextId.current++;
      const item: ToastItem = {
        id,
        message,
        tone: opts?.tone ?? (opts?.action ? 'info' : 'ok'),
        action: opts?.action,
      };
      setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), item]);
      setTimeout(() => remove(id), TOAST_MS);
    },
    [remove],
  );

  /*
   * Memoised, and it is load-bearing rather than tidy.
   *
   * As an inline `{{ push }}` this object had a new identity on every render of
   * this provider — and this provider re-renders on every toast pushed *and*
   * again four seconds later when that toast auto-dismisses. Every
   * `useToast()` consumer therefore saw a changed value, so any of their
   * callbacks listing `toast` as a dependency was rebuilt, and any effect
   * depending on such a callback refired.
   *
   * On the Integrations screen that closed a cycle with no fixed point: a
   * failed load pushed a toast, the toast re-rendered this provider, the new
   * identity rebuilt the loader, the effect refired, the load failed again.
   * `push` is already stable, so memoising the wrapper fixes every consumer at
   * once — the alternative, editing one screen's dependency array, patches only
   * the caller that happened to notice.
   */
  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ob-toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className="ob-toast" role="status">
            <span className="dot" style={{ background: TONE_DOT[toast.tone] }} />
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action?.onClick();
                  remove(toast.id);
                }}
                style={{ color: 'var(--accent)', fontWeight: 550 }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              className="ob-icon-btn"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => remove(toast.id)}
            >
              <svg
                width={10}
                height={10}
                viewBox="0 0 16 16"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
