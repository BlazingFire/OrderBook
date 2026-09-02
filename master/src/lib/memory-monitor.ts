/**
 * Periodic memory pressure detection.
 *
 * Checks heap usage against the `--max-old-space-size` ceiling every 30 seconds.
 * At 75% it triggers a GC hint; at 90% it logs a critical warning. The AI
 * service reads `getMemoryStatus()` to refuse new runs when the process is over
 * its RAM cap.
 *
 * Does not kill or restart anything — that is the supervisor's job. This file
 * only observes and suggests.
 */

import os from 'node:os';

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

    // If NODE_OPTIONS did not set a limit, fall back to total system memory
    // as the ceiling — heap can grow to 1.5× that before the OS intervenes.
    const ceiling = maxHeapBytes || os.totalmem() * 0.75;
    const ratio = heapUsed / ceiling;

    if (ratio >= CRITICAL_THRESHOLD) {
      criticalCallback?.();
      global.gc?.();
    } else if (ratio >= WARN_THRESHOLD) {
      warnCallback?.();
      global.gc?.();
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
