/**
 * Create product share (1.4 D3, R16): the bar over the Products list.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProductShareBar } from '../src/ProductShare.js';
import { ToastProvider } from '../src/Toast.js';
import { t } from '../src/i18n.js';

beforeAll(() => {
  Element.prototype.checkVisibility ??= () => true;
});
afterEach(cleanup);

function bar(props: Partial<Parameters<typeof ProductShareBar>[0]> = {}) {
  const build = vi.fn(async () => ({ blob: new Blob(['%PDF-']), fileName: 'product-share-2026-10-03.pdf' }));
  const onClear = vi.fn();
  render(
    <ToastProvider>
      <ProductShareBar count={3} onClear={onClear} build={build} {...props} />
    </ToastProvider>,
  );
  return { build, onClear };
}

describe('ProductShareBar', () => {
  it('is absent until a product is ticked', () => {
    bar({ count: 0 });
    expect(screen.queryByRole('button', { name: t('productShare.create') })).toBeNull();
  });

  it('shows how many are ticked, builds the PDF, then offers Save and Print', async () => {
    const { build } = bar();
    expect(screen.getByText(t('productShare.selected', { count: 3 }))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('productShare.create') }));
    await waitFor(() => expect(build).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(t('productShare.ready.title'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('productShare.save') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('productShare.print') })).toBeTruthy();
  });

  it('keeps the selection and says so when the PDF could not be made', async () => {
    const { onClear } = bar({ build: vi.fn(async () => Promise.reject(new Error('Master is off'))) });
    fireEvent.click(screen.getByRole('button', { name: t('productShare.create') }));
    expect(await screen.findByText(/Master is off|productShare/)).toBeTruthy();
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: t('productShare.create') })).toBeTruthy();
  });

  it('still shows the PDF after the effects were torn down and set up again (a hidden then shown Activity, StrictMode)', async () => {
    const build = vi.fn(async () => ({ blob: new Blob(['%PDF-']), fileName: 'x.pdf' }));
    render(
      <StrictMode>
        <ToastProvider>
          <ProductShareBar count={2} onClear={() => undefined} build={build} />
        </ToastProvider>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: t('productShare.create') }));
    expect(await screen.findByText(t('productShare.ready.title'))).toBeTruthy();
  });

  it('Clear selection reports up', () => {
    const { onClear } = bar();
    fireEvent.click(screen.getByRole('button', { name: t('productShare.clear') }));
    expect(onClear).toHaveBeenCalled();
  });
});
