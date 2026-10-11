import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { AppError } from '../utils/AppError.js';
import { isProd } from '../config/env.js';

/**
 * Named limiters, replacing the reference codebase's two hand-rolled in-memory
 * Maps.
 *
 * IPv6 note: a raw `req.ip` key lets an IPv6 client rotate through its /64 and
 * sidestep the limit entirely, because a single subscriber is routinely handed
 * an enormous address range. express-rate-limit's ipKeyGenerator normalizes an
 * IPv6 address down to its subnet, so the limit applies per subscriber rather
 * than per address. Every IP-derived key below goes through it.
 *
 * MemoryStore is per-process: with several instances the effective limit is
 * N x this. Acceptable for a single-instance MVP, and the first thing to swap
 * for a Redis store when scaling horizontally (see README).
 */
const make = ({ windowMs, max, keyGenerator, message, code }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    // Limiting in development hides bugs behind 429s; opt in explicitly to test it.
    skip: () => !isProd && process.env.FORCE_RATE_LIMIT !== 'true',
    handler: (_req, _res, next) => next(new AppError(message, 429, code)),
  });

const ip = (req) => ipKeyGenerator(req.ip);

export const loginLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 10,
  // Per IP *and* per account, so one attacker cannot lock out a whole office
  // behind a NAT, while spraying one password across many accounts stays bounded.
  keyGenerator: (req) => `${ip(req)}:${String(req.body?.email || '').toLowerCase()}`,
  message: 'Too many sign-in attempts. Try again in 15 minutes.',
  code: 'LOGIN_RATE_LIMITED',
});

export const publicOrderLimiter = make({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `${ip(req)}:${req.tenantId || 'none'}`,
  message: 'Too many orders from this connection. Please try again shortly.',
  code: 'ORDER_RATE_LIMITED',
});

export const otpLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 3,
  // Keyed on the phone number, which is the scarce resource being abused —
  // each send costs money — falling back to the subnet when absent.
  keyGenerator: (req) => `${req.tenantId || 'none'}:${req.body?.phone || ip(req)}`,
  message: 'Too many verification codes requested. Try again in 15 minutes.',
  code: 'OTP_RATE_LIMITED',
});

export const uploadLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?._id ? `u:${req.user._id}` : ip(req)),
  message: 'Upload limit reached for this hour.',
  code: 'UPLOAD_RATE_LIMITED',
});

export const leadLimiter = make({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `${ip(req)}:${req.tenantId || 'none'}`,
  message: 'Too many requests.',
  code: 'RATE_LIMITED',
});
