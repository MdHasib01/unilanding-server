import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { UNCHANGED } from '../utils/mask.js';

const KEY = Buffer.from(env.SETTINGS_ENC_KEY, 'base64');
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Tenant integration credentials (courier keys, SMS tokens, Meta CAPI tokens)
 * are encrypted at rest with AES-256-GCM. GCM is authenticated, so a tampered
 * ciphertext fails to decrypt rather than silently yielding garbage.
 *
 * Shape: { __enc: 1, iv, tag, ct } — self-describing, so a plaintext legacy
 * value is distinguishable from an encrypted one and can be migrated lazily.
 */
export function encryptSecret(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return {
    __enc: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export const isEncrypted = (v) => Boolean(v && typeof v === 'object' && v.__enc === 1);

export function decryptSecret(value) {
  if (!isEncrypted(value)) return typeof value === 'string' ? value : '';
  try {
    const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key (rotated SETTINGS_ENC_KEY) or tampered payload. Never throw
    // into a request — the caller treats an empty credential as "not configured".
    return '';
  }
}

/** Deterministic hash for OTP codes and lookup keys. Not reversible. */
export const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** Hashed PII match keys for the Meta Conversions API. */
export const hashForCapi = (v) =>
  v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined;

/** Constant-time compare, for CSRF tokens and internal API keys. */
export function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Signed, single-use, short-lived token for cross-domain session handoff. */
export function signHandoff(payload, ttlSeconds = 60) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', env.JWT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyHandoff(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', env.JWT_SECRET).update(body).digest('base64url');
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Walks a settings object and encrypts the paths declared secret for that
 * section. The UNCHANGED sentinel means "keep what is stored", so the client
 * never has to round-trip a real credential.
 */
export function encryptSecretPaths(values, paths, previous = {}) {
  if (!paths || paths.length === 0) return values;
  const out = structuredClone(values ?? {});

  for (const path of paths) {
    const parts = path.split('.');
    const last = parts.pop();

    let node = out;
    let prevNode = previous;
    let ok = true;
    for (const p of parts) {
      if (!node || typeof node !== 'object') { ok = false; break; }
      node = node[p];
      prevNode = prevNode?.[p];
    }
    if (!ok || !node || typeof node !== 'object') continue;

    const incoming = node[last];
    if (incoming === UNCHANGED) {
      node[last] = prevNode?.[last] ?? '';
    } else if (incoming === '' || incoming === null || incoming === undefined) {
      node[last] = '';
    } else if (!isEncrypted(incoming)) {
      node[last] = encryptSecret(incoming);
    }
  }
  return out;
}

/** Mirror of the above for reads: replaces each secret with a masked preview. */
export function maskSecretPaths(values, paths) {
  if (!paths || paths.length === 0) return values;
  const out = structuredClone(values ?? {});

  for (const path of paths) {
    const parts = path.split('.');
    const last = parts.pop();
    let node = out;
    let ok = true;
    for (const p of parts) {
      if (!node || typeof node !== 'object') { ok = false; break; }
      node = node[p];
    }
    if (!ok || !node || typeof node !== 'object') continue;

    const stored = node[last];
    const plain = isEncrypted(stored) ? decryptSecret(stored) : stored;
    // Expose only whether it is set, and the last 4 characters.
    node[last] = plain ? `${'•'.repeat(8)}${String(plain).slice(-4)}` : '';
    node[`${last}__isSet`] = Boolean(plain);
  }
  return out;
}
