import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';

import { env, isProd } from './config/env.js';
import { logger } from './config/logger.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { csrfProtect } from './middleware/csrf.js';
import apiRouter from './routes/index.js';

export function createApp() {
  const app = express();

  // Behind a reverse proxy (and behind the Next.js rewrite), so X-Forwarded-For
  // carries the real customer IP and X-Forwarded-Host the tenant's domain.
  // Numeric strings must be passed as numbers or express reads them as an IP list.
  app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
      customProps: (req) => ({ tenantId: req.tenantId, userId: req.user?._id }),
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    })
  );

  app.use(
    helmet({
      // Next.js serves the HTML and owns the page CSP; setting one here would
      // only apply to JSON responses and would fight the client's own policy.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(
    cors({
      origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : true,
      credentials: true, // session cookie rides same-origin through the rewrite
    })
  );

  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) =>
    res.json({ success: true, data: { status: 'ok', env: env.NODE_ENV, uptime: process.uptime() } })
  );

  // CSRF after cookieParser and before the routes. Exempts /public/* and
  // /internal/*, which carry no session cookie to ride on.
  app.use('/api', csrfProtect, apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
