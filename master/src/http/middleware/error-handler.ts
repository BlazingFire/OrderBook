import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';
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
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }

  log.error('Unhandled request error', error);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
}
