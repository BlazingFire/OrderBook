/**
 * The sign-in screen's warning about the PC itself: little memory, or few processor
 * cores. Both panels mount it; the figures come from each panel's own server
 * (`GET /api/device`), and the thresholds are `deviceWarnings()` in `shared/`.
 *
 * It only warns. A slow PC still works, and nothing here blocks signing in.
 */

import { useEffect, useState } from 'react';
import { deviceWarnings, formatGigabytes, isDeviceInfo, type DeviceInfo } from '@orderbook/shared';

import { t } from './i18n.js';

/** Reads the device figures once. A failed read means no warning: unknown is not low. */
export function useDeviceInfo(load: () => Promise<DeviceInfo>): DeviceInfo | null {
  const [device, setDevice] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    let live = true;
    load().then(
      (info) => {
        if (live && isDeviceInfo(info)) setDevice(info);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // The loader is a stable api method; the figures do not change while the screen is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return device;
}

export function DeviceWarning({ device }: { device: DeviceInfo | null }) {
  const warnings = deviceWarnings(device);
  if (!device || (!warnings.lowMemory && !warnings.fewCores)) return null;

  return (
    <div
      role="status"
      data-testid="device-warning"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}
    >
      {warnings.lowMemory && (
        <div className="ob-banner ob-banner--offline">
          <span>
            {t('device.warning.lowMemory', { memory: formatGigabytes(device.totalMemoryBytes) })}
          </span>
        </div>
      )}
      {warnings.fewCores && (
        <div className="ob-banner ob-banner--offline">
          <span>{t('device.warning.fewCores', { cores: device.cpuCount })}</span>
        </div>
      )}
    </div>
  );
}
