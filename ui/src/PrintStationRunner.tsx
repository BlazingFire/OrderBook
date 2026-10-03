/**
 * The auto-print station: an invisible component mounted at the top of a panel
 * (not inside the Printroom screen, whose effects stop when the screen is hidden)
 * that prints the Printroom's waiting jobs by itself on a PC that has chosen to
 * be a station (docs/ORDER_NOTES_PLAN.md).
 *
 * It runs only while this PC's settings say so (a printer chosen and Auto-print
 * on) and the shell can print. For as long as it runs it asks the shell to keep
 * the window rendering when minimised (`setStationMode`), says it is alive every
 * minute (`saveStation`), and works through the queue strictly one job at a time:
 * claim, mount the one sheet, print silently with the job's copies, mark printed,
 * unmount. A claim is how two stations avoid printing the same sheet; a job it
 * loses is skipped, and a job whose print fails is given back to the queue,
 * reported once, and not tried again in this session until a person prints it.
 *
 * A printer Windows does not list is a failure here, never a dialog: an
 * unattended PC has nobody to answer one.
 */

import type { DesktopBridge, PrintJob } from '@orderbook/shared';
import { PRINT_LIMITS } from '@orderbook/shared';
import { useEffect, useRef, useState } from 'react';

import { NoteDocumentPortal } from './NoteDocumentPortal.js';
import { printOnly } from './printPortal.js';
import { runnableJobs, useStationConfig, type PrintroomTransport } from './printroomModel.js';
import { t } from './i18n.js';

/** How long the sheet gets to lay out and its fonts to load before the page is printed. */
export const STATION_SETTLE_MS = 50;
/** Most jobs read at a time. */
const BATCH = 20;

export interface PrintStationRunnerProps {
  transport: PrintroomTransport;
  /** Whether the person here may run a station (`print.station`). */
  enabled: boolean;
  desktop: Pick<DesktopBridge, 'printPage' | 'listPrinters' | 'setStationMode'> | undefined;
  /** Something the people at this PC should see, such as a print that failed. */
  onNotify?: (message: string) => void;
}

/** Waits for a rendered sheet to be ready: a macrotask (a hidden window has no animation frames) and the fonts. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, STATION_SETTLE_MS));
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) await fonts.ready.catch(() => undefined);
}

export function PrintStationRunner({ transport, enabled, desktop, onNotify }: PrintStationRunnerProps) {
  const config = useStationConfig();
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;

  const portalRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState<PrintJob | null>(null);
  const [printedAt] = useState(() => new Date());

  const active = enabled && config.autoPrint && config.printerName !== '' && !!desktop?.printPage;
  const printerName = config.printerName;
  const displayName = config.displayName;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let working = false;
    let again = false;
    let stationId: string | null = null;
    const failed = new Set<string>();

    void desktopRef.current?.setStationMode?.(true);

    const fail = (job: PrintJob, reason: string): void => {
      failed.add(job.id);
      notifyRef.current?.(t('printroom.autoPrintFailed', { party: job.partyName, error: reason }));
      // Back to the queue, so a person at a printer can take it.
      void transportRef.current.markJob(job.id, false).catch(() => undefined);
    };

    const printOne = async (job: PrintJob): Promise<void> => {
      const shell = desktopRef.current;
      if (!shell?.printPage || !job.document) return fail(job, '—');

      const installed = (await shell.listPrinters?.().catch(() => [])) ?? [];
      if (!installed.some((printer) => printer.name === printerName)) {
        return fail(job, printerName);
      }

      setCurrent(job);
      await settle();
      if (stopped) return;
      try {
        const printPage = shell.printPage;
        const result = await printOnly(portalRef.current, () =>
          printPage({ deviceName: printerName, copies: job.copies }),
        );
        if (!result.ok) return fail(job, result.error ?? '—');
        await transportRef.current.markJob(job.id, true, printerName);
      } catch (caught) {
        fail(job, caught instanceof Error ? caught.message : '—');
      }
    };

    const drain = async (): Promise<void> => {
      if (working) {
        again = true;
        return;
      }
      working = true;
      try {
        let rerun = true;
        while (rerun && !stopped) {
          again = false;
          const page = await transportRef.current.listJobs({ status: 'waiting', limit: BATCH });
          let progressed = false;
          for (const summary of runnableJobs(page.jobs, stationId, failed)) {
            if (stopped) return;
            const job = await transportRef.current.claimJob(summary.id);
            // Somebody else got there first: not an error.
            if (!job) continue;
            progressed = true;
            await printOne(job);
            setCurrent(null);
          }
          // Another pass for more than a batch, and for work that arrived while this one ran.
          rerun = progressed || again;
        }
      } catch {
        // The Master is out of reach, or refused: the next push or heartbeat tries again.
      } finally {
        working = false;
        setCurrent(null);
      }
    };

    const beat = async (): Promise<void> => {
      try {
        const station = await transportRef.current.saveStation({
          ...(displayName !== '' ? { displayName } : {}),
          printerName,
          autoPrint: true,
        });
        stationId = station.id;
        void drain();
      } catch {
        // Unreachable now; the next beat says so again.
      }
    };

    void beat();
    const timer = window.setInterval(() => void beat(), PRINT_LIMITS.stationBeatMs);
    const unsubscribe = transportRef.current.subscribe((event) => {
      if (event.kind === 'resync' || (event.kind === 'changed' && event.job.status === 'queued')) void drain();
    });

    return () => {
      stopped = true;
      window.clearInterval(timer);
      unsubscribe();
      void desktopRef.current?.setStationMode?.(false);
    };
  }, [active, printerName, displayName]);

  if (!current?.document) return null;
  return (
    <NoteDocumentPortal
      document={current.document}
      kind={current.kind}
      printedAt={printedAt}
      portalRef={portalRef}
    />
  );
}
