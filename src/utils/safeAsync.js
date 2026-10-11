import { logger } from '../config/logger.js';

/**
 * Runs a fire-and-forget side effect (email, SMS, courier, pixel) so a failure
 * is logged and optionally recorded, but never rejects into the request cycle
 * and never becomes an unhandledRejection.
 *
 * The reference codebase floats these promises bare; one provider outage can
 * take the process down.
 */
export function safeAsync(fn, context = {}) {
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ ok: true, value }))
    .catch((err) => {
      logger.error({ ...context, err: { message: err?.message, stack: err?.stack } }, `side-effect failed: ${context.kind || 'unknown'}`);
      return { ok: false, error: err?.message || String(err) };
    });
}
