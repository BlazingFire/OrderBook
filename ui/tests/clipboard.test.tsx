/**
 * Copying over plain HTTP.
 *
 * `navigator.clipboard` exists only in a secure context. The desktop shell
 * loads `http://localhost`, which counts as one, but the Master binds
 * `0.0.0.0` and is also opened by LAN address from other machines' browsers —
 * and there `navigator.clipboard` is `undefined`, so every Copy button threw
 * before copying anything. jsdom has no clipboard either, which makes it a
 * faithful stand-in for that browser tab.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyText } from '../src/clipboard.js';
import { IdField } from '../src/DataDisplay.js';
import { ErrorBoundary } from '../src/ErrorBoundary.js';

/** jsdom's `document` has no `execCommand`; the tests add one and take it away. */
type Doc = { execCommand?: (command: string) => boolean };
const doc = document as unknown as Doc;

/** What the legacy route put on the clipboard, read at the moment it copied. */
let copied: string[] = [];

function stubExecCommand(result = true) {
  const execCommand = vi.fn((command: string) => {
    const active = document.activeElement;
    if (command === 'copy' && active instanceof HTMLTextAreaElement) {
      copied.push(active.value.slice(active.selectionStart, active.selectionEnd));
    }
    return result;
  });
  doc.execCommand = execCommand;
  return execCommand;
}

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

beforeEach(() => {
  copied = [];
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  delete doc.execCommand;
  setClipboard(undefined);
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('copies through a selected textarea when there is no clipboard API', async () => {
    const execCommand = stubExecCommand();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    await expect(copyText('LEAD-0042')).resolves.toBe(true);

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copied).toEqual(['LEAD-0042']);
    // Nothing left behind, and focus back where it was.
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('uses the clipboard API where the browser offers it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const execCommand = stubExecCommand();

    await expect(copyText('abc')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('abc');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back when the clipboard API refuses', async () => {
    setClipboard({
      writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    stubExecCommand();

    await expect(copyText('abc')).resolves.toBe(true);
    expect(copied).toEqual(['abc']);
  });

  it('reports failure rather than throwing when neither route works', async () => {
    // jsdom's own state: no clipboard and no `execCommand` at all.
    await expect(copyText('abc')).resolves.toBe(false);

    stubExecCommand(false);
    await expect(copyText('abc')).resolves.toBe(false);
  });
});

describe('Copy buttons', () => {
  it('IdField copies its value and shows the check', async () => {
    stubExecCommand();
    render(<IdField value="c0ffee" />);
    const icon = () => document.querySelector('.ob-idfield path')?.getAttribute('d');
    const copyIcon = icon();

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(copied).toEqual(['c0ffee']);
    expect(icon()).not.toBe(copyIcon);
  });

  it('the crash screen copies its report', async () => {
    stubExecCommand();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function Boom(): never {
      throw new Error('bad render');
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Copy details'));
    });

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('bad render');
  });
});
