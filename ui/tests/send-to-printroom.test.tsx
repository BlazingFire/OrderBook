/**
 * "Send to Printroom": what a send carries, that a retry cannot queue a second
 * sheet, that an offline Printroom is not offered, and what the sender is told
 * when the Master is away. Also that the note screen offers the button only
 * where a send can succeed.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead, PrintJob, PrintJobInput, PrintStation } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { OrderNoteScreen } from '../src/OrderNoteScreen.js';
import type { PrintroomTransport } from '../src/printroomModel.js';
import { SendToPrintroomDialog, type SendToPrintroomDialogProps } from '../src/SendToPrintroomDialog.js';
import { ToastProvider } from '../src/Toast.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => installBrowserStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STATIONS: PrintStation[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Front desk', printerName: 'HP', autoPrint: true, online: true, lastSeenAt: null, isSelf: false },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Back office', printerName: null, autoPrint: false, online: false, lastSeenAt: null, isSelf: false },
];

function makeTransport(overrides: Partial<PrintroomTransport> = {}): PrintroomTransport {
  return {
    listJobs: vi.fn(),
    getJob: vi.fn(),
    sendJob: vi.fn(async () => ({ id: 'J1' }) as PrintJob),
    markJob: vi.fn(),
    cancelJob: vi.fn(),
    claimJob: vi.fn(),
    listStations: vi.fn(async () => STATIONS),
    saveStation: vi.fn(),
    subscribe: () => () => undefined,
    ...overrides,
  };
}

function mount(transport: PrintroomTransport, props: Partial<SendToPrintroomDialogProps> = {}) {
  const onClose = vi.fn();
  const onSent = vi.fn();
  const view = render(
    <ToastProvider>
      <SendToPrintroomDialog
        open
        onClose={onClose}
        onSent={onSent}
        transport={transport}
        source="lead"
        sourceId="LD0000000042"
        label="PO/2026-27/00007 · Shree Ceramics"
        initialKind="dispatch"
        initialVehicle="GJ 01 AB 1"
        initialCopies={2}
        {...props}
      />
    </ToastProvider>,
  );
  return { ...view, onClose, onSent };
}

const sendButton = () => screen.getByRole('button', { name: t('printroom.dialog.send') });

describe('what a send carries', () => {
  it('names the record, the copies, the note, the vehicle and the printroom, with a 32-hex request id', async () => {
    const transport = makeTransport();
    const { onClose, onSent } = mount(transport);
    await screen.findByRole('option', { name: 'Front desk' });

    fireEvent.change(screen.getByLabelText(t('printroom.column.copies')), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(t('printroom.dialog.target')), { target: { value: STATIONS[0]!.id } });
    fireEvent.change(screen.getByLabelText(t('orderNote.vehicleNo')), { target: { value: 'mh 12  xy 99' } });
    fireEvent.change(screen.getByLabelText(t('printroom.dialog.note')), { target: { value: '  By noon  ' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(transport.sendJob).toHaveBeenCalledTimes(1);
    const input = vi.mocked(transport.sendJob).mock.calls[0]![0];
    expect(input.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(input).toMatchObject({
      kind: 'dispatch',
      source: 'lead',
      sourceId: 'LD0000000042',
      copies: 4,
      targetStationId: STATIONS[0]!.id,
      vehicleNumber: 'MH 12 XY 99',
      note: 'By noon',
    });
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText(t('printroom.dialog.sent'))).not.toBeNull();
  });

  it('sends no vehicle with a Filling note, and no printroom unless one is chosen', async () => {
    const transport = makeTransport();
    mount(transport, { initialKind: 'filling' });
    await screen.findByRole('option', { name: 'Front desk' });
    expect(screen.queryByLabelText(t('orderNote.vehicleNo'))).toBeNull();

    fireEvent.click(sendButton());
    await waitFor(() => expect(transport.sendJob).toHaveBeenCalled());
    expect(vi.mocked(transport.sendJob).mock.calls[0]![0]).toMatchObject({
      kind: 'filling',
      vehicleNumber: null,
      targetStationId: null,
      note: null,
    });
  });

  it('carries the sender bold tick, and null when none was given (15x, 2026-10-25)', async () => {
    const ticked = makeTransport();
    mount(ticked, { bold: false });
    await screen.findByRole('option', { name: 'Front desk' });
    fireEvent.click(sendButton());
    await waitFor(() => expect(ticked.sendJob).toHaveBeenCalled());
    expect(vi.mocked(ticked.sendJob).mock.calls[0]![0]).toMatchObject({ bold: false });
    cleanup();

    const plain = makeTransport();
    mount(plain);
    await screen.findByRole('option', { name: 'Front desk' });
    fireEvent.click(sendButton());
    await waitFor(() => expect(plain.sendJob).toHaveBeenCalled());
    expect(vi.mocked(plain.sendJob).mock.calls[0]![0]).toMatchObject({ bold: null });
  });

  it('switches to the Dispatch note\'s vehicle field and back', async () => {
    mount(makeTransport(), { initialKind: 'filling' });
    expect(screen.queryByLabelText(t('orderNote.vehicleNo'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.dispatch') }));
    expect(screen.getByLabelText(t('orderNote.vehicleNo'))).not.toBeNull();
  });
});

describe('copies', () => {
  it('will not send a count outside 1 to 50, and says why', async () => {
    const transport = makeTransport();
    mount(transport);
    const copies = screen.getByLabelText(t('printroom.column.copies'));

    for (const bad of ['0', '51', '2.5', '']) {
      fireEvent.change(copies, { target: { value: bad } });
      expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(t('validation.print.copies'))).not.toBeNull();
    }
    fireEvent.click(sendButton());
    expect(transport.sendJob).not.toHaveBeenCalled();

    fireEvent.change(copies, { target: { value: '50' } });
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the printrooms offered', () => {
  it('lists Any Printroom and each station, an offline one disabled and marked', async () => {
    mount(makeTransport());
    const select = screen.getByLabelText(t('printroom.dialog.target'));
    await within(select).findByRole('option', { name: 'Front desk' });

    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((option) => option.textContent)).toEqual([
      t('printroom.station.anyStation'),
      'Front desk',
      `Back office (${t('printroom.station.offline')})`,
    ]);
    expect(options.map((option) => option.disabled)).toEqual([false, false, true]);
  });

  it('still opens when the printrooms cannot be read', async () => {
    mount(makeTransport({ listStations: vi.fn().mockRejectedValue(new Error('away')) }));
    expect(within(screen.getByLabelText(t('printroom.dialog.target'))).getAllByRole('option')).toHaveLength(1);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('a retry', () => {
  it('keeps one request id while the dialog stays open, so a second press cannot queue a second sheet', async () => {
    const sendJob = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'timeout' }))
      .mockResolvedValue({ id: 'J1' } as PrintJob);
    const transport = makeTransport({ sendJob });
    const { onSent } = mount(transport);

    fireEvent.click(sendButton());
    await waitFor(() => expect(sendJob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSent).toHaveBeenCalled());

    expect(sendJob.mock.calls[1]![0].requestId).toBe(sendJob.mock.calls[0]![0].requestId);
  });

  it('gives each opening of the dialog a fresh request id', async () => {
    const sendJob = vi.fn(async (_input: PrintJobInput) => ({ id: 'J1' }) as PrintJob);
    const transport = makeTransport({ sendJob });

    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <ToastProvider>
          <button onClick={() => setOpen(true)}>reopen</button>
          <SendToPrintroomDialog
            open={open}
            onClose={() => setOpen(false)}
            transport={transport}
            source="order"
            sourceId="OD1"
            label="x"
            initialKind="filling"
          />
        </ToastProvider>
      );
    }
    render(<Host />);
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendJob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByText('reopen'));
    fireEvent.click(await screen.findByRole('button', { name: t('printroom.dialog.send') }));
    await waitFor(() => expect(sendJob).toHaveBeenCalledTimes(2));
    expect(sendJob.mock.calls[1]![0].requestId).not.toBe(sendJob.mock.calls[0]![0].requestId);
  });
});

describe('when the send fails', () => {
  it('says the Master is not reachable and offers the local print instead, leaving the dialog open', async () => {
    const away = Object.assign(new Error('Master not reachable'), { code: 'unavailable' });
    const { onClose, onSent } = mount(makeTransport({ sendJob: vi.fn().mockRejectedValue(away) }));

    fireEvent.click(sendButton());
    expect(await screen.findByText(t('printroom.dialog.offline'))).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('shows the Master\'s own refusal in the reader\'s language', async () => {
    const refused = Object.assign(new Error('x'), { code: 'validation_error', messageKey: 'validation.print.station' });
    mount(makeTransport({ sendJob: vi.fn().mockRejectedValue(refused) }));
    fireEvent.click(sendButton());
    expect(await screen.findByText(t('validation.print.station'))).not.toBeNull();
  });
});

// --- The button on the note screen ---------------------------------------------------

describe('the note screen\'s Send to Printroom', () => {
  const ITEMS = [
    {
      id: 'li-1', variantId: 'v1', productId: 'p1', productName: 'Rustic Wood', categoryName: 'Duragres',
      size: '600x600', brandName: null, variantLabel: 'Ivory', colour: null, grade: 'Std', packaging: 'Box',
      quantity: 12, weightKg: 2, lineWeightKg: 24,
    },
  ];
  const lead = (id: string) =>
    ({ id, partyName: 'Shree Ceramics', createdAt: '2026-10-01T05:00:00.000Z', items: ITEMS, totalWeightKg: 24, convertedOrderId: null }) as unknown as Lead;

  function note(record: Lead, printroom: PrintroomTransport | undefined) {
    return render(
      <ToastProvider>
        <OrderNoteScreen
          record={record}
          source="lead"
          party={null}
          initialKind="filling"
          canEditVehicle={false}
          onSaveVehicle={async () => undefined}
          onBack={() => undefined}
          printroom={printroom}
        />
      </ToastProvider>,
    );
  }

  it('is absent without the right (no transport), and absent for a record the Master does not have yet', () => {
    note(lead('LD0000000042'), undefined);
    expect(screen.queryByRole('button', { name: t('orderNote.sendToPrintroom') })).toBeNull();
    cleanup();

    // An offline-made pending order still carries the id its panel minted.
    note(lead('A3F9K2000000001'), makeTransport());
    expect(screen.queryByRole('button', { name: t('orderNote.sendToPrintroom') })).toBeNull();
  });

  it('opens the dialog for the record, starting from the note kind and copies on screen', async () => {
    const transport = makeTransport();
    note(lead('LD0000000042'), transport);
    fireEvent.change(screen.getByLabelText(t('orderNote.copies')), { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.sendToPrintroom') }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(t('printroom.column.copies')) as HTMLInputElement).value).toBe('3');

    fireEvent.click(within(dialog).getByRole('button', { name: t('printroom.dialog.send') }));
    await waitFor(() => expect(transport.sendJob).toHaveBeenCalled());
    expect(vi.mocked(transport.sendJob).mock.calls[0]![0]).toMatchObject({
      kind: 'filling',
      source: 'lead',
      sourceId: 'LD0000000042',
      copies: 3,
    });
  });
});
