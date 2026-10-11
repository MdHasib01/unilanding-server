import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { timingSafeEqual } from '../services/cryptoService.js';

/**
 * Guards /api/internal/*, used by the Next proxy for host resolution and cache
 * busting. These routes are also excluded from the Next rewrite, so they are
 * not reachable from a browser at all — this is the second lock.
 */
export function internalOnly(req, _res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || !timingSafeEqual(key, env.INTERNAL_API_KEY)) {
    return next(new AppError('Not found', 404, 'ROUTE_NOT_FOUND'));
  }
  next();
}
