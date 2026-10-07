/**
 * Toasts (§9 Structure): bottom-left, above the footer, 4s, stacks to three.
 * Feedback keeps its name through the flow — the Save button produces a
 * "Saved" toast, never a generic "Success".
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { unhandledFailureText } from './failureToasts.js';
import { t } from './i18n.js';
import { TooltipLayer } from './Tooltip.js';

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

/** The Feedback artboard's 16 px stroke glyphs: a tick for done (green) and for news (accent), a ring for a failure. */
function ToneIcon({ tone }: { tone: ToastTone }) {
  return (
    <svg
      className={`ob-toast-icon ob-toast-icon--${tone}`}
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {tone === 'error' ? (
        <>
          <circle cx={12} cy={12} r={9} />
          <path d="M12 7v6M12 16.5v.5" />
        </>
      ) : (
        <path d="M5 12.5l4.5 4.5L19 7" />
      )}
    </svg>
  );
}

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

  // A failed request nobody caught is said here, once per sentence per ten seconds:
  // a screen polling an unreachable Master must not stack a toast every second.
  useEffect(() => {
    const lastSaid = new Map<string, number>();
    const onRejection = (event: PromiseRejectionEvent): void => {
      const text = unhandledFailureText(event.reason);
      if (!text) return;
      const now = Date.now();
      if (now - (lastSaid.get(text) ?? 0) < 10_000) return;
      lastSaid.set(text, now);
      push(text, { tone: 'error' });
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Here because both panels wrap their whole app in this provider; see Tooltip.tsx. */}
      <TooltipLayer />
      <div className="ob-toasts">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="ob-toast"
            // A failure interrupts; anything else waits its turn.
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <ToneIcon tone={toast.tone} />
            <span className="ob-toast-text">{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="ob-toast-action"
                onClick={() => {
                  toast.action?.onClick();
                  remove(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              className="ob-icon-btn"
              aria-label={t('toast.dismiss')}
              title={t('toast.dismiss')}
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
