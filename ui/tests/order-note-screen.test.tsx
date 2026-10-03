/**
 * The note screen over a pending order or a final order, and `printOnly`: what
 * the header calls the record, that a pending order's vehicle number is never
 * saved, the Copies and Save PDF controls, and that exactly one note portal is
 * marked for the paper while a print or a PDF save runs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead, Order } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { OrderNoteScreen } from '../src/OrderNoteScreen.js';
import { printOnly } from '../src/printPortal.js';
import { ToastProvider } from '../src/Toast.js';
import { listUnsavedWork, saveAllUnsavedWork, __resetUnsavedWorkForTests } from '../src/unsavedWork.js';
import { installBrowserStubs } from './panel-harness.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  installBrowserStubs();
  __resetUnsavedWorkForTests();
});

afterEach(() => {
  cleanup();
  document.body.className = '';
  vi.restoreAllMocks();
});

const ITEMS = [
  {
    id: 'li-1', variantId: 'v1', productId: 'p1', productName: 'Rustic Wood', categoryName: 'Duragres',
    size: '600x600', brandName: null, variantLabel: 'Ivory', colour: null, grade: 'Std', packaging: 'Box',
    quantity: 12, weightKg: 2, lineWeightKg: 24,
  },
];

const LEAD = {
  id: 'LD0000000042', partyName: 'Shree Ceramics', createdAt: '2026-10-01T05:00:00.000Z',
  items: ITEMS, totalWeightKg: 24, convertedOrderId: null,
} as unknown as Lead;

const ORDER = {
  id: 'OD0000000007', partyName: 'Shree Ceramics', leadCreatedAt: '2026-09-30T05:00:00.000Z',
  items: ITEMS, totalWeightKg: 24, totalWeightKgOverride: null, weightSource: 'computed',
  vehicleNumber: 'GJ 01 AA 1111',
} as unknown as Order;

function mount(props: Partial<React.ComponentProps<typeof OrderNoteScreen>> = {}) {
  return render(
    <ToastProvider>
      <OrderNoteScreen
        record={LEAD}
        source="lead"
        party={null}
        initialKind="dispatch"
        canEditVehicle={false}
        onSaveVehicle={async () => undefined}
        onBack={() => undefined}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('what the header calls the record', () => {
  it('heads a pending order "Pending Order No." with the lead id, and a final order "Final Order No."', () => {
    mount({ initialKind: 'filling' });
    expect(screen.getAllByText(t('orderNote.pendingOrderNo')).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('orderNote.orderId'))).toBeNull();
    expect(screen.getAllByText(LEAD.id).length).toBeGreaterThan(0);
    cleanup();

    mount({ record: ORDER, source: 'order', initialKind: 'filling' });
    expect(screen.getAllByText(t('orderNote.orderId')).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('orderNote.pendingOrderNo'))).toBeNull();
    expect(screen.getAllByText(ORDER.id).length).toBeGreaterThan(0);
  });
});

describe('the vehicle number', () => {
  it('is typed for the sheet on a pending order and never saved, even where canEditVehicle is false', async () => {
    const onSaveVehicle = vi.fn(async () => undefined);
    mount({ onSaveVehicle });

    const field = screen.getByLabelText(t('orderNote.vehicleNo')) as HTMLInputElement;
    expect(field.disabled).toBe(false);
    fireEvent.change(field, { target: { value: 'gj 03  ab 4471' } });
    fireEvent.blur(field);
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(field.value).toBe('GJ 03 AB 4471');
    expect(onSaveVehicle).not.toHaveBeenCalled();
  });

  it('is saved on a final order that may be edited, and starts from the order\'s own', async () => {
    const onSaveVehicle = vi.fn(async () => undefined);
    mount({ record: ORDER, source: 'order', canEditVehicle: true, onSaveVehicle });

    const field = screen.getByLabelText(t('orderNote.vehicleNo')) as HTMLInputElement;
    expect(field.value).toBe('GJ 01 AA 1111');
    fireEvent.change(field, { target: { value: 'gj 03 ab 4471' } });
    fireEvent.blur(field);
    await waitFor(() => expect(onSaveVehicle).toHaveBeenCalledWith('GJ 03 AB 4471'));
  });

  it('Save all and update saves a vehicle number typed and not yet blurred, and lists nothing on a pending order', async () => {
    const onSaveVehicle = vi.fn(async () => undefined);
    mount({ record: ORDER, source: 'order', canEditVehicle: true, onSaveVehicle });
    expect(listUnsavedWork()).toEqual([]);

    fireEvent.change(screen.getByLabelText(t('orderNote.vehicleNo')), { target: { value: 'gj 03 ab 4471' } });
    expect(listUnsavedWork().map((item) => item.label)).toEqual([
      t('updates.saveAll.vehicle', { number: 'GJ 03 AB 4471' }),
    ]);
    await act(async () => {
      await saveAllUnsavedWork();
    });
    expect(onSaveVehicle).toHaveBeenCalledWith('GJ 03 AB 4471');
    // Saved: nothing left to lose.
    expect(listUnsavedWork()).toEqual([]);
    cleanup();

    // A pending order's number is only printed, so it is never work.
    mount({ onSaveVehicle });
    fireEvent.change(screen.getByLabelText(t('orderNote.vehicleNo')), { target: { value: 'GJ 05 XX 1' } });
    expect(listUnsavedWork()).toEqual([]);
  });

  it('is read-only on a final order the person may not edit', () => {
    mount({ record: ORDER, source: 'order', canEditVehicle: false });
    expect((screen.getByLabelText(t('orderNote.vehicleNo')) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('printing', () => {
  afterEach(() => {
    delete (window as Window & { orderbook?: unknown }).orderbook;
  });

  it('asks the shell for one copy by default and for the number set, between 1 and 50', async () => {
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    mount({ desktop: { printPage } });

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() => expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: 1 }));

    const copies = screen.getByLabelText(t('orderNote.copies')) as HTMLInputElement;
    for (const [typed, sent] of [['3', 3], ['0', 1], ['-4', 1], ['51', 50], ['2.6', 3], ['', 1]] as const) {
      fireEvent.change(copies, { target: { value: typed } });
      fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
      await waitFor(() => expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: sent }));
    }

    // Leaving the field shows the number that will be sent.
    fireEvent.change(copies, { target: { value: '99' } });
    fireEvent.blur(copies);
    expect(copies.value).toBe('50');
  });

  it('marks only its own portal for the paper while the shell prints, and clears it after', async () => {
    let during: { body: boolean; active: number; portals: number } | null = null;
    const printPage = vi.fn(async () => {
      during = {
        body: document.body.classList.contains('ob-printing'),
        active: document.querySelectorAll('.ob-note-print-portal--active').length,
        portals: document.querySelectorAll('.ob-note-print-portal').length,
      };
      return { ok: true };
    });
    // A second, kept-alive note screen: it must not be the one on the paper.
    const hidden = document.createElement('div');
    hidden.className = 'ob-note-print-portal';
    document.body.appendChild(hidden);
    mount({ desktop: { printPage } });

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() => expect(printPage).toHaveBeenCalled());

    expect(during).toEqual({ body: true, active: 1, portals: 2 });
    expect(hidden.classList.contains('ob-note-print-portal--active')).toBe(false);
    await waitFor(() => expect(document.body.classList.contains('ob-printing')).toBe(false));
    expect(document.querySelectorAll('.ob-note-print-portal--active')).toHaveLength(0);
    hidden.remove();
  });

  it('falls back to the browser print through the same single-portal rule, and says where to set copies', async () => {
    let during = false;
    vi.stubGlobal('print', () => {
      during = document.body.classList.contains('ob-printing');
    });
    mount();

    fireEvent.change(screen.getByLabelText(t('orderNote.copies')), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));

    expect(await screen.findByText(t('orderNote.copiesHint', { n: 3 }))).toBeTruthy();
    expect(during).toBe(true);
    await waitFor(() => expect(document.body.classList.contains('ob-printing')).toBe(false));
    vi.unstubAllGlobals();
  });
});

describe('Save PDF', () => {
  it('is offered only when the shell can save, and names the file for the number and the note', async () => {
    mount({ desktop: { printPage: vi.fn() } });
    expect(screen.queryByRole('button', { name: t('orderNote.savePdf') })).toBeNull();
    cleanup();

    const savePdf = vi.fn().mockResolvedValue({ ok: true, path: 'C:\\out.pdf' });
    mount({ desktop: { printPage: vi.fn(), savePdf }, initialKind: 'filling' });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.savePdf') }));
    await waitFor(() => expect(savePdf).toHaveBeenCalledWith({ fileName: `${LEAD.id}-filling.pdf` }));
  });

  it('runs inside printOnly, says nothing when the Save dialog is closed, and says why when it fails', async () => {
    let active = 0;
    const savePdf = vi
      .fn()
      .mockImplementationOnce(async () => {
        active = document.querySelectorAll('.ob-note-print-portal--active').length;
        return { ok: false, cancelled: true };
      })
      .mockResolvedValueOnce({ ok: false, error: 'disk full' });
    mount({ desktop: { printPage: vi.fn(), savePdf } });

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.savePdf') }));
    await waitFor(() => expect(savePdf).toHaveBeenCalledTimes(1));
    expect(active).toBe(1);
    expect(screen.queryByText(t('orderNote.savePdfFailed', { error: 'disk full' }))).toBeNull();

    await waitFor(() => expect(document.body.classList.contains('ob-printing')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.savePdf') }));
    expect(await screen.findByText(t('orderNote.savePdfFailed', { error: 'disk full' }))).toBeTruthy();
  });
});

describe('printOnly', () => {
  it('marks the one portal while the job runs and puts the page back after, whatever the job does', async () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    for (const portal of [a, b]) {
      portal.className = 'ob-note-print-portal';
      document.body.appendChild(portal);
    }

    const seen = await printOnly(a, async () => ({
      body: document.body.classList.contains('ob-printing'),
      a: a.classList.contains('ob-note-print-portal--active'),
      b: b.classList.contains('ob-note-print-portal--active'),
    }));
    expect(seen).toEqual({ body: true, a: true, b: false });
    expect(document.body.classList.contains('ob-printing')).toBe(false);
    expect(a.classList.contains('ob-note-print-portal--active')).toBe(false);

    await expect(printOnly(a, () => Promise.reject(new Error('printer jammed')))).rejects.toThrow('printer jammed');
    expect(document.body.classList.contains('ob-printing')).toBe(false);
    expect(a.classList.contains('ob-note-print-portal--active')).toBe(false);

    a.remove();
    b.remove();
  });

  it('runs the job as it is when there is no portal to isolate, rather than hiding every note', async () => {
    const seen = await printOnly(null, () => document.body.classList.contains('ob-printing'));
    expect(seen).toBe(false);
  });
});

describe('the number on the sheet', () => {
  const POLEAD = { ...LEAD, poNumber: 'PO/2026-27/00042' } as unknown as Lead;
  const POORDER = { ...ORDER, poNumber: 'PO/2026-27/00042' } as unknown as Order;

  it('prints the PO number of a pending order and of a final order made from one, and the id when there is none', async () => {
    mount({ record: POLEAD, initialKind: 'filling', desktop: { printPage: vi.fn(), savePdf: vi.fn().mockResolvedValue({ ok: true }) } });
    expect(screen.getAllByText('PO/2026-27/00042').length).toBeGreaterThan(0);
    expect(screen.queryByText(LEAD.id)).toBeNull();
    // The eyebrow still follows the source, whatever the number looks like.
    expect(screen.getAllByText(t('orderNote.pendingOrderNo')).length).toBeGreaterThan(0);
    cleanup();

    mount({ record: POORDER, source: 'order', initialKind: 'filling' });
    expect(screen.getAllByText('PO/2026-27/00042').length).toBeGreaterThan(0);
    expect(screen.queryByText(ORDER.id)).toBeNull();
    expect(screen.getAllByText(t('orderNote.orderId')).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('orderNote.pendingOrderNo'))).toBeNull();
    cleanup();

    // No PO number (a pre-1.3 Master): the id, as before.
    mount({ record: ORDER, source: 'order', initialKind: 'filling' });
    expect(screen.getAllByText(ORDER.id).length).toBeGreaterThan(0);
  });

  it('names the saved file for the PO number', async () => {
    const savePdf = vi.fn().mockResolvedValue({ ok: true, path: 'C:\\out.pdf' });
    mount({ record: POLEAD, initialKind: 'filling', desktop: { printPage: vi.fn(), savePdf } });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.savePdf') }));
    await waitFor(() => expect(savePdf).toHaveBeenCalledWith({ fileName: 'PO/2026-27/00042-filling.pdf' }));
  });
});

describe('one print or Save PDF at a time', () => {
  function deferred() {
    let finish: (value: { ok: boolean }) => void = () => undefined;
    const promise = new Promise<{ ok: boolean }>((resolve) => {
      finish = resolve;
    });
    return { promise, finish };
  }

  it('sends one job while a print runs: a second click, Ctrl+P (even auto-repeated) and Save PDF are ignored, and both buttons are disabled', async () => {
    const job = deferred();
    const printPage = vi.fn(() => job.promise);
    const savePdf = vi.fn().mockResolvedValue({ ok: true });
    mount({ desktop: { printPage, savePdf } });
    const print = screen.getByRole('button', { name: t('orderNote.print') });
    const save = screen.getByRole('button', { name: t('orderNote.savePdf') });

    fireEvent.click(print);
    fireEvent.click(print);
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, repeat: true });
    fireEvent.click(save);
    await waitFor(() => expect((print as HTMLButtonElement).disabled).toBe(true));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(printPage).toHaveBeenCalledTimes(1);
    expect(savePdf).not.toHaveBeenCalled();

    job.finish({ ok: true });
    await waitFor(() => expect((print as HTMLButtonElement).disabled).toBe(false));
    expect((save as HTMLButtonElement).disabled).toBe(false);

    // Free again: the next press prints.
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    await waitFor(() => expect(printPage).toHaveBeenCalledTimes(2));
    job.finish({ ok: true });
  });

  it('ignores a held Ctrl+P on its own: the first press prints, the repeats do not', async () => {
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    mount({ desktop: { printPage } });
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    await waitFor(() => expect(printPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: t('orderNote.print') }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, repeat: true });
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, repeat: true });
    await wait(20);
    expect(printPage).toHaveBeenCalledTimes(1);
  });

  it('sends no print while a Save PDF runs, and frees both once it ends', async () => {
    const job = deferred();
    const savePdf = vi.fn(() => job.promise);
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    mount({ desktop: { printPage, savePdf } });

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.savePdf') }));
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.savePdf') }));
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    await waitFor(() => expect((screen.getByRole('button', { name: t('orderNote.print') }) as HTMLButtonElement).disabled).toBe(true));
    expect(savePdf).toHaveBeenCalledTimes(1);
    expect(printPage).not.toHaveBeenCalled();

    job.finish({ ok: true });
    await waitFor(() => expect((screen.getByRole('button', { name: t('orderNote.print') }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('the print stylesheet', () => {
  it('shows a note portal on paper only when printOnly marked it, never on the strength of the printing flag alone', () => {
    const css = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'order-note.css'), 'utf8');
    const print = css.slice(css.indexOf('@media print'));
    // The portal is hidden on screen and in print unless it is the active one.
    expect(css).toMatch(/\.ob-note-print-portal \{\s*display: none;/);
    expect(print).toMatch(/\.ob-note-print-portal--active \{\s*display: block;/);
    // No rule shows every portal in print (which printed hidden kept-alive notes from a browser-menu print).
    expect(print).not.toMatch(/(^|[\s,])\.ob-note-print-portal \{\s*display: block/);
  });
});
