/**
 * The Printroom's parts that need no screen: what the shared screens ask a panel
 * for (`PrintroomTransport`), this PC's station settings, and the functions that
 * group, search and pick jobs.
 *
 * The station settings (which printer, whether to auto-print, the name senders
 * see) belong to the PC, not to the company or the signed-in person, so they
 * live in this browser profile's storage and are mirrored to the Master by the
 * station's heartbeat only so senders can see "online".
 */

import type {
  PrintJob,
  PrintJobInput,
  PrintJobPage,
  PrintJobQuery,
  PrintJobSummary,
  PrintPerson,
  PrintStation,
  PrintStationInput,
} from '@orderbook/shared';
import { useEffect, useState } from 'react';

/** What a transport reports: a job that moved, or "read everything again" after a reconnect. */
export type PrintEvent = { kind: 'changed'; job: PrintJobSummary } | { kind: 'resync' };

/**
 * What the screens need from a panel. The Master's browser calls its own REST
 * routes (and its socket, for a claim); an Office calls its server's forwards of
 * them. Every call is online-only: with no link it rejects with
 * `code: 'unavailable'`. Held in a ref by every screen, never a dependency of an
 * effect (`no-transport-dep.test.ts`).
 */
export interface PrintroomTransport {
  listJobs(query: PrintJobQuery): Promise<PrintJobPage>;
  getJob(id: string): Promise<PrintJob>;
  sendJob(input: PrintJobInput): Promise<PrintJob>;
  markJob(id: string, printed: boolean, printerName?: string | null): Promise<PrintJobSummary>;
  cancelJob(id: string): Promise<PrintJobSummary>;
  /** Null when another station holds the job (or it is gone), which is an ordinary outcome. */
  claimJob(id: string): Promise<PrintJob | null>;
  listStations(): Promise<PrintStation[]>;
  saveStation(input: PrintStationInput): Promise<PrintStation>;
  subscribe(listener: (event: PrintEvent) => void): () => void;
}

// --- This PC's station settings -----------------------------------------------

export interface StationConfig {
  printerName: string;
  autoPrint: boolean;
  /** What senders see; empty means "let the Master name it". */
  displayName: string;
}

const KEY_STATION = 'ob.printroom.station';
const STATION_EVENT = 'ob-printroom-station';

const NO_STATION: StationConfig = { printerName: '', autoPrint: false, displayName: '' };

export function readStationConfig(): StationConfig {
  try {
    const raw = window.localStorage.getItem(KEY_STATION);
    if (!raw) return NO_STATION;
    const parsed = JSON.parse(raw) as Partial<StationConfig> | null;
    return {
      printerName: typeof parsed?.printerName === 'string' ? parsed.printerName : '',
      autoPrint: parsed?.autoPrint === true,
      displayName: typeof parsed?.displayName === 'string' ? parsed.displayName : '',
    };
  } catch {
    return NO_STATION;
  }
}

export function writeStationConfig(config: StationConfig): void {
  try {
    window.localStorage.setItem(KEY_STATION, JSON.stringify(config));
  } catch {
    // Storage blocked: the choice lasts until the window closes.
  }
  window.dispatchEvent(new Event(STATION_EVENT));
}

/** This PC's station settings, following any change made anywhere on the page. */
export function useStationConfig(): StationConfig {
  const [config, setConfig] = useState(readStationConfig);
  useEffect(() => {
    const update = (): void => setConfig(readStationConfig());
    window.addEventListener(STATION_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(STATION_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return config;
}

// --- Requests -------------------------------------------------------------------

/**
 * 32 hex characters for a send's `requestId`. `crypto.randomUUID` is absent on
 * the plain-http LAN origins a browser reaches the Master at, so this uses
 * `getRandomValues`, which is there.
 */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // A browser with no crypto at all: unique enough for a retry key, not for a secret.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- Lists ----------------------------------------------------------------------

/** What a job is called on screen: its PO number, or its record id before it had one. */
export function jobNumber(job: Pick<PrintJobSummary, 'sourceNumber' | 'sourceId'>): string {
  return job.sourceNumber ?? job.sourceId;
}

export interface SenderGroup {
  key: string;
  sender: PrintPerson | null;
  jobs: PrintJobSummary[];
}

/** Jobs grouped by who sent them, in the order the senders first appear. */
export function groupBySender(jobs: readonly PrintJobSummary[]): SenderGroup[] {
  const groups = new Map<string, SenderGroup>();
  for (const job of jobs) {
    const key = job.sender?.id ?? '';
    const group = groups.get(key);
    if (group) group.jobs.push(job);
    else groups.set(key, { key, sender: job.sender, jobs: [job] });
  }
  return [...groups.values()];
}

/** The search box: party, order number or sender, case-insensitive. */
export function jobMatches(job: PrintJobSummary, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return true;
  return [job.partyName, jobNumber(job), job.sender?.displayName ?? ''].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/**
 * The jobs a station may take, oldest first: waiting, not already tried and
 * failed in this session, and either for any printroom or for this one.
 */
export function runnableJobs(
  jobs: readonly PrintJobSummary[],
  stationId: string | null,
  failed: ReadonlySet<string>,
): PrintJobSummary[] {
  return jobs.filter(
    (job) =>
      job.status === 'queued' &&
      job.hasDocument &&
      !failed.has(job.id) &&
      (job.targetStation === null || job.targetStation.id === stationId),
  );
}
