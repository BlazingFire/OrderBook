/**
 * The app the Master serves while it is still starting — and the one it keeps
 * serving if starting failed.
 *
 * Deliberately tiny and dependency-free: it must be able to answer before the
 * database exists, which is the whole point. It serves the built UI (so the
 * panel loads and can render a real message) and answers every API call with
 * the boot status, so the screen can say "still starting" or "this is what
 * went wrong" rather than hanging on a port that never opens.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';

import { bootStatus } from '../boot-status.js';
import { config } from '../config/index.js';
import { bootHealth } from './health.js';

export function createBootApp(): Express {
  const app = express();

  app.get('/api/health', (req, res) => {
    res.json(bootHealth(req));
  });

  /*
   * 503 for everything else under /api, with the boot status attached.
   *
   * 503 rather than 500 because it is the honest code — the server exists and
   * is not ready — and because the panel's own fetch wrapper turns any non-OK
   * response into a thrown error either way, so what matters is that the body
   * carries something worth showing.
   */
  app.use('/api', (_req, res) => {
    const boot = bootStatus();
    res.status(503).json({
      error: boot.state === 'failed' ? 'startup_failed' : 'starting',
      message: boot.message ?? `The Master Panel is still starting — ${boot.step.toLowerCase()}.`,
      boot,
    });
  });

  // The built UI, so the panel itself can load and render the status above.
  const webDist = path.join(config.packageRoot, 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    if (!existsSync(path.join(webDist, 'index.html'))) {
      res.status(503).type('text/plain').send('The Master Panel is starting. Its browser UI has not been built yet — run `npm run build`.');
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });

  return app;
}
