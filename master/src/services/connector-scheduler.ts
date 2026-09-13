/**
 * One sixty-second tick that runs whatever is due.
 *
 * A single `setInterval` rather than a job per connector: the whole scale here
 * is a shop with a handful of integrations, and one timer that reads the table
 * is both simpler and self-correcting after a clock change or a restart.
 *
 * The same tick flushes `last_used_at` for API keys, which is why that column
 * is not written per request — a key polled twice a second would otherwise turn
 * every read into a write.
 *
 * ponytail: single-process scheduler with no cross-restart resume. If a second
 * Master ever exists, this wants a job table with a lease; today a second
 * Master would be a much larger problem than double-running an import.
 */

import { db } from '../db/knex.js';
import { createLogger } from '../lib/logger.js';
import { drainTouches } from '../http/middleware/api-key-rate-limit.js';
import * as apiKeyRepo from '../repositories/api-key.repository.js';
import * as connectorRepo from '../repositories/connector.repository.js';
import { systemActor } from '../domain/actor.js';
import { getSetting } from './settings.service.js';
import { runConnector } from './connector-run.service.js';
import { permissionSetForRole } from './pricing-gate.js';
import * as userRepo from '../repositories/user.repository.js';

const log = createLogger('connector-scheduler');

const TICK_MS = 60_000;
/** A run still claiming to be running after this was killed with the process. */
const STALE_RUN_MINUTES = 30;

/** Connectors mid-run, so a slow import is not started a second time. */
const running = new Set<string>();

let timer: NodeJS.Timeout | null = null;

export function startConnectorScheduler(): () => void {
  // Anything left `running` belonged to a process that is gone. Without this the
  // overlap guard would be permanently satisfied and that connector would never
  // run again.
  void connectorRepo.failStaleRuns(STALE_RUN_MINUTES).catch((error: unknown) => {
    log.warn(`Could not clear stale runs: ${message(error)}`);
  });

  timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      log.warn(`Scheduler tick failed: ${message(error)}`);
    });
  }, TICK_MS);
  timer.unref?.();

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    running.clear();
  };
}

/** Exported so a test can run one tick without waiting a minute. */
export async function tick(now: Date = new Date()): Promise<void> {
  await flushKeyUsage();

  const scheduled = await connectorRepo.listScheduled();

  for (const entry of scheduled) {
    if (running.has(entry.id)) continue;
    if (!entry.intervalMin) continue;

    const due =
      !entry.lastRunAt || now.getTime() - entry.lastRunAt.getTime() >= entry.intervalMin * 60_000;
    if (!due) continue;

    // The switch is checked per tick rather than at start-up, so turning the
    // feature off stops the schedule on the next minute instead of at the next
    // restart.
    if (!(await getSetting(entry.tenantId, 'externalApi.enabled'))) continue;

    running.add(entry.id);
    try {
      await runConnector(
        await schedulerActor(entry.tenantId, entry.id),
        entry.id,
        'import',
        'schedule',
      );
    } catch (error) {
      log.warn(`Scheduled run of ${entry.id} failed: ${message(error)}`);
    } finally {
      running.delete(entry.id);
    }
  }
}

/**
 * Who a scheduled run is attributed to.
 *
 * A scheduled run has no person behind it, so the *caller* is the system — but
 * it must still hold `api.manage` to get past `runConnector`'s own gate, and the
 * writes it performs are done by the connector's `run_as` user, resolved inside
 * that function. `systemActor` alone would be refused: its `permissions` is
 * `null` and `requirePermission` says no to everything.
 */
async function schedulerActor(tenantId: string, connectorId: string) {
  const base = systemActor(tenantId);
  const connector = await connectorRepo.findConnector(tenantId, connectorId);
  const user = connector?.runAsUserId
    ? await userRepo.findById(tenantId, connector.runAsUserId)
    : null;
  const permissions = user ? await permissionSetForRole(tenantId, user.roleId) : null;

  return {
    ...base,
    actorType: 'connector' as const,
    actorId: connectorId,
    userId: user?.id ?? null,
    permissions,
    actorName: connector ? `Schedule for ${connector.label}` : 'Schedule',
  };
}

async function flushKeyUsage(): Promise<void> {
  const seen = drainTouches();
  if (seen.size === 0) return;

  try {
    await apiKeyRepo.touchKeys(seen, db());
  } catch (error) {
    // Losing a `last_used_at` flush costs a timestamp, not correctness.
    log.warn(`Could not flush API key usage: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
