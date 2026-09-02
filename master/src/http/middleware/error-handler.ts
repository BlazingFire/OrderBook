import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

import { AppError, TenantViolationError, TooManyRequestsError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('http');

export function notFoundHandler(_req: Request, res: Response): void {
  res
    .status(404)
    .json({ error: 'not_found', message: 'Endpoint not found', messageKey: 'error.generic.notFound' });
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

    // The standard header, not just `details.seconds` — a client backing off
    // the documented way (rather than reading this product's own JSON shape)
    // otherwise sees no `Retry-After` at all and either hammers the limit
    // again immediately or gives up instead of waiting the computed window.
    if (error instanceof TooManyRequestsError) {
      res.setHeader('Retry-After', String(error.seconds));
    }

    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
      messageKey: error.messageKey,
      params: error.params,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  // Defense in depth for this process's own direct multer routes (avatars,
  // panel images, setup/data uploads) — an oversized file otherwise fell into
  // the generic 500 below with no indication it was a size problem.
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({
      error: 'validation_error',
      message: 'That file is too large',
      messageKey: 'validation.image.tooLarge',
    });
    return;
  }

  log.error('Unhandled request error', error);
  res
    .status(500)
    .json({ error: 'internal_error', message: 'Something went wrong', messageKey: 'error.generic.internal' });
}
