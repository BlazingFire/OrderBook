/**
 * The auto-print station: nothing runs unless this PC asked to be one; jobs are
 * claimed one at a time before they are fetched or printed; a lost claim is
 * skipped; a failed print goes back to the queue, is reported once and is not
 * tried again; the station says it is alive every minute; and the one sheet it
 * mounts is gone after each job.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteDocument, type Lead, type PrintJob, type PrintJobSummary } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { PrintStationRunner, STATION_SETTLE_MS } from '../src/PrintStationRunner.js';
import { writeStationConfig, type PrintEvent, type PrintroomTransport } from '../src/printroomModel.js';
import { installBrowserStubs } from './panel-harness.js';

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

function summary(id: string, overrides: Partial<PrintJobSummary> = {}): PrintJobSummary {
  return {
    id, kind: 'filling', source: 'lead', sourceId: LEAD.id, sourceNumber: null, partyName: `Party ${id}`,
    copies: 2, note: null, targetStation: null, status: 'queued', sender: null, requestedFrom: 'master',
    requestedAt: '2026-10-03T05:00:00.000Z', claimedAt: null, claimedStationName: null, printedBy: null,
    printedAt: null, printerName: null, printedStationName: null, cancelledBy: null, cancelledAt: null,
    hasDocument: true, ...overrides,
  };
}

const full = (job: PrintJobSummary): PrintJob => ({ ...job, status: 'printing', document: DOCUMENT });

const listeners = new Set<(event: PrintEvent) => void>();
let queue: PrintJobSummary[];
let log: string[];

function makeTransport(overrides: Partial<PrintroomTransport> = {}): PrintroomTransport {
  return {
    listJobs: vi.fn(async () => ({ jobs: queue.filter((job) => job.status === 'queued'), nextCursor: null, waitingCount: queue.length })),
    getJob: vi.fn(),
    sendJob: vi.fn(),
    markJob: vi.fn(async (id, printed) => {
      log.push(`mark ${id} ${printed}`);
      const job = queue.find((entry) => entry.id === id);
      if (job) job.status = printed ? 'printed' : 'queued';
      return summary(id, { status: printed ? 'printed' : 'queued' });
    }),
    cancelJob: vi.fn(),
    claimJob: vi.fn(async (id) => {
      log.push(`claim ${id}`);
      const job = queue.find((entry) => entry.id === id);
      if (!job) return null;
      job.status = 'printing';
      return full(job);
    }),
    listStations: vi.fn(),
    saveStation: vi.fn(async (input) => ({
      id: 'ST1', name: 'Front desk', printerName: input.printerName, autoPrint: input.autoPrint,
      online: true, lastSeenAt: null, isSelf: true,
    })),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  };
}

const emit = (event: PrintEvent) => {
  for (const listener of [...listeners]) listener(event);
};

function shell(printPage = vi.fn(async () => ({ ok: true }))) {
  return {
    printPage,
    listPrinters: vi.fn(async () => [{ name: 'HP LaserJet', displayName: 'HP LaserJet', isDefault: true }]),
    setStationMode: vi.fn(async () => true),
  };
}

const configure = (overrides: Partial<{ printerName: string; autoPrint: boolean; displayName: string }> = {}) =>
  writeStationConfig({ printerName: 'HP LaserJet', autoPrint: true, displayName: '', ...overrides });

/** Runs the pending timers and promises until the runner is idle again. */
async function drain(ms = 200): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  // The runner mounts its sheet on a timer, as it does in the app: React must render when the timers
  // say so, not hold the update until an `act` scope closes around them.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  installBrowserStubs();
  window.localStorage.clear();
  vi.useFakeTimers();
  queue = [];
  log = [];
  listeners.clear();
});

afterEach(() => {
  cleanup();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useRealTimers();
  document.body.className = '';
  vi.restoreAllMocks();
});

describe('when it runs', () => {
  it('does nothing without Auto-print on, a printer chosen, the right, or a shell that can print', async () => {
    queue = [summary('J1')];
    const cases: Array<[string, () => void, boolean, ReturnType<typeof shell> | undefined]> = [
      ['no auto-print', () => configure({ autoPrint: false }), true, shell()],
      ['no printer', () => configure({ printerName: '' }), true, shell()],
      ['no right', () => configure(), false, shell()],
      ['no shell', () => configure(), true, undefined],
    ];
    for (const [, set, enabled, desktop] of cases) {
      window.localStorage.clear();
      set();
      const transport = makeTransport();
      const view = render(<PrintStationRunner transport={transport} enabled={enabled} desktop={desktop} />);
      await drain(70_000);
      expect(transport.saveStation).not.toHaveBeenCalled();
      expect(transport.listJobs).not.toHaveBeenCalled();
      expect(transport.claimJob).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('keeps the window rendering while it runs, and lets go when it stops', async () => {
    configure();
    const desktop = shell();
    const view = render(<PrintStationRunner transport={makeTransport()} enabled desktop={desktop} />);
    await drain();
    expect(desktop.setStationMode).toHaveBeenCalledWith(true);

    // Turning Auto-print off on this PC stops it at once.
    configure({ autoPrint: false });
    await vi.waitFor(() => expect(desktop.setStationMode).toHaveBeenLastCalledWith(false));
    view.unmount();
  });

  it('says it is alive at once and every minute after', async () => {
    configure({ displayName: 'Front desk' });
    const transport = makeTransport();
    render(<PrintStationRunner transport={transport} enabled desktop={shell()} />);
    await drain(10);
    expect(transport.saveStation).toHaveBeenCalledTimes(1);
    expect(transport.saveStation).toHaveBeenLastCalledWith({ displayName: 'Front desk', printerName: 'HP LaserJet', autoPrint: true });

    await drain(60_000);
    expect(transport.saveStation).toHaveBeenCalledTimes(2);
    await drain(60_000);
    expect(transport.saveStation).toHaveBeenCalledTimes(3);
  });
});

describe('working the queue', () => {
  it('claims each job before printing it, one at a time, oldest first, with its own copies, and marks it printed', async () => {
    configure();
    queue = [summary('J1', { copies: 3 }), summary('J2', { copies: 1 })];
    const order: string[] = [];
    const printPage = vi.fn(async (options: { deviceName?: string; copies?: number }) => {
      order.push(`print ${options.copies}`);
      // While one sheet is on the paper, exactly one portal is mounted and marked.
      expect(document.querySelectorAll('.ob-note-print-portal')).toHaveLength(1);
      expect(document.querySelectorAll('.ob-note-print-portal--active')).toHaveLength(1);
      return { ok: true };
    });
    const transport = makeTransport();
    render(<PrintStationRunner transport={transport} enabled desktop={shell(printPage)} />);
    await drain(STATION_SETTLE_MS * 8);

    expect(log).toEqual(['claim J1', 'mark J1 true', 'claim J2', 'mark J2 true']);
    expect(printPage.mock.calls.map(([options]) => options)).toEqual([
      { deviceName: 'HP LaserJet', copies: 3 },
      { deviceName: 'HP LaserJet', copies: 1 },
    ]);
    expect(vi.mocked(transport.markJob)).toHaveBeenCalledWith('J1', true, 'HP LaserJet');
    expect(order).toEqual(['print 3', 'print 1']);
    // After each job the sheet is gone.
    expect(document.querySelectorAll('.ob-note-print-portal')).toHaveLength(0);
    expect(document.body.classList.contains('ob-printing')).toBe(false);
  });

  it('skips a job another station got first, without printing or reporting it', async () => {
    configure();
    queue = [summary('J1'), summary('J2')];
    const transport = makeTransport({
      claimJob: vi.fn(async (id) => {
        log.push(`claim ${id}`);
        if (id === 'J1') return null;
        const job = queue.find((entry) => entry.id === id)!;
        job.status = 'printing';
        return full(job);
      }),
    });
    const onNotify = vi.fn();
    const printPage = vi.fn(async () => ({ ok: true }));
    render(<PrintStationRunner transport={transport} enabled desktop={shell(printPage)} onNotify={onNotify} />);
    await drain(STATION_SETTLE_MS * 6);

    expect(printPage).toHaveBeenCalledTimes(1);
    expect(log).toContain('claim J1');
    expect(log).toContain('mark J2 true');
    expect(log).not.toContain('mark J1 true');
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('gives a failed job back, reports it once, and does not try it again this session', async () => {
    configure();
    queue = [summary('J1', { partyName: 'Failing Party' })];
    const printPage = vi.fn(async () => ({ ok: false, error: 'Paper jam' }));
    const onNotify = vi.fn();
    const transport = makeTransport();
    render(<PrintStationRunner transport={transport} enabled desktop={shell(printPage)} onNotify={onNotify} />);
    await drain(STATION_SETTLE_MS * 4);

    expect(printPage).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith(t('printroom.autoPrintFailed', { party: 'Failing Party', error: 'Paper jam' }));
    // Back in the queue for a person at a printer.
    expect(log).toContain('mark J1 false');
    expect(queue[0]!.status).toBe('queued');

    // A push, a new minute and a reconnect later it is still not tried again.
    emit({ kind: 'changed', job: summary('J1') });
    await drain(STATION_SETTLE_MS * 4);
    emit({ kind: 'resync' });
    await drain(60_000);
    expect(printPage).toHaveBeenCalledTimes(1);
    expect(log.filter((line) => line === 'claim J1')).toHaveLength(1);
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.ob-note-print-portal')).toHaveLength(0);
  });

  it('treats a thrown print like a failed one, and a printer Windows no longer lists as a failure with no dialog', async () => {
    configure();
    queue = [summary('J1')];
    const throwing = vi.fn(async () => {
      throw new Error('driver crashed');
    });
    const onNotify = vi.fn();
    render(<PrintStationRunner transport={makeTransport()} enabled desktop={shell(throwing)} onNotify={onNotify} />);
    await drain(STATION_SETTLE_MS * 4);
    expect(onNotify).toHaveBeenCalledWith(t('printroom.autoPrintFailed', { party: 'Party J1', error: 'driver crashed' }));
    cleanup();

    // The chosen printer is not among those Windows lists: an unattended PC must not open a dialog.
    log = [];
    queue = [summary('J2')];
    const gone = shell();
    gone.listPrinters.mockResolvedValue([{ name: 'Other', displayName: 'Other', isDefault: true }]);
    const notified = vi.fn();
    render(<PrintStationRunner transport={makeTransport()} enabled desktop={gone} onNotify={notified} />);
    await drain(STATION_SETTLE_MS * 4);
    expect(gone.printPage).not.toHaveBeenCalled();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(log).toContain('mark J2 false');
  });

  it('leaves alone a job aimed at another station, and takes one aimed at itself', async () => {
    configure();
    queue = [
      summary('J1', { targetStation: { id: 'ST2', name: 'Back office' } }),
      summary('J2', { targetStation: { id: 'ST1', name: 'Front desk' } }),
    ];
    const printPage = vi.fn(async () => ({ ok: true }));
    render(<PrintStationRunner transport={makeTransport()} enabled desktop={shell(printPage)} />);
    await drain(STATION_SETTLE_MS * 6);

    expect(log).toEqual(['claim J2', 'mark J2 true']);
    expect(printPage).toHaveBeenCalledTimes(1);
  });

  it('picks up a job that arrives later, from a push', async () => {
    configure();
    const printPage = vi.fn(async () => ({ ok: true }));
    const transport = makeTransport();
    render(<PrintStationRunner transport={transport} enabled desktop={shell(printPage)} />);
    await drain(STATION_SETTLE_MS * 4);
    expect(printPage).not.toHaveBeenCalled();

    queue = [summary('J9')];
    emit({ kind: 'changed', job: summary('J9') });
    await drain(STATION_SETTLE_MS * 4);
    expect(log).toEqual(['claim J9', 'mark J9 true']);
  });

  it('ignores a push about a job that is not waiting', async () => {
    configure();
    const transport = makeTransport();
    render(<PrintStationRunner transport={transport} enabled desktop={shell()} />);
    await drain(STATION_SETTLE_MS * 4);
    const reads = vi.mocked(transport.listJobs).mock.calls.length;

    emit({ kind: 'changed', job: summary('J1', { status: 'printed' }) });
    await drain(STATION_SETTLE_MS * 4);
    expect(vi.mocked(transport.listJobs).mock.calls.length).toBe(reads);
  });

  it('survives a Master that is out of reach and tries again with the next beat', async () => {
    configure();
    queue = [summary('J1')];
    const listJobs = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('away'), { code: 'unavailable' }))
      .mockImplementation(async () => ({ jobs: queue, nextCursor: null, waitingCount: 1 }));
    const printPage = vi.fn(async () => ({ ok: true }));
    render(<PrintStationRunner transport={makeTransport({ listJobs })} enabled desktop={shell(printPage)} />);
    await drain(STATION_SETTLE_MS * 4);
    expect(printPage).not.toHaveBeenCalled();

    await drain(60_000);
    expect(printPage).toHaveBeenCalledTimes(1);
  });
});
