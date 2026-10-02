import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';
import { isLoopback } from '../../lib/network.js';

/**
 * Refuse a request unless it came from a program on the Master PC itself.
 *
 * For the routes only the owner, at the Master, should reach: first-run setup,
 * restore, the master key and the pairing password. Put it **first**, ahead of
 * any body parser or upload handler, so a LAN caller is turned away before the
 * Master reads anything it sent.
 */
export function requireLoopback(req: Request, _res: Response, next: NextFunction): void {
  if (isLoopback(req)) {
    next();
    return;
  }
  next(new AppError('error.forbidden.masterPcOnly', {}, 403, 'forbidden'));
}
