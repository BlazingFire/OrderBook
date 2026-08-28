/**
 * Toasts (§9 Structure): bottom-left, above the footer, 4s, stacks to three.
 * Feedback keeps its name through the flow — the Save button produces a
 * "Saved" toast, never a generic "Success".
 */

import { createContext, useCallback, useContext, useRef, useState } from 'react';
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

  return (
    <ToastContext.Provider value={{ push }}>
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
