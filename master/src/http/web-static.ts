import express, { type RequestHandler } from 'express';

/**
 * The built UI. Vite names everything under `/assets/` by content hash, so those files never
 * change under one name and are cached for a year; `index.html` and the rest are revalidated
 * with their ETag on each load (a 304, no body), so an update shows on the next open.
 * Mirrored in `office/src/http/web-static.ts`.
 */
export function webStatic(root: string): RequestHandler {
  return express.static(root, {
    setHeaders: (res, filePath) => {
      const hashed = /[\\/]assets[\\/]/.test(filePath);
      res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}
