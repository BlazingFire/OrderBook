/**
 * Download progress for an app update (1.4 R7a): bytes done, total size, speed
 * and time left, for the Master fetching a build from GitHub and for an Office
 * fetching it from the Master.
 *
 * Pure and clock-injected so both servers and the screens share one rule. The
 * speed is a moving average over the last few seconds, not bytes over the whole
 * run, so a download that stalls shows the stall instead of a flattering mean.
 */

export type UpdateDownloadPhase = 'idle' | 'downloading' | 'verifying' | 'done' | 'failed';

/** What a screen draws. All figures are whole numbers except `percent`, which is to one decimal. */
export interface UpdateDownloadProgress {
  phase: UpdateDownloadPhase;
  /** The version being fetched, or `null` while idle. */
  version: string | null;
  receivedBytes: number;
  totalBytes: number;
  /** 0–100. */
  percent: number;
  bytesPerSecond: number;
  /** Seconds left at the current speed, or `null` when it cannot be told. */
  etaSeconds: number | null;
  /** Why it failed, in words for a person. Only when `phase` is `failed`. */
  error: string | null;
}

export const IDLE_PROGRESS: UpdateDownloadProgress = {
  phase: 'idle',
  version: null,
  receivedBytes: 0,
  totalBytes: 0,
  percent: 0,
  bytesPerSecond: 0,
  etaSeconds: null,
  error: null,
};

/** How far back the speed looks. */
export const SPEED_WINDOW_MS = 5_000;

interface Sample {
  at: number;
  received: number;
}

/**
 * Tracks one download at a time. `add` is called with each chunk, `snapshot`
 * whenever a screen asks. Nothing here is async or touches a timer.
 */
export class UpdateProgressTracker {
  private state: UpdateDownloadPhase = 'idle';
  private version: string | null = null;
  private total = 0;
  private received = 0;
  private error: string | null = null;
  private samples: Sample[] = [];

  /** Begin a download of `totalBytes` for `version`, forgetting any earlier one. */
  start(version: string, totalBytes: number, now: number): void {
    this.state = 'downloading';
    this.version = version;
    this.total = Math.max(0, Math.floor(totalBytes));
    this.received = 0;
    this.error = null;
    this.samples = [{ at: now, received: 0 }];
  }

  /** Record that `bytes` more have arrived. Ignored when no download is running. */
  add(bytes: number, now: number): void {
    if (this.state !== 'downloading') return;
    this.received += bytes;
    this.samples.push({ at: now, received: this.received });
    const cutoff = now - SPEED_WINDOW_MS;
    // Keep one sample at or before the cutoff so the window always has a left edge.
    while (this.samples.length > 2 && (this.samples[1]?.at ?? Infinity) <= cutoff) this.samples.shift();
  }

  /** All bytes are in; the file is being checked. */
  verifying(): void {
    if (this.state === 'downloading') this.state = 'verifying';
  }

  done(): void {
    if (this.state === 'idle') return;
    this.state = 'done';
    this.received = this.total;
  }

  fail(message: string): void {
    if (this.state === 'idle') return;
    this.state = 'failed';
    this.error = message;
  }

  reset(): void {
    this.state = 'idle';
    this.version = null;
    this.total = 0;
    this.received = 0;
    this.error = null;
    this.samples = [];
  }

  snapshot(now: number): UpdateDownloadProgress {
    if (this.state === 'idle') return IDLE_PROGRESS;

    const percent = this.total > 0 ? Math.min(100, Math.round((this.received / this.total) * 1000) / 10) : 0;

    let bytesPerSecond = 0;
    const head = this.samples[0];
    if (this.state === 'downloading' && head) {
      // The newest sample at or before the window's left edge, else the first.
      const cutoff = now - SPEED_WINDOW_MS;
      let first = head;
      for (const sample of this.samples) if (sample.at <= cutoff) first = sample;
      // Measured to `now`, not to the last chunk, so a stalled link decays to zero.
      const seconds = (now - first.at) / 1000;
      if (seconds > 0) bytesPerSecond = Math.max(0, Math.round((this.received - first.received) / seconds));
    }

    const remaining = Math.max(0, this.total - this.received);
    const etaSeconds =
      this.state !== 'downloading'
        ? null
        : remaining === 0
          ? 0
          : bytesPerSecond > 0
            ? Math.ceil(remaining / bytesPerSecond)
            : null;

    return {
      phase: this.state,
      version: this.version,
      receivedBytes: this.received,
      totalBytes: this.total,
      percent,
      bytesPerSecond,
      etaSeconds,
      error: this.error,
    };
  }
}

/** `1.5 MB`, `812 KB`, `3.20 GB`. Binary megabytes under the usual names. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** `2.4 MB/s`. */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** `45 s`, `3 min 10 s`, `1 h 05 min`. `null` reads as an unknown time. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes} min ${String(whole % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
