/**
 * The Master's unattended nightly update (1.4 R8): the settings, how the last
 * night went, and the one-line request the server leaves for its desktop shell.
 *
 * Per PC in `<dataDir>/auto-update.json`, like the automatic backup, because
 * whether a PC may restart itself at night is a fact about that PC.
 */

import type { UpdateDownloadProgress } from '../domain/update-progress.js';
import type { UpdateAvailability } from '../domain/version.js';

export interface AutoUpdateConfig {
  /** On by default: the owner wants the Master to update itself overnight. */
  enabled: boolean;
  /** Local time of day, `HH:MM`, 24-hour, in the business time zone. */
  time: string;
}

export const DEFAULT_AUTO_UPDATE_CONFIG: AutoUpdateConfig = {
  enabled: true,
  time: '23:00',
};

/** How the last scheduled attempt went. */
export interface AutoUpdateRun {
  at: string;
  /** `installing`: handed to the shell. `skipped`: nothing newer. `failed`: could not be prepared. */
  outcome: 'installing' | 'skipped' | 'failed';
  version?: string;
  /** Where the pre-update copy of the data went, when one was taken. */
  backupPath?: string;
  message?: { messageKey: string; params?: Record<string, string | number> };
}

export interface AutoUpdateStatus extends AutoUpdateConfig {
  lastRun: AutoUpdateRun | null;
}

/**
 * What the server asks its own shell to do, over the loopback health route. The
 * shell still asks for the verified installer itself and hashes it before it
 * runs anything: this says only *that* an unattended install is due.
 */
export interface AutoUpdateRequest {
  version: string;
  requestedAt: string;
}

/** The Master's `GET /api/updates/status` and `POST /api/updates/check` answer (1.4 R6, R7). */
export interface UpdateStatusResponse {
  running: string;
  master: UpdateAvailability;
  office: UpdateAvailability;
  download: {
    master: UpdateDownloadProgress;
    office: UpdateDownloadProgress;
  };
  /** When GitHub was last asked, by the timer or by hand; `null` before the first time. */
  lastCheckedAt: string | null;
  auto: AutoUpdateStatus;
}
