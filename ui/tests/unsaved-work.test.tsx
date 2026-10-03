/**
 * "Save all" before an update (`unsavedWork.tsx`, 1.4 R7b): a screen's unsaved
 * work is listed while it exists, saved when it can be, named when it cannot,
 * and the person is asked before anything is thrown away.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfirmProvider,
  __resetUnsavedWorkForTests,
  listUnsavedWork,
  saveAllUnsavedWork,
  t,
  useSaveAllBeforeUpdate,
  useUnsavedWork,
  type UnsavedWorkItem,
} from '../src/index.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  __resetUnsavedWorkForTests();
});
afterEach(() => {
  cleanup();
  delete (window as { orderbook?: unknown }).orderbook;
});

function Screen({ id, item }: { id: string; item: UnsavedWorkItem | null }) {
  useUnsavedWork(id, item);
  return null;
}

describe('the registry', () => {
  it('lists a screen only while it has something to lose', () => {
    const view = render(<Screen id="lead" item={null} />);
    expect(listUnsavedWork()).toEqual([]);

    view.rerender(<Screen id="lead" item={{ label: 'New lead for Acme' }} />);
    expect(listUnsavedWork().map((item) => item.label)).toEqual(['New lead for Acme']);

    view.rerender(<Screen id="lead" item={null} />);
    expect(listUnsavedWork()).toEqual([]);
  });

  it('forgets a screen when it unmounts', () => {
    const view = render(<Screen id="lead" item={{ label: 'A' }} />);
    view.unmount();
    expect(listUnsavedWork()).toEqual([]);
  });

  it('saves what can be saved, names what cannot, and survives a save that throws', async () => {
    const saved = vi.fn(async () => true);
    render(
      <>
        <Screen id="a" item={{ label: 'Ready lead', save: saved }} />
        <Screen id="b" item={{ label: 'Half-filled lead', save: async () => false }} />
        <Screen id="c" item={{ label: 'Throws', save: async () => Promise.reject(new Error('offline')) }} />
        <Screen id="d" item={{ label: 'Nothing to save with' }} />
      </>,
    );

    const result = await saveAllUnsavedWork();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(result.saved.map((item) => item.label)).toEqual(['Ready lead']);
    expect(result.unsaved.map((item) => item.label)).toEqual([
      'Half-filled lead',
      'Throws',
      'Nothing to save with',
    ]);
  });

  it('hands the desktop shell a handler that saves everything before the window closes', async () => {
    let handler: (() => Promise<void>) | undefined;
    (window as unknown as { orderbook: unknown }).orderbook = {
      onBeforeUpdate: (next: () => Promise<void>) => {
        handler = next;
      },
    };
    const saved = vi.fn(async () => true);
    render(<Screen id="a" item={{ label: 'Ready lead', save: saved }} />);

    expect(handler).toBeTypeOf('function');
    await handler?.();
    expect(saved).toHaveBeenCalledTimes(1);
  });
});

describe('useSaveAllBeforeUpdate', () => {
  function Gate({ onResult }: { onResult: (ok: boolean) => void }) {
    const saveAll = useSaveAllBeforeUpdate();
    return <button onClick={() => void saveAll().then(onResult)}>go</button>;
  }

  it('goes on at once when everything was saved', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Screen id="a" item={{ label: 'Ready lead', save: async () => true }} />
        <Gate onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('names what could not be saved and stops if the person says no', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Screen id="b" item={{ label: 'Half-filled lead', save: async () => false }} />
        <Gate onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    expect(await screen.findByText(t('updates.saveAll.unsavedTitle'))).toBeTruthy();
    expect(screen.getByText('Half-filled lead')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('goes on when the person chooses to update anyway', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Screen id="b" item={{ label: 'Half-filled lead' }} />
        <Gate onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    fireEvent.click(await screen.findByRole('button', { name: t('updates.saveAll.updateAnyway') }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });
});
