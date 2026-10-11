/**
 * Normalizes a Host header for comparison and for Domain.host lookups:
 * lowercased, port stripped, trailing dot stripped, IDN left as-is.
 *
 * Stripping the port is load-bearing in development, where every Host arrives
 * as "unilanding.local:3000" but Domain.host is stored without a port.
 */
export function normalizeHost(raw) {
  if (!raw) return '';
  let h = String(raw).trim().toLowerCase();
  if (h.startsWith('[')) {
    // IPv6 literal: [::1]:3000 -> ::1
    const close = h.indexOf(']');
    if (close !== -1) return h.slice(1, close);
  }
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** The request's effective host, honouring the proxy when trust proxy is set. */
export function requestHost(req) {
  return normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);
}

/** True when this host means "the platform itself" rather than a tenant. */
export function isPlatformHost(host, platformHosts) {
  return platformHosts.includes(host);
}

/**
 * The tenant slug encoded in a platform subdomain, or null.
 * demo.unilanding.local -> 'demo'; demo.localhost -> 'demo'.
 */
export function tenantLabelFromHost(host, platformHosts) {
  for (const base of platformHosts) {
    if (!host.endsWith(`.${base}`)) continue;
    const label = host.slice(0, -(base.length + 1));
    if (!label || label.includes('.')) continue;
    return label;
  }
  return null;
}
