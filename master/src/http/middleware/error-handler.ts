import type { NextFunction, Request, Response } from 'express';

import { AppError, TenantViolationError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('http');

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'Endpoint not found' });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof AppError) {
    // `details` carries whatever the domain layer attached — the missing
    // permission key, the version actually stored, the fields that differ. It
    // used to be dropped here, which made `ForbiddenError.permission` and
    // `assertVersionMatches`'s `storedVersion` unreachable over HTTP and left
    // the client's own branches on them as dead code.
    if (error instanceof TenantViolationError) {
      log.error(`Tenant violation: ${error.message}`);
    }

    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  log.error('Unhandled request error', error);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
}
