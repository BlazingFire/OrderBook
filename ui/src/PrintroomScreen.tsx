/**
 * The Printroom, on both panels: the shared print queue (docs/ORDER_NOTES_PLAN.md).
 *
 * The list shows Waiting (grouped by who sent them, a Server Master with the
 * badge), Printed, Cancelled and Sent by me. Opening a job is a sub-screen with
 * a back button and a nested sidebar entry: it shows the exact sheets the sender
 * froze, and a station holder prints them (N copies), marks them printed or not
 * printed, or cancels them. On the desktop shell a holder of `print.station`
 * also gets a strip for this PC: which printer, Auto-print on or off, and the
 * Printrooms senders can aim at with their online dots.
 *
 * Everything a panel supplies comes in through `PrintroomTransport` and a few
 * props; the screen holds the transport in a ref (`no-transport-dep.test.ts`).
 * Every control a right gates is absent without it, never greyed; the Master
 * decides every call again.
 */

import type { DesktopBridge, PrintJob, PrintJobSummary, PrintStation } from '@orderbook/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Avatar } from './Avatar.js';
import { Button } from './Button.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { StatusPill, type PillTone } from './DataDisplay.js';
import { EditorScreen } from './EditorScreen.js';
import { apiErrorText } from './errorText.js';
import { Input, Switch } from './Form.js';
import { formatDateTime } from './format.js';
import { t } from './i18n.js';
import { useUnsavedWork } from './unsavedWork.js';
import { NoteDocumentPortal, NoteDocumentSheets } from './NoteDocumentPortal.js';
import { printOnly } from './printPortal.js';
import {
  groupBySender,
  jobMatches,
  jobNumber,
  useStationConfig,
  writeStationConfig,
  type PrintroomTransport,
} from './printroomModel.js';
import { EmptyState, ErrorState, OfflineBanner, SkeletonRows } from './States.js';
import { useSubNav } from './SubNavSlot.js';
import { FilterChip } from './FilterBar.js';
import { ServerMasterBadge } from './TierPill.js';
import { useDebounced } from './useDebounced.js';
import { useToast } from './Toast.js';

/** A burst of pushes is folded into one read of the list. */
const REFRESH_MS = 400;

/** The sidebar's pages under Printroom. */
export type PrintPage = 'waiting' | 'printed' | 'sentByMe';

type Filter = 'waiting' | 'printed' | 'cancelled' | 'mine';

const STATUS_TONE: Record<PrintJobSummary['status'], PillTone> = {
  queued: 'accent',
  printing: 'offline',
  printed: 'ok',
  cancelled: 'default',
};

const STATUS_LABEL = {
  queued: 'printroom.status.queued',
  printing: 'printroom.status.printing',
  printed: 'printroom.status.printed',
  cancelled: 'printroom.status.cancelled',
} as const;

const isUnavailable = (caught: unknown): boolean =>
  (caught as { code?: unknown } | null)?.code === 'unavailable';

// --- The sidebar badge --------------------------------------------------------------

/**
 * How many jobs are waiting for paper, for the nav row, the Dashboard and the
 * Basic Home tile. Re-read a moment after any push and after a reconnect.
 * `enabled` is false for somebody holding neither Printroom right, who must not
 * even ask.
 */
export function usePrintWaiting(transport: PrintroomTransport, enabled: boolean): number {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setWaiting(0);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const read = (): void => {
      void transportRef.current.listJobs({ status: 'waiting', limit: 1 }).then(
        (page) => {
          if (!cancelled) setWaiting(page.waitingCount);
        },
        () => undefined,
      );
    };
    const later = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(read, REFRESH_MS);
    };
    read();
    const unsubscribe = transportRef.current.subscribe(later);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled]);

  return waiting;
}

// --- The station strip ------------------------------------------------------------------

function StationStrip({
  transport,
  desktop,
}: {
  transport: PrintroomTransport;
  desktop: Pick<DesktopBridge, 'listPrinters'>;
}) {
  const toast = useToast();
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const config = useStationConfig();
  const [printers, setPrinters] = useState<Array<{ name: string; displayName: string }>>([]);
  const [stations, setStations] = useState<PrintStation[]>([]);
  const [name, setName] = useState(config.displayName);

  useEffect(() => {
    let cancelled = false;
    void desktop.listPrinters?.().then(
      (list) => {
        if (!cancelled) setPrinters(list);
      },
      () => undefined,
    );
    const readStations = (): void => {
      void transportRef.current.listStations().then(
        (found) => {
          if (!cancelled) setStations(found);
        },
        () => undefined,
      );
    };
    readStations();
    const unsubscribe = transportRef.current.subscribe(readStations);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [desktop]);

  // A remembered printer that has gone is not offered as chosen.
  const chosen = printers.some((printer) => printer.name === config.printerName) ? config.printerName : '';

  /** True when the station was saved on the Master; a failure is shown as a toast and answers false. */
  async function save(next: { printerName: string; autoPrint: boolean; displayName: string }): Promise<boolean> {
    writeStationConfig(next);
    try {
      await transportRef.current.saveStation({
        ...(next.displayName !== '' ? { displayName: next.displayName } : {}),
        printerName: next.printerName === '' ? null : next.printerName,
        autoPrint: next.autoPrint,
      });
      return true;
    } catch (caught) {
      toast.push(apiErrorText(caught, 'printroom.error.load'), { tone: 'error' });
      return false;
    }
  }

  // "Save all and update": a station name typed and not yet saved (it saves when the
  // field loses focus) is saved.
  useUnsavedWork(
    'print-station-name',
    name.trim() !== config.displayName
      ? {
          label: t('updates.saveAll.stationName', { name: name.trim() || '…' }),
          save: () => save({ ...config, displayName: name.trim() }),
        }
      : null,
  );

  return (
    <section className="ob-print-station" aria-label={t('printroom.station.title')}>
      <h2 className="ob-print-station-title">{t('printroom.station.title')}</h2>
      <div className="ob-print-station-fields">
        <label className="ob-note-toolbar-item">
          <span className="ob-small">{t('printroom.station.printer')}</span>
          <select
            className="ob-input"
            value={chosen}
            onChange={(event) =>
              void save({
                ...config,
                printerName: event.target.value,
                // No printer, no auto-print.
                autoPrint: event.target.value === '' ? false : config.autoPrint,
              })
            }
          >
            <option value="">{t('printroom.station.printerNone')}</option>
            {printers.map((printer) => (
              <option key={printer.name} value={printer.name}>
                {printer.displayName || printer.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ob-note-toolbar-item">
          <span className="ob-small">{t('printroom.station.name')}</span>
          <Input
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              const next = name.trim();
              if (next !== config.displayName) void save({ ...config, displayName: next });
            }}
          />
        </label>
        <Switch
          checked={config.autoPrint && chosen !== ''}
          disabled={chosen === ''}
          label={t('printroom.station.autoPrint')}
          onChange={(on) => void save({ ...config, printerName: chosen, autoPrint: on })}
        />
      </div>
      <p className="ob-small">
        {chosen === '' ? t('printroom.station.autoPrintNeedsPrinter') : t('printroom.station.autoPrintHint')}
      </p>
      {stations.length > 0 && (
        <ul className="ob-print-stations" aria-label={t('printroom.station.list')}>
          {stations.map((station) => (
            <li key={station.id}>
              <span className="ob-print-dot" data-online={station.online ? 'true' : 'false'} aria-hidden="true" />
              <span>{station.name}</span>
              {station.isSelf && <span className="ob-small">({t('printroom.station.self')})</span>}
              <span className="ob-small">
                {station.online ? t('printroom.station.online') : t('printroom.station.offline')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- The list ---------------------------------------------------------------------------

export interface PrintroomScreenProps {
  transport: PrintroomTransport;
  /** What this person may do: `send` sees and cancels their own jobs, `station` runs a printroom. */
  permissions: { send: boolean; station: boolean };
  viewerId: string;
  /** The shell's printing calls, present only in the desktop app. */
  desktop?: Pick<DesktopBridge, 'listPrinters' | 'printPage'>;
  /** The sidebar page being shown. */
  page: PrintPage;
  /** The job open as a sub-screen. Held by the shell so a bell entry can open one. */
  openJobId: string | null;
  onOpenJob: (id: string | null) => void;
  /** Bumped by the shell when the sidebar picks Printroom, so an open job closes. */
  resetNonce?: number;
}

function JobRow({
  job,
  showSender,
  canMark,
  canCancel,
  busy,
  onOpen,
  onMark,
  onCancel,
}: {
  job: PrintJobSummary;
  showSender: boolean;
  canMark: boolean;
  canCancel: boolean;
  busy: boolean;
  onOpen: () => void;
  onMark: (printed: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <li className="ob-print-row" data-status={job.status}>
      <button type="button" className="ob-print-rowmain" onClick={onOpen} aria-label={t('printroom.action.open')}>
        <span className="ob-print-when ob-small">{formatDateTime(job.requestedAt)}</span>
        <span className="ob-print-what">
          <span className="ob-body-strong">{job.partyName}</span>
          <span className="ob-small">
            {t(job.source === 'lead' ? 'printroom.source.lead' : 'printroom.source.order')} · {jobNumber(job)} ·{' '}
            {t(job.kind === 'filling' ? 'orderNote.filling' : 'orderNote.dispatch')}
          </span>
        </span>
        <span className="ob-print-copies ob-small">
          {t('printroom.column.copies')}: {job.copies}
        </span>
        {showSender && job.sender && (
          <span className="ob-print-sender ob-small">
            {job.sender.displayName}
            {job.sender.tier === 'server_master' && <ServerMasterBadge />}
          </span>
        )}
        {job.targetStation && <span className="ob-print-target ob-small">{job.targetStation.name}</span>}
        <StatusPill tone={STATUS_TONE[job.status]}>{t(STATUS_LABEL[job.status])}</StatusPill>
        {job.note && <span className="ob-print-note ob-small">{job.note}</span>}
      </button>
      <span className="ob-print-actions">
        {canMark && job.status !== 'cancelled' && (
          <Button size="sm" disabled={busy} onClick={() => onMark(job.status !== 'printed')}>
            {job.status === 'printed' ? t('printroom.action.markNotPrinted') : t('printroom.action.markPrinted')}
          </Button>
        )}
        {canCancel && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            {t('printroom.action.cancel')}
          </Button>
        )}
      </span>
    </li>
  );
}

function PrintroomList({
  transport,
  permissions,
  viewerId,
  desktop,
  onOpenJob,
  page,
}: Pick<PrintroomScreenProps, 'transport' | 'permissions' | 'viewerId' | 'desktop' | 'onOpenJob' | 'page'>) {
  const toast = useToast();
  const transportRef = useRef(transport);
  transportRef.current = transport;
  // Cancelled jobs are a toggle on the Printed page.
  const [showCancelled, setShowCancelled] = useState(false);
  const filter: Filter =
    page === 'waiting' ? 'waiting' : page === 'sentByMe' ? 'mine' : showCancelled ? 'cancelled' : 'printed';
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);
  const [jobs, setJobs] = useState<PrintJobSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<PrintJobSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const query =
      filter === 'mine' ? { status: 'all' as const, mine: true } : { status: filter, mine: false };
    transportRef.current.listJobs(query).then(
      (page) => {
        if (cancelled) return;
        setJobs(page.jobs);
        setCursor(page.nextCursor);
        setWaiting(page.waitingCount);
        setError(null);
        setOffline(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        if (isUnavailable(caught)) setOffline(true);
        else setError(apiErrorText(caught, 'printroom.error.load'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [filter, tick]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = transportRef.current.subscribe(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((count) => count + 1), REFRESH_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // A filter change shows the skeleton, not the last filter's rows.
  useEffect(() => {
    setJobs(null);
    setCursor(null);
  }, [filter]);

  async function loadMore(): Promise<void> {
    if (!cursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const query =
        filter === 'mine'
          ? { status: 'all' as const, mine: true, cursor }
          : { status: filter, mine: false, cursor };
      const page = await transportRef.current.listJobs(query);
      // ponytail: a push refreshes only the first page, so extra pages are dropped then; a long queue is a rare case.
      setJobs((current) => {
        const known = new Set((current ?? []).map((job) => job.id));
        return [...(current ?? []), ...page.jobs.filter((job) => !known.has(job.id))];
      });
      setCursor(page.nextCursor);
    } catch (caught) {
      toast.push(apiErrorText(caught, 'printroom.error.load'), { tone: 'error' });
    } finally {
      setMoreBusy(false);
    }
  }

  async function act(job: PrintJobSummary, run: () => Promise<unknown>): Promise<void> {
    setBusyId(job.id);
    try {
      await run();
      setTick((count) => count + 1);
    } catch (caught) {
      toast.push(t('printroom.error.action', { error: apiErrorText(caught, 'printroom.error.load') }), {
        tone: 'error',
      });
    } finally {
      setBusyId(null);
    }
  }

  const canCancel = (job: PrintJobSummary): boolean =>
    job.status === 'queued' && (permissions.station || (permissions.send && job.sender?.id === viewerId));

  const visible = (jobs ?? []).filter((job) => jobMatches(job, debounced));
  const showStation = permissions.station && !!desktop?.printPage && !!desktop.listPrinters;

  const rows = (list: PrintJobSummary[], showSender: boolean) =>
    list.map((job) => (
      <JobRow
        key={job.id}
        job={job}
        showSender={showSender}
        canMark={permissions.station}
        canCancel={canCancel(job)}
        busy={busyId === job.id}
        onOpen={() => onOpenJob(job.id)}
        onMark={(printed) => void act(job, () => transportRef.current.markJob(job.id, printed))}
        onCancel={() => setCancelling(job)}
      />
    ));

  return (
    <div className="ob-print-page">
      <div className="ob-print-toolbar">
        {page === 'printed' && (
          <FilterChip active={showCancelled} onClick={() => setShowCancelled((on) => !on)}>
            {t('printroom.filter.cancelled')}
          </FilterChip>
        )}
        {page === 'waiting' && waiting > 0 && <span className="ob-print-count">{waiting}</span>}
        <Input
          data-screen-search
          className="ob-print-search"
          type="search"
          value={term}
          placeholder={t('printroom.search')}
          aria-label={t('printroom.search')}
          onChange={(event) => setTerm(event.target.value)}
        />
      </div>

      {showStation && desktop && <StationStrip transport={transport} desktop={desktop} />}

      {offline && <OfflineBanner>{t('printroom.error.offline')}</OfflineBanner>}

      {error ? (
        <ErrorState
          title={t('printroom.error.load')}
          description={error}
          actionLabel={t('printroom.action.retry')}
          onAction={() => setTick((count) => count + 1)}
        />
      ) : jobs === null ? (
        offline ? null : <SkeletonRows rows={5} columns={3} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={filter === 'waiting' ? t('printroom.empty.title') : t('printroom.empty.generic')}
          description={filter === 'waiting' ? t('printroom.empty.description') : undefined}
        />
      ) : filter === 'waiting' && permissions.station ? (
        // The Waiting queue, a sender at a time, so whoever is at the printer takes one person's pile together.
        <div className="ob-print-groups">
          {groupBySender(visible).map((group) => (
            <section key={group.key} className="ob-print-group">
              <header className="ob-print-grouphead">
                {group.sender && (
                  <Avatar
                    name={group.sender.displayName}
                    avatar={group.sender.avatar}
                    size="sm"
                    highlight={group.sender.tier === 'server_master'}
                  />
                )}
                <span className="ob-body-strong">{group.sender?.displayName ?? '—'}</span>
                {group.sender?.tier === 'server_master' && <ServerMasterBadge />}
                <span className="ob-small">{t('printroom.group.count', { count: group.jobs.length })}</span>
              </header>
              <ul className="ob-print-list">{rows(group.jobs, false)}</ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="ob-print-list">{rows(visible, permissions.station)}</ul>
      )}

      {cursor && (
        <div className="ob-pager">
          <Button busy={moreBusy} onClick={() => void loadMore()}>
            {t('printroom.action.more')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title={t('printroom.action.cancel')}
        body={cancelling ? `${cancelling.partyName} · ${jobNumber(cancelling)}` : undefined}
        tone="danger"
        confirmLabel={t('printroom.action.cancel')}
        onCancel={() => setCancelling(null)}
        onConfirm={() => {
          const job = cancelling;
          setCancelling(null);
          if (job) void act(job, () => transportRef.current.cancelJob(job.id));
        }}
      />
    </div>
  );
}

// --- One job ------------------------------------------------------------------------------

function PrintJobView({
  transport,
  permissions,
  viewerId,
  desktop,
  jobId,
  onBack,
  onTitle,
}: Pick<PrintroomScreenProps, 'transport' | 'permissions' | 'viewerId' | 'desktop'> & {
  jobId: string;
  onBack: () => void;
  onTitle: (title: string) => void;
}) {
  const toast = useToast();
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const config = useStationConfig();
  const portalRef = useRef<HTMLDivElement | null>(null);
  /** One print or action at a time: `printOnly` marks the page and is not re-entrant. */
  const busyRef = useRef(false);
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copiesText, setCopiesText] = useState('');
  const [printers, setPrinters] = useState<Array<{ name: string; displayName: string }>>([]);
  const [printer, setPrinter] = useState(config.printerName);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [printedAt] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    transportRef.current.getJob(jobId).then(
      (found) => {
        if (cancelled) return;
        setJob(found);
        setError(null);
        setOffline(false);
        onTitle(found.partyName);
        setCopiesText((current) => (current === '' ? String(found.copies) : current));
      },
      (caught: unknown) => {
        if (cancelled) return;
        if (isUnavailable(caught)) setOffline(true);
        else setError(apiErrorText(caught, 'printroom.error.load'));
      },
    );
    return () => {
      cancelled = true;
    };
    // `onTitle` is a stable setter owned by the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, tick]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = transportRef.current.subscribe((event) => {
      if (event.kind === 'changed' && event.job.id !== jobId) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((count) => count + 1), REFRESH_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [jobId]);

  useEffect(() => {
    let alive = true;
    void desktop?.listPrinters?.().then(
      (list) => {
        if (alive) setPrinters(list);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [desktop]);

  const chosenPrinter = printers.some((entry) => entry.name === printer) ? printer : '';
  const copies = Number(copiesText);
  const copiesValid = Number.isInteger(copies) && copies >= 1 && copies <= 50;

  async function run(work: () => Promise<unknown>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
      setTick((count) => count + 1);
    } catch (caught) {
      toast.push(t('printroom.error.action', { error: apiErrorText(caught, 'printroom.error.load') }), {
        tone: 'error',
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function print(): Promise<void> {
    if (!job || !copiesValid) return;
    const printPage = desktop?.printPage;
    await run(async () => {
      if (!printPage) {
        // A browser prints one copy at a time and cannot say whether the paper came out.
        if (copies > 1) toast.push(t('orderNote.copiesHint', { n: copies }), { tone: 'info' });
        await printOnly(portalRef.current, () => window.print());
        return;
      }
      const result = await printOnly(portalRef.current, () =>
        printPage({ deviceName: chosenPrinter || undefined, copies }),
      );
      if (!result.ok) {
        toast.push(t('orderNote.printFailed', { error: result.error ?? '—' }), { tone: 'error' });
        return;
      }
      if (job.status === 'queued' || job.status === 'printing') {
        await transportRef.current.markJob(job.id, true, chosenPrinter || null);
      }
    });
  }

  if (offline && !job) return <OfflineBanner>{t('printroom.error.offline')}</OfflineBanner>;
  if (error) {
    return (
      <ErrorState
        title={t('printroom.error.load')}
        description={error}
        actionLabel={t('printroom.action.retry')}
        onAction={() => setTick((count) => count + 1)}
      />
    );
  }
  if (!job) return <SkeletonRows rows={4} columns={2} />;

  const canCancel =
    job.status === 'queued' && (permissions.station || (permissions.send && job.sender?.id === viewerId));
  const canPrint = permissions.station && job.hasDocument && job.status !== 'cancelled';

  return (
    <EditorScreen
      meta={
        <span className="ob-small">
          {jobNumber(job)} · {t(job.kind === 'filling' ? 'orderNote.filling' : 'orderNote.dispatch')} ·{' '}
          <StatusPill tone={STATUS_TONE[job.status]}>{t(STATUS_LABEL[job.status])}</StatusPill>
        </span>
      }
      onBack={() => {
        onBack();
        return true;
      }}
      backLabel={t('action.backToList')}
      actions={
        <>
          {permissions.station && job.status !== 'cancelled' && (
            <Button
              disabled={busy}
              onClick={() => void run(() => transportRef.current.markJob(job.id, job.status !== 'printed'))}
            >
              {job.status === 'printed' ? t('printroom.action.markNotPrinted') : t('printroom.action.markPrinted')}
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmCancel(true)}>
              {t('printroom.action.cancel')}
            </Button>
          )}
          {canPrint && (
            <Button variant="primary" busy={busy} disabled={busy || !copiesValid} onClick={() => void print()}>
              {copiesValid
                ? t('printroom.action.printCopies', { n: copies })
                : t('printroom.action.print')}
            </Button>
          )}
        </>
      }
    >
      <div className="ob-print-detail">
        <p className="ob-small">
          {job.sender &&
            t('printroom.job.sentBy', { name: job.sender.displayName, from: job.requestedFrom ?? '—' })}{' '}
          · {formatDateTime(job.requestedAt)}
          {job.sender?.tier === 'server_master' && <ServerMasterBadge />}
        </p>
        {job.note && (
          <p>
            <span className="ob-small">{t('printroom.job.note')}: </span>
            {job.note}
          </p>
        )}
        {job.status === 'printing' && (
          <p className="ob-small">{t('printroom.job.holding', { station: job.claimedStationName ?? '—' })}</p>
        )}
        {job.status === 'printed' && job.printedAt && (
          <p className="ob-small">
            {job.printedBy
              ? t('printroom.job.printedBy', { name: job.printedBy.displayName, printer: job.printerName ?? '—' })
              : t('printroom.job.printedAt', { printer: job.printerName ?? '—' })}{' '}
            · {formatDateTime(job.printedAt)}
          </p>
        )}
        {job.status === 'cancelled' && job.cancelledBy && (
          <p className="ob-small">
            {t('printroom.job.cancelledBy', { name: job.cancelledBy.displayName })} ·{' '}
            {formatDateTime(job.cancelledAt)}
          </p>
        )}

        {canPrint && (
          <div className="ob-note-toolbar">
            <label className="ob-note-toolbar-item">
              <span className="ob-small">{t('printroom.column.copies')}</span>
              <input
                className="ob-input ob-note-copies-input"
                type="number"
                min={1}
                max={50}
                step={1}
                value={copiesText}
                onChange={(event) => setCopiesText(event.target.value)}
              />
            </label>
            {desktop?.listPrinters && (
              <label className="ob-note-toolbar-item">
                <span className="ob-small">{t('orderNote.printer')}</span>
                <select className="ob-input" value={chosenPrinter} onChange={(event) => setPrinter(event.target.value)}>
                  <option value="">{t('orderNote.printerDialog')}</option>
                  {printers.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.displayName || entry.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {job.document ? (
          <>
            <div className="ob-note-canvas">
              <NoteDocumentSheets document={job.document} kind={job.kind} printedAt={printedAt} />
            </div>
            <NoteDocumentPortal document={job.document} kind={job.kind} printedAt={printedAt} portalRef={portalRef} />
          </>
        ) : (
          <EmptyState title={t('printroom.payloadExpired')} />
        )}
      </div>

      <ConfirmDialog
        open={confirmCancel}
        title={t('printroom.action.cancel')}
        body={`${job.partyName} · ${jobNumber(job)}`}
        tone="danger"
        confirmLabel={t('printroom.action.cancel')}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          void run(() => transportRef.current.cancelJob(job.id));
        }}
      />
    </EditorScreen>
  );
}

// --- The screen ---------------------------------------------------------------------------

export function PrintroomScreen(props: PrintroomScreenProps) {
  const { transport, permissions, viewerId, desktop, page, openJobId, onOpenJob, resetNonce } = props;
  const [title, setTitle] = useState('');
  const onTitle = useCallback((next: string) => setTitle(next), []);

  // The open job is the current page in the sidebar, under Printroom.
  useSubNav(
    'printroom',
    openJobId
      ? {
          parentId: 'printroom',
          activeId: 'printroom.job',
          items: [{ id: 'printroom.job', label: title !== '' ? title : t('printroom.title'), icon: 'print' }],
        }
      : null,
  );

  // The sidebar picking Printroom leaves an open job.
  const firstNonce = useRef(resetNonce);
  useEffect(() => {
    if (resetNonce !== firstNonce.current) {
      firstNonce.current = resetNonce;
      onOpenJob(null);
    }
    // `onOpenJob` is the shell's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNonce]);

  // Leaving a job by the sidebar must not leave a stale title for the next one.
  useEffect(() => {
    if (!openJobId) setTitle('');
  }, [openJobId]);

  if (openJobId) {
    return (
      <PrintJobView
        key={openJobId}
        transport={transport}
        permissions={permissions}
        viewerId={viewerId}
        desktop={desktop}
        jobId={openJobId}
        onBack={() => onOpenJob(null)}
        onTitle={onTitle}
      />
    );
  }
  return (
    <PrintroomList
      transport={transport}
      permissions={permissions}
      viewerId={viewerId}
      desktop={desktop}
      onOpenJob={onOpenJob}
      page={page}
    />
  );
}
