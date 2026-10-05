/**
 * What a panel's own server says about the PC it runs on, and when that deserves a
 * warning on the sign-in screen.
 *
 * Hardware only: no names, paths or addresses, so the figures are safe to serve
 * without a sign-in (the screen shows them before anybody has one).
 */

export interface DeviceInfo {
  /** `os.totalmem()`: installed memory, in bytes. */
  totalMemoryBytes: number;
  /** `os.cpus().length`: logical processors. */
  cpuCount: number;
}

/** Below this much total memory the PC is warned about. Machines sold as "8 GB" report a little less. */
export const LOW_MEMORY_BYTES = 7.5 * 1024 ** 3;

/** At or below this many logical processors the PC is warned about. */
export const FEW_CORES_MAX = 2;

export interface DeviceWarnings {
  lowMemory: boolean;
  fewCores: boolean;
}

export function isDeviceInfo(value: unknown): value is DeviceInfo {
  const info = value as Partial<DeviceInfo> | null;
  return (
    typeof info?.totalMemoryBytes === 'number' &&
    Number.isFinite(info.totalMemoryBytes) &&
    typeof info.cpuCount === 'number' &&
    Number.isFinite(info.cpuCount)
  );
}

/** Nothing to warn about when the figures are unknown: a guess would be a false alarm. */
export function deviceWarnings(info: DeviceInfo | null | undefined): DeviceWarnings {
  if (!info || !isDeviceInfo(info)) return { lowMemory: false, fewCores: false };
  return {
    lowMemory: info.totalMemoryBytes > 0 && info.totalMemoryBytes < LOW_MEMORY_BYTES,
    fewCores: info.cpuCount > 0 && info.cpuCount <= FEW_CORES_MAX,
  };
}

/** Gigabytes (1024³ bytes) to one decimal, the way the figure is read out. */
export function formatGigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
