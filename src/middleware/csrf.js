import { AppError } from '../utils/AppError.js';
import { opaqueToken } from '../utils/ids.js';
import { timingSafeEqual } from '../services/cryptoService.js';
import { env } from '../config/env.js';

export const CSRF_COOKIE = 'ul_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit cookie. SameSite=Lax already blocks cross-site form POSTs;
 * this is defence in depth and costs one readable cookie.
 *
 * Deliberately NOT httpOnly — the client has to read it to echo it back.
 */
export function issueCsrfCookie(res) {
  const token = opaqueToken();
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    // No Domain attribute: host-only, so a token issued on one tenant's domain
    // is never sent to another's.
  });
  return token;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtect(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Public storefront endpoints carry no session cookie, so there is no session
  // to ride; they are protected by rate limiting instead.
  if (req.path.startsWith('/public/')) return next();
  // Internal endpoints authenticate with a shared key, not a cookie.
  if (req.path.startsWith('/internal/')) return next();
  // Login and the handoff exchange establish the session that CSRF protects.
  if (req.path === '/auth/login' || req.path === '/auth/exchange') return next();
  if (req.path === '/auth/forgot-password' || req.path === '/auth/reset-password') return next();

  // A bearer token cannot be attached by a browser's implicit credential
  // sending, so it is not CSRF-able.
  if (String(req.headers.authorization || '').startsWith('Bearer ')) return next();

  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];

  if (!cookie || !header || !timingSafeEqual(cookie, header)) {
    return next(new AppError('CSRF token missing or invalid', 403, 'CSRF_FAILED'));
  }
  next();
}
