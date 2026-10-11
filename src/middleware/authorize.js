import { forbidden, unauthorized, AppError } from '../utils/AppError.js';

/**
 * Declarative role gate. Replaces the reference codebase's inline
 * `if (req.admin.role === 'moderator') return res.status(403)` repeated across
 * every controller, where a missed check was invisible in review.
 */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires one of: ${roles.join(', ')}`, 'INSUFFICIENT_ROLE'));
    }
    next();
  };

export const requireScope = (scope) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.scope !== scope) {
    return next(forbidden(`This endpoint requires a ${scope} account`, 'WRONG_SCOPE'));
  }
  next();
};

/**
 * THE tenant-isolation boundary (layer 3 of 4).
 *
 * resolveTenant may have derived the tenant from a header or a Host, both of
 * which a caller controls. The JWT's `tid` is the only authority. Without this
 * check, tenant A's valid cookie plus `X-Tenant-Slug: tenant-b` would read
 * tenant B's orders.
 */
export const requireTenantMember = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!req.tenantId) {
    return next(new AppError('Tenant could not be resolved', 400, 'TENANT_UNRESOLVED'));
  }
  if (req.user.scope !== 'tenant') {
    return next(forbidden('This endpoint requires a tenant account', 'WRONG_SCOPE'));
  }
  if (String(req.user.tenantId) !== String(req.tenantId)) {
    return next(forbidden('Not permitted for this tenant', 'TENANT_MISMATCH'));
  }
  next();
};

/**
 * Blocks everything except the endpoints needed to change the password. The
 * reference set this flag but never enforced it server-side, so the client was
 * the only thing standing in the way.
 */
const PASSWORD_EXEMPT = new Set(['/auth/me', '/auth/change-password', '/auth/logout']);

export const requirePasswordChanged = (req, _res, next) => {
  if (!req.user?.mustChangePassword) return next();
  if (PASSWORD_EXEMPT.has(req.path)) return next();
  return next(
    new AppError('You must change your password before continuing', 428, 'MUST_CHANGE_PASSWORD')
  );
};
