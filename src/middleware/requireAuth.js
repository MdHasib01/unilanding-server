import { User } from '../models/index.js';
import { unauthorized, forbidden } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifyToken, PLATFORM_COOKIE, TENANT_COOKIE } from '../services/tokenService.js';

/**
 * Resolves the caller from (in order) a bearer token, the tenant session
 * cookie, then the platform session cookie.
 *
 * The user document is re-fetched on EVERY request — the reference codebase's
 * best auth habit — so deactivating a user or bumping tokenVersion takes
 * effect immediately rather than whenever the token happens to expire.
 */
async function resolveUser(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;

  // Tenant cookie before platform: on a tenant host the tenant session is the
  // relevant one, and on the shared platform host an /api/t/* call wants it too.
  const candidates = [bearer, req.cookies?.[TENANT_COOKIE], req.cookies?.[PLATFORM_COOKIE]].filter(
    Boolean
  );

  for (const token of candidates) {
    const payload = verifyToken(token);
    if (!payload?.sub) continue;

    const user = await User.findById(payload.sub);
    if (!user) continue;
    if (!user.active) throw forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');

    // Revocation: an explicit version bump, or a password change that predates
    // this token.
    if ((user.tokenVersion ?? 0) !== (payload.tv ?? 0)) continue;
    // jwt's `iat` is whole seconds, while passwordChangedAt has millisecond
    // precision. Comparing them directly rejects the very token just issued by
    // changePassword (iat=floor(now/1000) vs now), logging the user out of the
    // tab they changed their password in. Compare at second granularity; the
    // tokenVersion bump is what actually revokes the other devices.
    if (
      user.passwordChangedAt &&
      payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)
    ) {
      continue;
    }

    return { user, payload };
  }
  return null;
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const resolved = await resolveUser(req);
  if (!resolved) throw unauthorized();

  req.user = resolved.user;
  req.tokenPayload = resolved.payload;
  req.impersonatedBy = resolved.payload.imp || null;
  next();
});

/** Populates req.user when a session exists, but never rejects. */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  try {
    const resolved = await resolveUser(req);
    if (resolved) {
      req.user = resolved.user;
      req.tokenPayload = resolved.payload;
      req.impersonatedBy = resolved.payload.imp || null;
    }
  } catch {
    // A deactivated account is simply treated as anonymous here.
  }
  next();
});
