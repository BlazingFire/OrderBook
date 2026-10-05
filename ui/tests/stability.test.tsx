/**
 * R18: a crash or a failed request is said out loud and does not take the window down.
 *
 *  · A screen that throws while rendering shows its own error with Try again and
 *    Reload; the screens beside it keep working.
 *  · A request that failed and that nobody caught becomes a toast, in the reader's
 *    words; a cancelled one does not, and the same sentence is not stacked.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { ScreenHost } from '../src/ScreenHost.js';
import { ToastProvider } from '../src/Toast.js';
import { unhandledFailureText } from '../src/failureToasts.js';
import { t } from '../src/i18n.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  configureUi({ panel: 'office', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let broken = true;
function Fragile() {
  if (broken) throw new Error('bad property');
  return <p>fragile screen is fine</p>;
}

function Counter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      {`count ${n}`}
    </button>
  );
}

describe('a screen that crashes while rendering', () => {
  const tree = (activeId: string) => (
    <ScreenHost
      activeId={activeId}
      screens={[
        { id: 'fragile', render: () => <Fragile /> },
        { id: 'counter', render: () => <Counter /> },
      ]}
    />
  );

  it('shows its own error with Try again and Reload, and leaves the other screens alone', async () => {
    broken = true;
    const { rerender } = render(tree('counter'));
    fireEvent.click(screen.getByRole('button', { name: 'count 0' }));

    await act(async () => rerender(tree('fragile')));

    expect(screen.getByTestId('screen-crash').textContent).toContain('bad property');
    expect(screen.getByRole('button', { name: t('crash.reload') })).toBeTruthy();

    // The screen beside it kept what it held.
    await act(async () => rerender(tree('counter')));
    expect(screen.getByRole('button', { name: 'count 1' })).toBeTruthy();

    // Once the fault is gone, Try again brings the screen back.
    await act(async () => rerender(tree('fragile')));
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: t('crash.retry') }));
    expect(screen.getByText('fragile screen is fine')).toBeTruthy();
  });
});

function reject(reason: unknown): void {
  const event = new Event('unhandledrejection');
  Object.assign(event, { reason });
  window.dispatchEvent(event);
}

describe('a request nobody caught', () => {
  it('says what failed, in the reader’s words', () => {
    const coded = Object.assign(new Error('English from the server'), {
      code: 'forbidden',
      messageKey: 'error.generic.forbidden',
    });

    expect(unhandledFailureText(coded)).toBe(t('error.generic.forbidden'));
    expect(unhandledFailureText(new TypeError('Failed to fetch'))).toBe(
      t('error.generic.requestFailed'),
    );
    expect(unhandledFailureText('a string')).toBeNull();
    expect(unhandledFailureText(new DOMException('aborted', 'AbortError'))).toBeNull();
  });

  it('becomes a toast, once, and a cancelled request does not', async () => {
    render(
      <ToastProvider>
        <p>app</p>
      </ToastProvider>,
    );

    await act(async () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    expect(screen.queryByText(t('error.generic.requestFailed'))).toBeNull();

    await act(async () => {
      reject(new TypeError('Failed to fetch'));
      reject(new TypeError('Failed to fetch'));
    });
    expect(screen.getAllByText(t('error.generic.requestFailed'))).toHaveLength(1);
  });
});
