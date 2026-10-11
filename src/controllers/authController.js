import crypto from 'node:crypto';

import { User, Tenant, Domain } from '../models/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/respond.js';
import { AppError, unauthorized, badRequest, notFoundError } from '../utils/AppError.js';
import { requestHost } from '../utils/host.js';
import { PLATFORM_HOSTNAME, env } from '../config/env.js';
import {
  setSessionCookie,
  clearSessionCookies,
  cookieNameFor,
  signToken,
} from '../services/tokenService.js';
import { issueCsrfCookie } from '../middleware/csrf.js';
import { verifyHandoff, sha256 } from '../services/cryptoService.js';
import { audit } from '../services/auditService.js';
import { safeAsync } from '../utils/safeAsync.js';
import { sendMail } from '../services/emailService.js';
import { passwordReset as passwordResetEmail } from '../emails/templates.js';
import { logger } from '../config/logger.js';

/**
 * Which audience is signing in? A tenant host or an explicit tenantSlug means
 * the tenant; the bare platform host means the platform. This is what lets one
 * login endpoint serve both without a mode flag in the UI.
 */
async function resolveLoginScope(req) {
  const slug = req.body.tenantSlug || req.headers['x-tenant-slug'];
  if (slug) {
    const tenant = await Tenant.findOne({ slug: String(slug).toLowerCase().trim() });
    if (!tenant) throw notFoundError('Workspace not found', 'TENANT_NOT_FOUND');
    return { scope: 'tenant', tenant };
  }

  const host = requestHost(req);
  if (host && host !== PLATFORM_HOSTNAME && host !== `www.${PLATFORM_HOSTNAME}`) {
    if (host.endsWith(`.${PLATFORM_HOSTNAME}`)) {
      const label = host.slice(0, -(PLATFORM_HOSTNAME.length + 1));
      const tenant = await Tenant.findOne({ slug: label });
      if (tenant) return { scope: 'tenant', tenant };
    }
    const domain = await Domain.findOne({ host });
    if (domain) {
      const tenant = await Tenant.findById(domain.tenantId);
      if (tenant) return { scope: 'tenant', tenant };
    }
  }

  return { scope: 'platform', tenant: null };
}

/** A tenant's primary host, for links in emails and for redirects. */
async function primaryHostFor(tenant) {
  if (tenant.primaryDomainId) {
    const d = await Domain.findById(tenant.primaryDomainId);
    if (d?.host) return d.host;
  }
  return `${tenant.slug}.${env.PLATFORM_HOST}`;
}

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const { scope, tenant } = await resolveLoginScope(req);

  const user = await User.findForLogin({
    email,
    tenantId: scope === 'tenant' ? tenant._id : null,
  });

  // One generic message for "no such user" and "wrong password", so the
  // endpoint cannot be used to enumerate which emails exist.
  const invalid = unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  if (!user) throw invalid;
  if (!(await user.comparePassword(password))) throw invalid;
  if (!user.active) throw unauthorized('This account has been deactivated', 'ACCOUNT_DISABLED');

  if (scope === 'tenant' && tenant.status === 'archived') {
    throw unauthorized('This workspace is no longer available', 'TENANT_NOT_FOUND');
  }

  user.lastLoginAt = new Date();
  user.lastLoginIp = req.ip || '';
  await user.save();

  setSessionCookie(res, user);
  issueCsrfCookie(res);

  audit(req, {
    action: 'auth.login',
    targetType: 'User',
    targetId: user._id,
    tenantId: user.tenantId,
  });

  return ok(res, {
    user: user.toSafeJSON(),
    tenant: tenant ? tenant.toPublicJSON() : null,
    // The client seeds its locale cookie from this.
    locale: user.locale,
  });
});

export const logout = asyncHandler(async (req, res) => {
  clearSessionCookies(res);
  if (req.user) {
    audit(req, { action: 'auth.logout', targetType: 'User', targetId: req.user._id });
  }
  return ok(res, { loggedOut: true });
});

export const me = asyncHandler(async (req, res) => {
  const user = req.user;
  let tenant = null;
  if (user.tenantId) {
    const t = await Tenant.findById(user.tenantId);
    tenant = t ? t.toPublicJSON() : null;
  }

  // Slide the session forward when it is close to expiring, so an active user
  // is never logged out mid-task. No refresh token needed for this.
  const exp = req.tokenPayload?.exp ? req.tokenPayload.exp * 1000 : 0;
  const twoDays = 2 * 24 * 60 * 60 * 1000;
  if (exp && exp - Date.now() < twoDays) {
    setSessionCookie(res, user, { impersonatedBy: req.impersonatedBy });
    issueCsrfCookie(res);
  }

  return ok(res, {
    user: user.toSafeJSON(),
    tenant,
    impersonated: Boolean(req.impersonatedBy),
    permissions: {
      role: user.role,
      scope: user.scope,
      mustChangePassword: user.mustChangePassword,
    },
  });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!user) throw unauthorized();
  if (!(await user.comparePassword(currentPassword))) {
    throw badRequest('Your current password is incorrect', 'WRONG_PASSWORD');
  }
  if (await user.comparePassword(newPassword)) {
    throw badRequest('The new password must be different', 'PASSWORD_UNCHANGED');
  }

  user.passwordHash = await User.hashPassword(newPassword);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  // Invalidate every other session for this user.
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  // Re-issue for the current device so the user is not logged out of the tab
  // they just changed it in.
  setSessionCookie(res, user);
  issueCsrfCookie(res);

  audit(req, { action: 'auth.password_changed', targetType: 'User', targetId: user._id });

  return ok(res, { user: user.toSafeJSON() });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const { scope, tenant } = await resolveLoginScope(req).catch(() => ({
    scope: 'platform',
    tenant: null,
  }));

  const user = await User.findOne({
    email,
    tenantId: scope === 'tenant' && tenant ? tenant._id : null,
  });

  // Always the same response, whether or not the account exists.
  const generic = { sent: true };

  if (user?.active) {
    const token = crypto.randomBytes(32).toString('base64url');
    user.passwordResetHash = sha256(token);
    user.passwordResetExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const base = tenant ? `https://${await primaryHostFor(tenant)}` : env.PUBLIC_BASE_URL;
    const resetUrl = `${base}/reset-password?token=${token}`;

    safeAsync(
      () =>
        sendMail(
          { to: user.email, ...passwordResetEmail({ user, resetUrl, locale: user.locale }) },
          {}
        ),
      { kind: 'email.password_reset', userId: String(user._id) }
    );
  } else {
    logger.info({ email }, 'password reset requested for unknown or inactive account');
  }

  return ok(res, generic);
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;

  const user = await User.findOne({
    passwordResetHash: sha256(token),
    passwordResetExpiresAt: { $gt: new Date() },
  }).select('+passwordHash +passwordResetHash +passwordResetExpiresAt');

  if (!user) {
    throw badRequest('This reset link has expired. Request a new one.', 'RESET_TOKEN_INVALID');
  }
  if (!user.active) throw badRequest('Account unavailable', 'ACCOUNT_DISABLED');

  user.passwordHash = await User.hashPassword(newPassword);
  // Single use.
  user.passwordResetHash = '';
  user.passwordResetExpiresAt = null;
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  audit(req, { action: 'auth.password_reset', targetType: 'User', targetId: user._id });
  return ok(res, { reset: true });
});

/**
 * Exchanges a one-time handoff token for a session cookie ON THIS HOST.
 *
 * This is how a cross-domain login works without a shared cookie: the platform
 * mints a 60-second signed token, the browser lands on the tenant's own domain,
 * and the cookie is set there, host-only.
 */
export const exchange = asyncHandler(async (req, res) => {
  const payload = verifyHandoff(req.body.token);
  if (!payload?.sub) {
    throw badRequest('This link has expired. Please try again.', 'HANDOFF_INVALID');
  }

  const user = await User.findById(payload.sub);
  if (!user || !user.active) throw unauthorized('Account unavailable', 'ACCOUNT_DISABLED');

  // A handoff is bound to one tenant; it must not work anywhere else.
  if (payload.tid && String(user.tenantId) !== String(payload.tid)) {
    throw unauthorized('This link is not valid here', 'HANDOFF_SCOPE');
  }

  setSessionCookie(res, user, { impersonatedBy: payload.imp || null });
  issueCsrfCookie(res);

  audit(req, {
    action: payload.imp ? 'auth.impersonate_start' : 'auth.handoff',
    targetType: 'User',
    targetId: user._id,
    tenantId: user.tenantId,
  });

  return ok(res, { user: user.toSafeJSON(), impersonated: Boolean(payload.imp) });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) throw unauthorized();

  for (const field of ['name', 'phone', 'locale']) {
    if (req.body[field] !== undefined) user[field] = req.body[field];
  }
  await user.save();

  return ok(res, { user: user.toSafeJSON() });
});

export { cookieNameFor, signToken, primaryHostFor };
