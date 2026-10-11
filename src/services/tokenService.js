import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * One token audience with a `scope` claim, rather than two token types.
 * Verification, rotation, revocation and the mustChangePassword gate are then a
 * single code path; isolation comes from requireScope() plus the tid
 * cross-check in requireTenantMember, not from a second secret.
 *
 *   sub   user id
 *   scope 'platform' | 'tenant'
 *   tid   tenantId, or null for platform users
 *   role  the user's role
 *   tv    tokenVersion — bump on the user to force-logout everywhere
 *   imp   set when a platform user is impersonating a tenant
 */
export function signToken(user, { impersonatedBy = null } = {}) {
  return jwt.sign(
    {
      sub: String(user._id),
      scope: user.scope,
      tid: user.tenantId ? String(user.tenantId) : null,
      role: user.role,
      tv: user.tokenVersion ?? 0,
      ...(impersonatedBy ? { imp: String(impersonatedBy) } : {}),
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Two cookie names on purpose. unilanding.com hosts BOTH the platform
 * dashboard and, in path mode, a tenant admin at /<slug>/admin — same origin,
 * so a single cookie name would have them overwrite each other. With two you
 * can be signed into the platform and a tenant simultaneously.
 */
export const PLATFORM_COOKIE = 'ul_session';
export const TENANT_COOKIE = 'ul_t_session';

export const cookieNameFor = (scope) => (scope === 'platform' ? PLATFORM_COOKIE : TENANT_COOKIE);

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    // NO `domain` key, ever. A host-only cookie means a session on
    // tenant-a.com is physically unusable on tenant-b.com — tenant isolation
    // enforced by the browser itself. Setting domain: '.unilanding.com' would
    // let every tenant subdomain read every other tenant's session.
  };
}

export function setSessionCookie(res, user, opts = {}) {
  const token = signToken(user, opts);
  const options = sessionCookieOptions();
  // Assertion rather than a comment: a future edit that adds a Domain
  // attribute is a cross-tenant breach, so fail loudly instead.
  if ('domain' in options) throw new Error('session cookie must stay host-only');
  res.cookie(cookieNameFor(user.scope), token, options);
  return token;
}

export function clearSessionCookies(res) {
  const { maxAge, ...base } = sessionCookieOptions();
  res.clearCookie(PLATFORM_COOKIE, base);
  res.clearCookie(TENANT_COOKIE, base);
}
