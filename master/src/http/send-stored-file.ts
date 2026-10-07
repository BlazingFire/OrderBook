/**
 * Send a file from the Master's own store (photos, avatars) after its route has set the
 * long-lived cache headers.
 *
 * A file that is not on disk (a database restored without `uploads/`, a cleaned data folder, a
 * photo with no shipped source to heal it from) is an ordinary 404, not a server fault: the
 * panels draw the empty-photo tile for it. It used to reach the error handler as a bare
 * ENOENT, answer 500 and log an ERROR on every request for it. The immutable cache headers come
 * off first, so a browser never caches the miss.
 */

import type { NextFunction, Response } from 'express';

import { NotFoundError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('http');

export function sendStoredFile(res: Response, file: string, next: NextFunction): void {
  res.sendFile(file, (error) => {
    if (!error) return;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !res.headersSent) {
      res.removeHeader('ETag');
      res.removeHeader('Cache-Control');
      res.removeHeader('Content-Type');
      log.debug(`Stored file missing: ${file}`);
      next(new NotFoundError('File'));
      return;
    }
    next(error);
  });
}
