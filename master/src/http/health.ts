/**
 * What the Master says about itself at `GET /api/health`.
 *
 * Two apps answer this route — `boot-app.ts` while the panel is starting, and
 * `app.ts` once it is up — and the desktop shell polls it to decide when to
 * swap its splash for the panel. They therefore have to agree on a shape, and
 * they did not: the live app omitted `boot` entirely, which made the shell's
 * "did startup fail?" branch dead code against a running Master. Both now
 * build their body here and both annotate it `satisfies PanelHealth`.
 *
 * Note the live app hardcodes `status: 'ok'` rather than deriving it from
 * `bootStatus()`. That is deliberate and not a shortcut: `createApp()` is what
 * gets built once the boot sequence has succeeded, so by construction it is
 * only ever reachable when the panel is up — and the integration tests build
 * it directly without running a boot sequence at all.
 */

import type { Request } from 'express';
import type { PanelHealth } from '@orderbook/shared';

import { bootStatus } from '../boot-status.js';
import { config } from '../config/index.js';
import { appVersion } from '../lib/app-version.js';
import { hasNetworkLink, isLoopback, listLanInterfaces } from '../lib/network.js';
import { currentSeq } from '../realtime/change-ring.js';
import { socketCounts } from '../realtime/hub.js';
import { sessionCount } from '../services/auth.service.js';
import { pendingAutoUpdate } from '../services/auto-update.js';
import { preparedInstaller, releaseDirFor } from '../services/update.service.js';

/**
 * Absolute paths are served to loopback callers only.
 *
 * The Master binds `0.0.0.0` and this route is deliberately unauthenticated —
 * the shell has to poll it before anyone has signed in — so its body is
 * readable by anything on the shop LAN. Where the company's database lives on
 * disk is not something to hand out to the network.
 */
function localOnly(
  req: Request,
): Pick<PanelHealth, 'dataDir' | 'logFile' | 'installerDir' | 'installer' | 'autoUpdate' | 'runtime'> {
  if (!isLoopback(req)) return {};

  const memory = process.memoryUsage();

  return {
    dataDir: config.dataDir,
    logFile: process.env.ORDERBOOK_LOG_FILE ?? null,
    installerDir: releaseDirFor('master'),
    // What the shell is allowed to run, and what it must hash to. Loopback
    // only, like the paths above.
    installer: preparedInstaller(),
    // The nightly update asking the shell to install it unattended (1.4 R8).
    autoUpdate: pendingAutoUpdate(),
    // The figures somebody wants *while* a panel feels slow. Loopback only,
    // like the paths above: how much memory the shop's Master is holding is
    // not something the LAN needs told.
    runtime: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      sessions: sessionCount(),
      changeRingSeq: currentSeq(),
      ...socketCounts(),
    },
  };
}

/** The body while the panel is still starting, or has failed to. */
export function bootHealth(req: Request): PanelHealth {
  const boot = bootStatus();
  return {
    panel: 'master',
    status: boot.state === 'ready' ? 'ok' : 'starting',
    boot,
    version: appVersion(),
    port: config.http.port,
    hasNetworkLink: hasNetworkLink(),
    interfaces: listLanInterfaces(),
    ...localOnly(req),
  } satisfies PanelHealth;
}

/** The body once the panel is serving normally. */
export function liveHealth(req: Request): PanelHealth {
  return {
    panel: 'master',
    status: 'ok',
    boot: bootStatus(),
    version: appVersion(),
    port: config.http.port,
    hasNetworkLink: hasNetworkLink(),
    interfaces: listLanInterfaces(),
    ...localOnly(req),
  } satisfies PanelHealth;
}
