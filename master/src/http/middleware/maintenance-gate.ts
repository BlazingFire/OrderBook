import type { NextFunction, Request, Response } from 'express';

import { isMaintenance, maintenanceError } from '../../services/backup-job.js';

/**
 * What still answers while a restore holds the Master in maintenance: the job's
 * progress, which the restore screen polls, and health.
 */
const OPEN_DURING_MAINTENANCE = new Set(['/api/health', '/api/setup/archive/job']);

/**
 * 503 `error.unavailable.maintenance` for every API and upload route while a
 * restore replaces the database (`services/backup-job.ts`). Mounted first, ahead
 * of the session lookup, which would otherwise read a schema being dropped.
 *
 * The built UI's own files stay served: a person who reloads the page during a
 * restore gets the page back, and the page gets the 503.
 */
export function maintenanceGate(req: Request, res: Response, next: NextFunction): void {
  // Express routes ignore case, so `/API/...` reaches the same handlers.
  const route = req.path.toLowerCase();
  if (!isMaintenance() || OPEN_DURING_MAINTENANCE.has(route) || !/^\/(api|uploads)(\/|$)/.test(route)) {
    next();
    return;
  }
  res.setHeader('Retry-After', '5');
  next(maintenanceError());
}
