import slugifyLib from 'slugify';

/**
 * Slugs a tenant/page/product name. The tenant slug becomes a URL path segment
 * AND a subdomain label, so it must satisfy both: lowercase alphanumeric and
 * hyphens, 3-40 chars, no leading/trailing hyphen.
 */
export const TENANT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export const slugify = (input) =>
  slugifyLib(String(input || ''), { lower: true, strict: true, trim: true });

/**
 * Slugs reserved for the platform itself. A tenant claiming one of these would
 * shadow a real route, because app/(platform) static segments and the
 * [tenantSlug] dynamic segment share the same URL space.
 *
 * Keep in sync with client/src/lib/constants.ts RESERVED_SLUGS.
 */
export const RESERVED_SLUGS = new Set([
  'platform', 'admin', 'login', 'logout', 'signup', 'register', 'dashboard',
  'api', 'internal', '_next', 'ul', 'assets', 'static', 'public', 'uploads',
  'pricing', 'docs', 'help', 'support', 'about', 'legal', 'terms', 'privacy',
  'blog', 'status', 'www', 'mail', 'email', 'cdn', 'img', 'images', 'media',
  'app', 'auth', 'account', 'billing', 'settings', 'onboarding', 'demo', 'test',
]);

export function assertUsableSlug(slug) {
  if (!TENANT_SLUG_RE.test(slug)) {
    return 'Slug must be 3-40 characters, lowercase letters, numbers and hyphens, not starting or ending with a hyphen.';
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved by the platform.`;
  return null;
}
