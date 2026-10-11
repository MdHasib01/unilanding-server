import { pino } from 'pino';
import { env, isDev } from './env.js';

/**
 * Structured logs. Multi-tenant debugging needs tenantId/userId/requestId on
 * every line — you cannot reconstruct "which tenant saw this" from console.log.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // drop pid/hostname noise
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-internal-key"]',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.apiKey',
      '*.secretKey',
      '*.token',
      '*.smtpPass',
      '*.metaCapiToken',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'hostname,pid' },
        },
      }
    : {}),
});
