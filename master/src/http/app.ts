import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';

import { config } from '../config/index.js';
import { hasNetworkLink, listLanInterfaces } from '../lib/network.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { attachSession } from './middleware/require-auth.js';
import { accessRoutes } from './routes/access.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { dataRoutes } from './routes/data.routes.js';
import { documentRoutes } from './routes/document.routes.js';
import { fieldsRoutes } from './routes/fields.routes.js';
import { imageFilesRoutes, imagesRoutes } from './routes/images.routes.js';
import { logRoutes } from './routes/log.routes.js';
import { panelRoutes, pairingRoutes } from './routes/panel.routes.js';
import { recycleBinRoutes } from './routes/recycle-bin.routes.js';
import { reportRoutes } from './routes/report.routes.js';
import { setupRoutes } from './routes/setup.routes.js';

export function createApp(): Express {
  const app = express();

  // Client IPs are used to record where a panel paired from; the Master sits
  // directly on the LAN with no proxy in front of it.
  app.set('trust proxy', false);

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(attachSession);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      hasNetworkLink: hasNetworkLink(),
      interfaces: listLanInterfaces(),
      port: config.http.port,
    });
  });

  app.use('/api/setup', setupRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/pairing', pairingRoutes);
  app.use('/api/panels', panelRoutes);
  app.use('/api/access', accessRoutes);
  app.use('/api/recycle-bin', recycleBinRoutes);
  app.use('/api/fields', fieldsRoutes);
  app.use('/api/logs', logRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/documents', documentRoutes);
  app.use('/api/products/:productId/images', imagesRoutes);
  app.use('/api/images', imageFilesRoutes);
  app.use('/api', dataRoutes);

  // There is deliberately **no** `express.static` mount for `config.uploadsDir`.
  // `config.imagesDir` is a subdirectory of it, so serving it statically handed
  // out every product image variant with no session, no `products.view` and no
  // tenant check — routing straight around `imageFilesRoutes` and
  // `image.service.ts#resolveImageFile`, whose whole job is to answer 404 to a
  // caller who may not see the product. `config.documents` already keeps export
  // files out of `uploadsDir` for exactly this reason; images had landed inside
  // it. Anything under the data directory that a client may read needs a route
  // that checks a permission first.

  // The built Master Panel UI. Unknown non-API paths fall through to index.html
  // so client-side routes survive a browser refresh.
  const webDist = path.join(config.packageRoot, 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res, next) => {
    // web/dist is a build artefact and is gitignored, so a fresh checkout has
    // none. Without this the request falls through to the JSON 404 handler,
    // which reads as "the app is broken" rather than "the UI is not built".
    if (!existsSync(path.join(webDist, 'index.html'))) {
      res.status(503).type('html').send(missingUiPage());
      return;
    }

    res.sendFile(path.join(webDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Shown when the server is healthy but the frontend has never been built.
 * Deliberately plain HTML with no assets — the whole point is that nothing
 * has been compiled yet.
 */
function missingUiPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>OrderBook — UI not built</title></head>
  <body style="font-family: 'Segoe UI', Tahoma, Arial, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1c2530; line-height: 1.55;">
    <h1 style="font-size: 22px;">The Master Panel is running, but its screens have not been built yet</h1>
    <p>The server and database are fine — this page is proof the server answered.
       What is missing is the compiled browser interface.</p>
    <p>Stop the server and run:</p>
    <pre style="background:#f0f4f8; border:1px solid #d8dee4; border-radius:6px; padding:12px 14px; overflow-x:auto;">npm run build
npm run dev:master</pre>
    <p style="color:#5b6b7c; font-size: 14px;">
      The interface is a build artefact, so it is not stored in version control and
      has to be compiled once after cloning or pulling.
    </p>
  </body>
</html>`;
}
