import { AuditLog } from '../models/index.js';
import { SECRET_PATHS } from '../utils/constants.js';
import { safeAsync } from '../utils/safeAsync.js';
import { isEncrypted } from './cryptoService.js';

const SECRET_KEY_RE = /(password|passwordhash|secret|token|apikey|api_key|smtppass)/i;

/** Strips anything credential-shaped out of a diff before it is persisted. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (isEncrypted(value)) return '[encrypted]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Audit writes are fire-and-forget: losing a log line must never fail the
 * action it was describing.
 */
export function audit(req, { action, targetType = '', targetId = '', tenantId, diff }) {
  return safeAsync(
    () =>
      AuditLog.create({
        tenantId: tenantId ?? req?.tenantId ?? null,
        actorId: req?.user?._id ?? null,
        actorEmail: req?.user?.email ?? '',
        actorScope: req?.user?.scope ?? '',
        actorIp: req?.ip ?? '',
        action,
        targetType,
        targetId: targetId ? String(targetId) : '',
        diff: diff ? redact(diff) : null,
        userAgent: req?.headers?.['user-agent'] ?? '',
      }),
    { kind: 'audit', action }
  );
}

export { SECRET_PATHS };
