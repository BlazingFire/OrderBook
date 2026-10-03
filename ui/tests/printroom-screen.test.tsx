/**
 * The shared Printroom over a fake `PrintroomTransport`, the way both panels
 * mount it: the Waiting queue grouped by sender (a Server Master with the badge),
 * the pages and their queries, the search box, who sees which controls, the
 * station strip, a job with its sheets, printing it (N copies, then marked
 * printed), and the unreachable-Master state.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  noteDocument,
  type Lead,
  type PrintJob,
  type PrintJobPage,
  type PrintJobSummary,
  type PrintPerson,
  type PrintStation,
} from '@orderbook/shared';

import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { PrintroomScreen, usePrintWaiting, type PrintroomScreenProps } from '../src/PrintroomScreen.js';
import type { PrintEvent, PrintroomTransport } from '../src/printroomModel.js';
import { ToastProvider } from '../src/Toast.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.className = '';
  vi.restoreAllMocks();
});

// --- Fixtures -------------------------------------------------------------------

const person = (id: string, name: string, tier: PrintPerson['tier'] = 'office'): PrintPerson => ({
  id,
  displayName: name,
  avatar: null,
  tier,
});
const ASHA = person('US1', 'Asha');
const BINA = person('US2', 'Bina');
const CHETAN = person('US3', 'Chetan', 'server_master');

const LEAD = {
  id: 'LD0000000042',
  partyName: 'Shree Ceramics',
  createdAt: '2026-10-01T05:00:00.000Z',
  items: [
    {
      id: 'li-1', variantId: 'v1', productId: 'p1', productName: 'Rustic Wood', categoryName: 'Duragres',
      size: '600x600', brandName: null, variantLabel: 'Ivory', colour: null, grade: 'Std', packaging: 'Box',
      quantity: 12, weightKg: 2, lineWeightKg: 24,
    },
  ],
  totalWeightKg: 24,
  convertedOrderId: null,
} as unknown as Lead;

const DOCUMENT = noteDocument(LEAD, 'lead', null, null);

function summary(overrides: Partial<PrintJobSummary> & Pick<PrintJobSummary, 'id'>): PrintJobSummary {
  return {
    kind: 'filling',
    source: 'lead',
    sourceId: 'LD0000000042',
    sourceNumber: 'PO/2026-27/00007',
    partyName: 'Shree Ceramics',
    copies: 2,
    note: null,
    targetStation: null,
    status: 'queued',
    sender: ASHA,
    requestedFrom: 'master',
    requestedAt: '2026-10-03T05:00:00.000Z',
    claimedAt: null,
    claimedStationName: null,
    printedBy: null,
    printedAt: null,
    printerName: null,
    printedStationName: null,
    cancelledBy: null,
    cancelledAt: null,
    hasDocument: true,
    ...overrides,
  };
}

const page = (jobs: PrintJobSummary[], waitingCount = jobs.length, nextCursor: string | null = null): PrintJobPage => ({
  jobs,
  nextCursor,
  waitingCount,
});

interface Fake extends PrintroomTransport {
  emit: (event: PrintEvent) => void;
}

function makeTransport(overrides: Partial<PrintroomTransport> = {}, jobs: PrintJobSummary[] = []): Fake {
  const listeners = new Set<(event: PrintEvent) => void>();
  const transport: Fake = {
    listJobs: vi.fn(async () => page(jobs)),
    getJob: vi.fn(async (id) => ({ ...(jobs.find((job) => job.id === id) ?? summary({ id })), document: DOCUMENT }) as PrintJob),
    sendJob: vi.fn(async () => ({ ...summary({ id: 'new' }), document: DOCUMENT })),
    markJob: vi.fn(async (id, printed) => summary({ id, status: printed ? 'printed' : 'queued' })),
    cancelJob: vi.fn(async (id) => summary({ id, status: 'cancelled' })),
    claimJob: vi.fn(async () => null),
    listStations: vi.fn(async (): Promise<PrintStation[]> => []),
    saveStation: vi.fn(async (input) => ({
      id: 'ST1', name: 'Front desk', printerName: input.printerName, autoPrint: input.autoPrint,
      online: true, lastSeenAt: null, isSelf: true,
    })),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    ...overrides,
  };
  return transport;
}

function mount(transport: Fake, props: Partial<PrintroomScreenProps> = {}) {
  const onOpenJob = vi.fn();
  const view = render(
    <ToastProvider>
      <ConfirmProvider>
        <PrintroomScreen
          transport={transport}
          permissions={{ send: true, station: true }}
          viewerId="US1"
          page="waiting"
          openJobId={null}
          onOpenJob={onOpenJob}
          {...props}
        />
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { ...view, onOpenJob };
}

const PRINTERS = [
  { name: 'HP LaserJet', displayName: 'HP LaserJet', isDefault: true },
  { name: 'Epson', displayName: 'Epson', isDefault: false },
];

function install(printPage: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true }))) {
  return { listPrinters: vi.fn(async () => PRINTERS), printPage };
}

// --- The list -------------------------------------------------------------------

describe('the Waiting queue', () => {
  it('groups waiting jobs by who sent them, with the badge on a Server Master', async () => {
    const transport = makeTransport({}, [
      summary({ id: 'J1', sender: ASHA }),
      summary({ id: 'J2', sender: CHETAN, partyName: 'Owner Traders' }),
      summary({ id: 'J3', sender: ASHA, partyName: 'Second Party' }),
    ]);
    mount(transport);

    const heads = await screen.findAllByRole('banner');
    expect(heads.map((head) => head.textContent)).toEqual([
      expect.stringContaining('Asha'),
      expect.stringContaining('Chetan'),
    ]);
    expect(within(heads[0]!).queryByText(t('tier.server_master'))).toBeNull();
    expect(within(heads[1]!).getByText(t('tier.server_master'))).not.toBeNull();
    expect(within(heads[0]!).getByText(t('printroom.group.count', { count: 2 }))).not.toBeNull();
  });

  it('asks each page for its own list', async () => {
    const transport = makeTransport({}, [summary({ id: 'J1' })]);
    const view = mount(transport, { page: 'waiting' });
    await screen.findByText('Shree Ceramics');
    expect(transport.listJobs).toHaveBeenLastCalledWith({ status: 'waiting', mine: false });
    view.unmount();

    for (const [pageName, expected] of [
      ['printed', { status: 'printed', mine: false }],
      ['sentByMe', { status: 'all', mine: true }],
    ] as const) {
      const next = makeTransport({}, [summary({ id: 'J1', status: 'printed' })]);
      const shown = mount(next, { page: pageName });
      await waitFor(() => expect(next.listJobs).toHaveBeenCalledWith(expected));
      shown.unmount();
    }

    // Cancelled jobs are a toggle on the Printed page.
    const printed = makeTransport({}, [summary({ id: 'J1', status: 'printed' })]);
    mount(printed, { page: 'printed' });
    await waitFor(() => expect(printed.listJobs).toHaveBeenCalledWith({ status: 'printed', mine: false }));
    fireEvent.click(screen.getByRole('button', { name: t('printroom.filter.cancelled') }));
    await waitFor(() => expect(printed.listJobs).toHaveBeenLastCalledWith({ status: 'cancelled', mine: false }));
  });

  it('carries a search box the keyboard can reach, and filters party, number and sender', async () => {
    const transport = makeTransport({}, [
      summary({ id: 'J1', partyName: 'Shree Ceramics', sender: ASHA }),
      summary({ id: 'J2', partyName: 'Omkar Tiles', sourceNumber: 'PO/2026-27/00099', sender: BINA }),
    ]);
    mount(transport);
    await screen.findByText('Omkar Tiles');

    const box = screen.getByRole('searchbox') as HTMLInputElement;
    expect(box.hasAttribute('data-screen-search')).toBe(true);

    fireEvent.change(box, { target: { value: 'omkar' } });
    await waitFor(() => expect(screen.queryByText('Shree Ceramics')).toBeNull());
    fireEvent.change(box, { target: { value: '00007' } });
    await waitFor(() => expect(screen.getByText('Shree Ceramics')).not.toBeNull());
    expect(screen.queryByText('Omkar Tiles')).toBeNull();
    fireEvent.change(box, { target: { value: 'bina' } });
    await waitFor(() => expect(screen.getByText('Omkar Tiles')).not.toBeNull());
  });

  it('opens a job when its row is pressed', async () => {
    const transport = makeTransport({}, [summary({ id: 'J1' })]);
    const { onOpenJob } = mount(transport);
    fireEvent.click((await screen.findAllByRole('button', { name: t('printroom.action.open') }))[0]!);
    expect(onOpenJob).toHaveBeenCalledWith('J1');
  });

  it('shows the empty state, a skeleton first, and a retry after a failure', async () => {
    const empty = makeTransport({}, []);
    mount(empty);
    expect(await screen.findByText(t('printroom.empty.title'))).not.toBeNull();
    cleanup();

    const failing = makeTransport({ listJobs: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(page([])) });
    mount(failing);
    fireEvent.click(await screen.findByRole('button', { name: t('printroom.action.retry') }));
    await waitFor(() => expect(failing.listJobs).toHaveBeenCalledTimes(2));
  });

  it('says the Master is not reachable on a 503, without a retry button standing in for the page', async () => {
    const away = makeTransport({
      listJobs: vi.fn().mockRejectedValue(Object.assign(new Error('Master not reachable'), { code: 'unavailable' })),
    });
    mount(away);
    expect(await screen.findByText(t('printroom.error.offline'))).not.toBeNull();
    expect(screen.queryByText(t('printroom.error.load'))).toBeNull();
  });

  it('re-reads when a push arrives, and when the link comes back', async () => {
    const transport = makeTransport({}, [summary({ id: 'J1' })]);
    mount(transport);
    await screen.findByText('Shree Ceramics');
    const calls = vi.mocked(transport.listJobs).mock.calls.length;

    act(() => transport.emit({ kind: 'changed', job: summary({ id: 'J2' }) }));
    await waitFor(() => expect(vi.mocked(transport.listJobs).mock.calls.length).toBeGreaterThan(calls));
    const afterPush = vi.mocked(transport.listJobs).mock.calls.length;
    act(() => transport.emit({ kind: 'resync' }));
    await waitFor(() => expect(vi.mocked(transport.listJobs).mock.calls.length).toBeGreaterThan(afterPush));
  });

  it('pages with a cursor, adding the next page under the first', async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce(page([summary({ id: 'J1', partyName: 'First Page' })], 2, '5:cursor'))
      .mockResolvedValueOnce(page([summary({ id: 'J2', partyName: 'Second Page' })], 2, null));
    mount(makeTransport({ listJobs }));
    await screen.findByText('First Page');

    fireEvent.click(screen.getByRole('button', { name: t('printroom.action.more') }));
    await screen.findByText('Second Page');
    expect(listJobs).toHaveBeenLastCalledWith({ status: 'waiting', mine: false, cursor: '5:cursor' });
    expect(screen.queryByRole('button', { name: t('printroom.action.more') })).toBeNull();
  });
});

describe('who gets which controls', () => {
  const OTHERS = summary({ id: 'J1', sender: BINA });
  const MINE = summary({ id: 'J2', sender: ASHA, partyName: 'My Party' });

  it('shows a send-only person neither marking nor another\'s Cancel, and their own Cancel', async () => {
    const transport = makeTransport({}, [OTHERS, MINE]);
    mount(transport, { permissions: { send: true, station: false }, page: 'sentByMe' });
    await screen.findByText('My Party');

    expect(screen.queryByRole('button', { name: t('printroom.action.markPrinted') })).toBeNull();
    // Cancel exists once, for Asha's own job.
    expect(screen.getAllByRole('button', { name: t('printroom.action.cancel') })).toHaveLength(1);
  });

  it('shows a station holder Mark and Cancel on every job, and Mark not printed on a printed one', async () => {
    const transport = makeTransport({}, [OTHERS, MINE, summary({ id: 'J3', status: 'printed', partyName: 'Done Party' })]);
    mount(transport);
    await screen.findByText('Done Party');

    expect(screen.getAllByRole('button', { name: t('printroom.action.cancel') })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: t('printroom.action.markPrinted') })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: t('printroom.action.markNotPrinted') })).toHaveLength(1);
  });

  it('marks printed and not printed through the transport', async () => {
    const transport = makeTransport({}, [OTHERS, summary({ id: 'J3', status: 'printed', partyName: 'Done Party' })]);
    mount(transport);
    await screen.findByText('Done Party');

    fireEvent.click(screen.getByRole('button', { name: t('printroom.action.markPrinted') }));
    await waitFor(() => expect(transport.markJob).toHaveBeenCalledWith('J1', true));
    fireEvent.click(screen.getByRole('button', { name: t('printroom.action.markNotPrinted') }));
    await waitFor(() => expect(transport.markJob).toHaveBeenCalledWith('J3', false));
  });

  it('asks before cancelling, and cancels only on the confirm', async () => {
    const transport = makeTransport({}, [OTHERS]);
    mount(transport);
    await screen.findByText('Shree Ceramics');

    fireEvent.click(screen.getByRole('button', { name: t('printroom.action.cancel') }));
    expect(transport.cancelJob).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('printroom.action.cancel') }));
    await waitFor(() => expect(transport.cancelJob).toHaveBeenCalledWith('J1'));
  });

  it('says what went wrong when an action is refused', async () => {
    const transport = makeTransport(
      { markJob: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'forbidden', messageKey: 'validation.print.notPrintable' })) },
      [OTHERS],
    );
    mount(transport);
    fireEvent.click(await screen.findByRole('button', { name: t('printroom.action.markPrinted') }));
    expect(await screen.findByText(new RegExp(t('validation.print.notPrintable')))).not.toBeNull();
  });
});

describe('this PC as a station', () => {
  afterEach(() => {
    delete (window as Window & { orderbook?: unknown }).orderbook;
  });

  it('shows the strip only in the desktop app and only for print.station', async () => {
    const transport = makeTransport({}, [summary({ id: 'J1' })]);
    mount(transport, { desktop: install() });
    expect(await screen.findByRole('region', { name: t('printroom.station.title') })).not.toBeNull();
    cleanup();

    // No shell: a LAN browser cannot be a station.
    mount(makeTransport({}, [summary({ id: 'J1' })]));
    await screen.findByText('Shree Ceramics');
    expect(screen.queryByRole('region', { name: t('printroom.station.title') })).toBeNull();
    cleanup();

    // The shell, but a sender only.
    mount(makeTransport({}, [summary({ id: 'J1' })]), { desktop: install(), permissions: { send: true, station: false } });
    await screen.findByText('Shree Ceramics');
    expect(screen.queryByRole('region', { name: t('printroom.station.title') })).toBeNull();
  });

  it('keeps Auto-print off until a printer is chosen, saves the choice on this PC and tells the Master', async () => {
    const transport = makeTransport({}, []);
    mount(transport, { desktop: install() });
    const strip = await screen.findByRole('region', { name: t('printroom.station.title') });

    const autoPrint = within(strip).getByRole('switch') as HTMLInputElement;
    expect(autoPrint.disabled).toBe(true);
    expect(within(strip).getByText(t('printroom.station.autoPrintNeedsPrinter'))).not.toBeNull();

    const select = within(strip).getByLabelText(t('printroom.station.printer'));
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(PRINTERS.length + 1));
    fireEvent.change(select, { target: { value: 'HP LaserJet' } });
    await waitFor(() =>
      expect(transport.saveStation).toHaveBeenLastCalledWith({ printerName: 'HP LaserJet', autoPrint: false }),
    );
    expect(JSON.parse(window.localStorage.getItem('ob.printroom.station') ?? '{}')).toMatchObject({
      printerName: 'HP LaserJet',
      autoPrint: false,
    });

    await waitFor(() => expect((within(strip).getByRole('switch') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(within(strip).getByRole('switch'));
    await waitFor(() =>
      expect(transport.saveStation).toHaveBeenLastCalledWith({ printerName: 'HP LaserJet', autoPrint: true }),
    );
    expect(JSON.parse(window.localStorage.getItem('ob.printroom.station') ?? '{}').autoPrint).toBe(true);
  });

  it('lists the Printrooms with an online dot', async () => {
    const transport = makeTransport({
      listStations: vi.fn(async () => [
        { id: 'S1', name: 'Front desk', printerName: 'HP', autoPrint: true, online: true, lastSeenAt: null, isSelf: true },
        { id: 'S2', name: 'Back office', printerName: null, autoPrint: false, online: false, lastSeenAt: null, isSelf: false },
      ]),
    });
    mount(transport, { desktop: install() });
    const list = await screen.findByRole('list', { name: t('printroom.station.list') });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]!.querySelector('[data-online]')!.getAttribute('data-online')).toBe('true');
    expect(items[1]!.querySelector('[data-online]')!.getAttribute('data-online')).toBe('false');
    expect(within(items[0]!).getByText(t('printroom.station.online'))).not.toBeNull();
    expect(within(items[1]!).getByText(t('printroom.station.offline'))).not.toBeNull();
  });
});

// --- One job --------------------------------------------------------------------

describe('a job opened as a sub-screen', () => {
  it('shows who sent it, the message and the exact sheets, and goes back', async () => {
    const job = summary({ id: 'J1', sender: CHETAN, note: 'Needed by noon' });
    const transport = makeTransport({}, [job]);
    const { onOpenJob } = mount(transport, { openJobId: 'J1' });

    await screen.findByText(new RegExp('Needed by noon'));
    expect(screen.getByText(t('printroom.job.sentBy', { name: 'Chetan', from: 'master' }), { exact: false })).not.toBeNull();
    expect(screen.getAllByText(/PO\/2026-27\/00007/).length).toBeGreaterThan(0);
    // The sheets are the shared note renderer's: one in the preview, one in the print portal.
    expect(document.querySelectorAll('.ob-note-page').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll('.ob-note-print-portal')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: t('action.backToList') }));
    expect(onOpenJob).toHaveBeenCalledWith(null);
  });

  it('prints N copies through the shell on the chosen printer, then marks the job printed', async () => {
    const printPage = vi.fn(async () => ({ ok: true }));
    const transport = makeTransport({}, [summary({ id: 'J1', copies: 3 })]);
    mount(transport, { openJobId: 'J1', desktop: install(printPage) });

    const button = await screen.findByRole('button', { name: t('printroom.action.printCopies', { n: 3 }) });
    const printerSelect = screen.getByLabelText(t('orderNote.printer'));
    await waitFor(() => expect(within(printerSelect).getAllByRole('option')).toHaveLength(PRINTERS.length + 1));
    fireEvent.change(printerSelect, { target: { value: 'Epson' } });
    fireEvent.click(button);

    await waitFor(() => expect(printPage).toHaveBeenCalledWith({ deviceName: 'Epson', copies: 3 }));
    await waitFor(() => expect(transport.markJob).toHaveBeenCalledWith('J1', true, 'Epson'));
  });

  it('uses the copies typed, not the sender\'s, and refuses a count outside 1 to 50', async () => {
    const printPage = vi.fn(async () => ({ ok: true }));
    const transport = makeTransport({}, [summary({ id: 'J1', copies: 3 })]);
    mount(transport, { openJobId: 'J1', desktop: install(printPage) });
    await screen.findByRole('button', { name: t('printroom.action.printCopies', { n: 3 }) });

    const copies = screen.getByLabelText(t('printroom.column.copies')) as HTMLInputElement;
    fireEvent.change(copies, { target: { value: '51' } });
    expect((screen.getByRole('button', { name: t('printroom.action.print') }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(copies, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: t('printroom.action.printCopies', { n: 5 }) }));
    await waitFor(() => expect(printPage).toHaveBeenCalledWith({ deviceName: undefined, copies: 5 }));
  });

  it('marks only the portal being printed while the job runs, and puts the page back after', async () => {
    let active: string | null = null;
    let printing = false;
    const printPage = vi.fn(async () => {
      active = document.querySelector('.ob-note-print-portal--active') ? 'portal' : null;
      printing = document.body.classList.contains('ob-printing');
      return { ok: true };
    });
    const transport = makeTransport({}, [summary({ id: 'J1' })]);
    mount(transport, { openJobId: 'J1', desktop: install(printPage) });

    fireEvent.click(await screen.findByRole('button', { name: t('printroom.action.printCopies', { n: 2 }) }));
    await waitFor(() => expect(printPage).toHaveBeenCalled());
    expect(active).toBe('portal');
    expect(printing).toBe(true);
    await waitFor(() => expect(transport.markJob).toHaveBeenCalled());
    expect(document.body.classList.contains('ob-printing')).toBe(false);
    expect(document.querySelector('.ob-note-print-portal--active')).toBeNull();
  });

  it('does not mark a job printed when the print fails, and says so', async () => {
    const printPage = vi.fn(async () => ({ ok: false, error: 'Printer offline' }));
    const transport = makeTransport({}, [summary({ id: 'J1' })]);
    mount(transport, { openJobId: 'J1', desktop: install(printPage) });

    fireEvent.click(await screen.findByRole('button', { name: t('printroom.action.printCopies', { n: 2 }) }));
    expect(await screen.findByText(t('orderNote.printFailed', { error: 'Printer offline' }))).not.toBeNull();
    expect(transport.markJob).not.toHaveBeenCalled();
  });

  it('will not start a second print while one is running', async () => {
    let release: (value: { ok: boolean }) => void = () => undefined;
    const printPage = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => (release = resolve)));
    const transport = makeTransport({}, [summary({ id: 'J1' })]);
    mount(transport, { openJobId: 'J1', desktop: install(printPage) });

    const button = await screen.findByRole('button', { name: t('printroom.action.printCopies', { n: 2 }) });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(printPage).toHaveBeenCalledTimes(1));
    release({ ok: true });
    await waitFor(() => expect(transport.markJob).toHaveBeenCalledTimes(1));
  });

  it('hides Print for a job whose note has been removed, and says so', async () => {
    const transport = makeTransport(
      { getJob: vi.fn(async () => ({ ...summary({ id: 'J1', status: 'printed', hasDocument: false }), document: null })) },
      [],
    );
    mount(transport, { openJobId: 'J1', desktop: install() });

    expect(await screen.findByText(t('printroom.payloadExpired'))).not.toBeNull();
    expect(screen.queryByRole('button', { name: t('printroom.action.print') })).toBeNull();
    expect(document.querySelectorAll('.ob-note-print-portal')).toHaveLength(0);
  });

  it('gives a send-only person no Print or Mark, but Cancel on their own queued job', async () => {
    const transport = makeTransport({}, [summary({ id: 'J1', sender: ASHA })]);
    mount(transport, { openJobId: 'J1', permissions: { send: true, station: false }, desktop: install() });

    await screen.findByRole('button', { name: t('printroom.action.cancel') });
    expect(screen.queryByRole('button', { name: new RegExp(t('printroom.action.print')) })).toBeNull();
    expect(screen.queryByRole('button', { name: t('printroom.action.markPrinted') })).toBeNull();
  });

  it('offers no Cancel on someone else\'s job, or on one already being printed', async () => {
    mount(makeTransport({}, [summary({ id: 'J1', sender: BINA })]), {
      openJobId: 'J1',
      permissions: { send: true, station: false },
    });
    await screen.findByText(new RegExp('PO/2026-27/00007'));
    expect(screen.queryByRole('button', { name: t('printroom.action.cancel') })).toBeNull();
    cleanup();

    mount(makeTransport({}, [summary({ id: 'J2', status: 'printing', claimedStationName: 'Front desk' })]), { openJobId: 'J2' });
    expect(await screen.findByText(t('printroom.job.holding', { station: 'Front desk' }))).not.toBeNull();
    expect(screen.queryByRole('button', { name: t('printroom.action.cancel') })).toBeNull();
  });

  it('falls back to the browser print without a shell, and does not guess it printed', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const transport = makeTransport({}, [summary({ id: 'J1', copies: 1 })]);
    mount(transport, { openJobId: 'J1' });

    fireEvent.click(await screen.findByRole('button', { name: t('printroom.action.printCopies', { n: 1 }) }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(transport.markJob).not.toHaveBeenCalled();
  });
});

// --- The nav count ---------------------------------------------------------------

describe('usePrintWaiting', () => {
  function Probe({ transport, enabled }: { transport: PrintroomTransport; enabled: boolean }) {
    return <span data-testid="count">{usePrintWaiting(transport, enabled)}</span>;
  }

  it('reads how many are waiting, follows pushes, and asks for nothing when disabled', async () => {
    const listJobs = vi.fn().mockResolvedValue(page([], 4));
    const transport = makeTransport({ listJobs });
    const view = render(<Probe transport={transport} enabled />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('4'));
    expect(listJobs).toHaveBeenCalledWith({ status: 'waiting', limit: 1 });

    listJobs.mockResolvedValue(page([], 5));
    act(() => transport.emit({ kind: 'changed', job: summary({ id: 'J9' }) }));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('5'));
    view.unmount();

    const idle = makeTransport({ listJobs: vi.fn() });
    render(<Probe transport={idle} enabled={false} />);
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(idle.listJobs).not.toHaveBeenCalled();
  });
});
