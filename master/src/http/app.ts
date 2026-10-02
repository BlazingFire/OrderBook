import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';

import { config } from '../config/index.js';
import { queryCountMiddleware } from '../db/query-counter.js';
import { liveHealth } from './health.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { attachSession } from './middleware/require-auth.js';
import { requirePanel } from './middleware/require-panel.js';
import { accessRoutes } from './routes/access.routes.js';
import { avatarFilesRoutes, avatarRoutes } from './routes/avatar.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { dataRoutes } from './routes/data.routes.js';
import { fieldsRoutes } from './routes/fields.routes.js';
import { imageFilesRoutes, imagesRoutes } from './routes/images.routes.js';
import { integrationRoutes } from './routes/integration.routes.js';
import { logRoutes } from './routes/log.routes.js';
import { panelCatalogRoutes } from './routes/panel-catalog.routes.js';
import { panelImageRoutes } from './routes/panel-image.routes.js';
import { panelRoutes, pairingRoutes } from './routes/panel.routes.js';
import { partyAccessRoutes } from './routes/party-access.routes.js';
import { publicApiRoutes } from './routes/public-api.routes.js';
import { recycleBinRoutes } from './routes/recycle-bin.routes.js';
import { reportRoutes } from './routes/report.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { setupRoutes } from './routes/setup.routes.js';
import { developerRoutes } from './routes/developer.routes.js';
import { masterKeyRoutes } from './routes/master-key.routes.js';
import { publicUpdateRoutes, updateRoutes } from './routes/update.routes.js';

export function createApp(): Express {
  const app = express();

  // Client IPs are used to record where a panel paired from; the Master sits
  // directly on the LAN with no proxy in front of it.
  app.set('trust proxy', false);

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  // Before `attachSession`, so the session resolution is inside the count —
  // it used to be three of the queries a request paid for.
  app.use(queryCountMiddleware);
  app.use(attachSession);

  app.get('/api/health', (req, res) => {
    res.json(liveHealth(req));
  });

  /*
   * The public API, mounted before the cookie-guarded half.
   *
   * `app.use('/api', dataRoutes)` below would otherwise catch `/api/v1/*` and
   * its `requireAuth` would answer 401 to a request that carries a key and no
   * cookie.
   */
  app.use('/api/v1', publicApiRoutes);

  app.use('/api/setup', setupRoutes);
  // Master-PC only, and before the `/api` catch-all: recovery runs before sign-in.
  app.use('/api/master-key', masterKeyRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/pairing', pairingRoutes);
  app.use('/api/panels', panelRoutes);
  app.use('/api/access', accessRoutes);
  // Mounted before the session-guarded half so a paired panel — which carries
  // no user session — can still discover and fetch its own build.
  app.use('/api/updates', publicUpdateRoutes);
  app.use('/api/updates', updateRoutes);
  app.use('/api/party-access', partyAccessRoutes);
  app.use('/api/recycle-bin', recycleBinRoutes);
  app.use('/api/fields', fieldsRoutes);
  app.use('/api/logs', logRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/products/:productId/images', imagesRoutes);
  // An Office Panel's server, not a browser: pairing credentials plus the
  // acting user's token, so image bytes stop riding the command socket — and a
  // spreadsheet is a file too, so the import shares the surface. `requirePanel`
  // runs here, once, in front of both routers. Each used to open with its own
  // `.use(requirePanel)`, and a router's `.use` runs for every request that
  // enters it whether or not one of its routes matches — so an import paid for
  // the bcrypt compare and the acting-person lookup in the image router, fell
  // through, and paid for both again in its own.
  app.use('/api/panel', requirePanel, panelImageRoutes, panelCatalogRoutes);
  app.use('/api/images', imageFilesRoutes);
  // The same router, mounted a second time, for the same reason as avatars
  // below: `ui/src/ProgressiveImage.tsx` loads `/uploads/images/:id/:variant`,
  // the path the Office Panel serves from its own cache. Same session check,
  // same 404 for a product the caller may not see — and before the SPA
  // catch-all, which would otherwise answer it with index.html.
  app.use('/uploads/images', imageFilesRoutes);
  app.use('/api/access/users/:userId/avatar', avatarRoutes);
  app.use('/api/avatars', avatarFilesRoutes);
  // The same router, mounted a second time. `ui/src/Avatar.tsx`'s default
  // `src` is a same-origin relative path so it resolves on either panel — the
  // Office Panel serves it from `office/src/http/app.ts`'s own cache-and-proxy
  // route, and this is the Master resolving the identical path locally,
  // exactly like `/api/avatars` already does.
  app.use('/uploads/avatars', avatarFilesRoutes);
  // Before the catch-all below, which would otherwise swallow `/api/settings`.
  app.use('/api/integrations', integrationRoutes);
  app.use('/api/settings', settingsRoutes);
  // Before the catch-all — the developer routes need `requireAuth` and nothing more.
  app.use('/api/developer', developerRoutes);
  app.use('/api', dataRoutes);

  // There is deliberately **no** `express.static` mount for `config.uploadsDir`.
  // `config.imagesDir` is a subdirectory of it, so serving it statically handed
  // out every product image variant with no session, no `products.view` and no
  // tenant check — routing straight around `imageFilesRoutes` and
  // `image.service.ts#resolveImageFile`, whose whole job is to answer 404 to a
  // caller who may not see the product. Anything under the data directory that
  // a client may read needs a route that checks a permission first.

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
