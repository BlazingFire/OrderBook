/**
 * Periodic memory pressure detection.
 *
 * Checks heap usage against the `--max-old-space-size` ceiling every 30 seconds
 * and logs at 75% and 90%. **It does nothing else.** There was a `global.gc?.()`
 * on both branches; `--expose-gc` is passed nowhere, so `global.gc` was always
 * `undefined` and both calls were no-ops in dev and in the packaged app alike.
 * Deleting them was the fix — this comment says so because three separate places
 * used to claim a GC hint that never happened.
 *
 * The one real consumer is `ai.service.ts`, which reads `getMemoryStatus()` to
 * refuse a new AI run when the process is over its RAM cap.
 *
 * Does not kill or restart anything — that is the supervisor's job.
 */

import os from 'node:os';

/** Node's own default old-space ceiling on 64-bit, in bytes. The fallback
 *  when the Electron shell has not set `--max-old-space-size`. */
const DEFAULT_MAX_OLD_SPACE_BYTES = 4096 * 1024 * 1024;

const CHECK_INTERVAL_MS = 30_000;
const CRITICAL_THRESHOLD = 0.9;
const WARN_THRESHOLD = 0.75;

let maxHeapBytes = 0;
let warnCallback: (() => void) | null = null;
let criticalCallback: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function startMemoryMonitor(options: {
  onWarn?: () => void;
  onCritical?: () => void;
}): () => void {
  // Parse max-old-space-size from NODE_OPTIONS if present.
  const match = process.env.NODE_OPTIONS?.match(/--max-old-space-size=(\d+)/);
  maxHeapBytes = parseInt(match?.[1] ?? '0', 10) * 1024 * 1024;

  warnCallback = options.onWarn ?? null;
  criticalCallback = options.onCritical ?? null;

  timer = setInterval(() => {
    const { heapUsed } = process.memoryUsage();

    // If NODE_OPTIONS did not set a limit, fall back to Node's own default
    // old-space ceiling rather than to system memory.
    //
    // The previous fallback was `os.totalmem() * 0.75`, justified as "heap can
    // grow to 1.5× that before the OS intervenes" — which confuses a V8 heap
    // limit with system RAM. NODE_OPTIONS is only ever set by the Electron
    // shell, so every dev run and every CI run took that branch and compared
    // one process's heap against three quarters of the machine: on a 16 GB box,
    // a ~4 GB heap against a 12 GB ceiling. The monitor could not fire in the
    // only environment anyone tests in. 4096 MB is what V8 actually defaults to
    // on 64-bit, so the ratio now means the same thing in both environments.
    const ceiling = maxHeapBytes || DEFAULT_MAX_OLD_SPACE_BYTES;
    const ratio = heapUsed / ceiling;

    if (ratio >= CRITICAL_THRESHOLD) {
      criticalCallback?.();
    } else if (ratio >= WARN_THRESHOLD) {
      warnCallback?.();
    }
  }, CHECK_INTERVAL_MS);

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export function getMemoryStatus() {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  const totalSystemMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeSystemMb = Math.round(os.freemem() / (1024 * 1024));
  const panel = process.env.ORDERBOOK_PANEL ?? 'unknown';
  const capMb = parseInt(process.env.ORDERBOOK_RAM_CAP_MB ?? '0', 10);
  const rssMb = Math.round(rss / (1024 * 1024));

  return {
    rssMb,
    heapUsedMb: Math.round(heapUsed / (1024 * 1024)),
    heapTotalMb: Math.round(heapTotal / (1024 * 1024)),
    totalSystemMb,
    freeSystemMb,
    panel,
    capMb,
    isOverCap: capMb > 0 && rssMb > capMb,
  };
}
