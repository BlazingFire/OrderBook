/**
 * The last thing between a render error and a blank window.
 *
 * React unmounts the entire tree when a component throws during render, so one
 * bad property in one small component takes the whole panel down to an empty
 * dark rectangle — no message, no reload button, nothing to report to whoever
 * has to fix it. That is exactly what a footer avatar reading `.id` off an
 * absent field did, and on a shop floor it is indistinguishable from the
 * software being broken beyond use.
 *
 * This does not fix any bug. It makes the failure legible: what went wrong,
 * which component, and a way back — so somebody can say more than "it went
 * blank" and can usually keep working after a reload.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { t } from '../i18n/strings';

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in state as well as logged: the console is not open on a shop PC,
    // and the stack is the one thing that makes the report actionable.
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="ob-crash" role="alert">
        <div className="ob-crash-panel">
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('crash.title')}
          </h1>
          <p className="ob-small" style={{ margin: 0 }}>
            {t('crash.body')}
          </p>

          <pre className="ob-crash-detail">
            {error.message}
            {componentStack ? `\n${componentStack.trim().split('\n').slice(0, 6).join('\n')}` : ''}
          </pre>

          <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
            <button type="button" className="ob-btn ob-btn--primary" onClick={() => window.location.reload()}>
              {t('crash.reload')}
            </button>
            <button
              type="button"
              className="ob-btn ob-btn--secondary"
              onClick={() => {
                void navigator.clipboard.writeText(`${error.message}\n${componentStack ?? ''}`);
              }}
            >
              {t('crash.copy')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
