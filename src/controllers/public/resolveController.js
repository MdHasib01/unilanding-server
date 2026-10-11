import { Tenant, Domain } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok } from '../../utils/respond.js';
import { normalizeHost } from '../../utils/host.js';
import { PLATFORM_HOSTNAME } from '../../config/env.js';
import { RESERVED_SLUGS } from '../../utils/slug.js';
import { bustTenantCache } from '../../middleware/resolveTenant.js';

/**
 * The Next proxy's host lookup. Called at most once per host per minute per
 * process, because the proxy caches the answer (positively AND negatively) and
 * resolves the platform host and platform subdomains without calling at all.
 *
 * Returns 200 with `{ found: false }` rather than a 404, so the proxy can cache
 * "this host is not ours" and stop a bot hammering unmapped hosts from turning
 * into a lookup amplifier.
 */
export const resolveHost = asyncHandler(async (req, res) => {
  const host = normalizeHost(req.query.host);
  if (!host) return ok(res, { found: false, reason: 'no host supplied' });

  // The platform itself is not a tenant.
  if (host === PLATFORM_HOSTNAME || host === `www.${PLATFORM_HOSTNAME}`) {
    return ok(res, { found: false, platform: true });
  }

  let tenant = null;
  let domain = null;

  if (host.endsWith(`.${PLATFORM_HOSTNAME}`)) {
    const label = host.slice(0, -(PLATFORM_HOSTNAME.length + 1));
    if (!label || label.includes('.') || RESERVED_SLUGS.has(label)) {
      return ok(res, { found: false, reason: 'reserved or invalid subdomain' });
    }
    tenant = await Tenant.findOne({ slug: label });
  } else {
    domain = await Domain.findOne({ host });
    if (domain) tenant = await Tenant.findById(domain.tenantId);
  }

  if (!tenant || tenant.deletedAt) return ok(res, { found: false });

  // A custom domain that has not finished verification, or whose certificate is
  // not issued, must not serve the tenant: that is how a dangling DNS record
  // would otherwise let someone else's domain render this tenant's page.
  if (domain && !domain.isServable()) {
    return ok(res, {
      found: false,
      reason: 'domain not active',
      domainStatus: domain.status,
      sslStatus: domain.ssl?.status,
    });
  }

  let primaryHost = `${tenant.slug}.${PLATFORM_HOSTNAME}`;
  if (tenant.primaryDomainId) {
    const primary = await Domain.findById(tenant.primaryDomainId);
    if (primary?.host) primaryHost = primary.host;
  }

  const expired = Boolean(tenant.expiresAt && tenant.expiresAt.getTime() < Date.now());

  return ok(res, {
    found: true,
    slug: tenant.slug,
    tenantId: String(tenant._id),
    primaryHost,
    // The proxy renders a "page unavailable" screen for these instead of the page.
    status: tenant.status === 'active' && !expired ? 'active' : 'suspended',
    // The proxy sets this as x-ul-locale, so a Bangla tenant's visitors get
    // Bangla on the very first byte with no cookie and no flash.
    defaultLocale: tenant.defaultLocale,
    enabledLocales: tenant.enabledLocales,
    redirectTo: domain?.redirectTo || '',
  });
});

/**
 * Lets a domain change take effect in seconds instead of waiting out the
 * proxy's 60s TTL. Idempotent, so a future pub/sub fan-out across instances is
 * a drop-in change.
 */
export const bustCache = asyncHandler(async (req, res) => {
  const { slug, host } = req.body || {};
  bustTenantCache(slug || host || null);
  return ok(res, { busted: slug || host || 'all' });
});
