import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';

import { config } from '../config/index.js';
import { hasNetworkLink, listLanInterfaces } from '../lib/network.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { attachSession } from './middleware/require-auth.js';
import { authRoutes } from './routes/auth.routes.js';
import { dataRoutes } from './routes/data.routes.js';
import { panelRoutes, pairingRoutes } from './routes/panel.routes.js';
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
  app.use('/api', dataRoutes);

  // Uploaded product images.
  app.use('/uploads', express.static(config.uploadsDir));

  // The built Master Panel UI. Unknown non-API paths fall through to index.html
  // so client-side routes survive a browser refresh.
  const webDist = path.join(config.packageRoot, 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res, next) => {
    res.sendFile(path.join(webDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
