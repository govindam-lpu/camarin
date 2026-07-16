import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env, isTest } from '../config/env';
import { logger } from '../lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import healthRoutes from './routes/health';
import jobRoutes from './routes/jobs';
import notificationRoutes from './routes/notifications';

const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

export function createApp(): Express {
  const app = express();

  // Deploy target sits behind a reverse proxy; needed for correct client IPs (rate limiting).
  app.set('trust proxy', 1);

  // Swagger UI ships its own assets that clash with a strict CSP; everything else gets helmet.
  const helmetMiddleware = helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // The SPA renders uploaded images from authenticated fetches via blob: URLs (D-013).
        'img-src': ["'self'", 'blob:', 'data:'],
      },
    },
  });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/docs')) return next();
    return helmetMiddleware(req, res, next);
  });

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/api/health' },
      }),
    );
  }

  app.use(express.json({ limit: '100kb' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/jobs', jobRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/health', healthRoutes);

  // API docs: the OpenAPI spec is the source of truth; Swagger UI renders it live.
  app.get('/api/openapi.yaml', (_req, res) => res.sendFile(OPENAPI_PATH));
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(null, { swaggerOptions: { url: '/api/openapi.yaml' } }),
  );

  app.use('/api', notFoundHandler);

  // Serve the built SPA when present (single origin in prod -> no CORS at all).
  const publicDir = env.PUBLIC_DIR
    ? path.resolve(env.PUBLIC_DIR)
    : fileURLToPath(new URL('../../public', import.meta.url));
  if (fs.existsSync(path.join(publicDir, 'index.html'))) {
    app.use(express.static(publicDir, { maxAge: '1h', index: 'index.html' }));
    // SPA fallback: any non-API GET renders the app shell (client-side routing).
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}
