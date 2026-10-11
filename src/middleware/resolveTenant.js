import { Tenant, Domain, scopedModels } from '../models/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError, notFoundError, forbidden } from '../utils/AppError.js';
import { requestHost, isPlatformHost, tenantLabelFromHost } from '../utils/host.js';
import { PLATFORM_HOSTS } from '../config/env.js';
import { RESERVED_SLUGS } from '../utils/slug.js';

/**
 * Small in-process cache so a burst of requests for one tenant is one query.
 * Short TTL because a suspension or plan change must take effect quickly.
 *
 * Per-process: with several instances each keeps its own copy, bounded by the
 * TTL. Documented in the README as the first thing to move to Redis.
 */
const TTL_MS = 30_000;
const tenantCache = new Map();

const cacheGet = (key) => {
  const hit = tenantCache.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    tenantCache.delete(key);
    return undefined;
  }
  return hit.value;
};

const cacheSet = (key, value) => {
  // Crude bound; this cache holds at most a few hundred entries in practice.
  if (tenantCache.size > 1000) tenantCache.clear();
  tenantCache.set(key, { value, exp: Date.now() + TTL_MS });
};

export const bustTenantCache = (slugOrHost) => {
  if (slugOrHost) {
    tenantCache.delete(`slug:${slugOrHost}`);
    tenantCache.delete(`host:${slugOrHost}`);
  } else {
    tenantCache.clear();
  }
};

async function tenantBySlug(slug) {
  const key = `slug:${slug}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const tenant = await Tenant.findOne({ slug });
  cacheSet(key, tenant || null);
  return tenant || null;
}

async function tenantByHost(host) {
  const key = `host:${host}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // A platform subdomain encodes its own slug, so skip the Domain lookup.
  const label = tenantLabelFromHost(host, PLATFORM_HOSTS);
  if (label) {
    if (!RESERVED_SLUGS.has(label)) {
      const tenant = await tenantBySlug(label);
      cacheSet(key, tenant || null);
      return tenant || null;
    }
    cacheSet(key, null);
    return null;
  }

  const domain = await Domain.findOne({ host });
  if (!domain) {
    cacheSet(key, null);
    return null;
  }
  const tenant = await Tenant.findById(domain.tenantId);
  cacheSet(key, tenant || null);
  return tenant || null;
}

/**
 * Resolution order, strictest authority first:
 *
 *   1. req.user.tenantId      — the JWT. Authoritative; a caller cannot forge it.
 *   2. X-Tenant-Slug / -Id    — a hint our own client sends for path-mode admin calls.
 *   3. Host / X-Forwarded-Host — the tenant's own domain or platform subdomain.
 *   4. :tenantSlug param       — public storefront routes.
 *
 * Steps 2-4 are only hints. requireTenantMember then cross-checks the JWT
 * against whatever was resolved, which is what makes header spoofing useless.
 */
function makeResolver({ required = true, allowSuspended = false } = {}) {
  return asyncHandler(async (req, _res, next) => {
    let tenant = null;

    if (req.user?.tenantId) {
      tenant = await Tenant.findById(req.user.tenantId);
    }

    if (!tenant) {
      const hintedId = req.headers['x-tenant-id'];
      const hintedSlug = req.headers['x-tenant-slug'];
      if (hintedId) tenant = await Tenant.findById(hintedId).catch(() => null);
      else if (hintedSlug) tenant = await tenantBySlug(String(hintedSlug).toLowerCase().trim());
    }

    if (!tenant) {
      const host = requestHost(req);
      // A platform host (including localhost in development) is never a tenant.
      if (host && !isPlatformHost(host, PLATFORM_HOSTS)) {
        tenant = await tenantByHost(host);
      }
    }

    if (!tenant && req.params?.tenantSlug) {
      tenant = await tenantBySlug(String(req.params.tenantSlug).toLowerCase().trim());
    }

    if (!tenant) {
      if (!required) return next();
      throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');
    }

    if (tenant.deletedAt) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

    // A platform user may inspect a suspended tenant; nobody else may.
    const isPlatform = req.user?.scope === 'platform';
    if (!allowSuspended && !isPlatform) {
      if (tenant.status === 'suspended') {
        throw forbidden('This account is suspended', 'TENANT_SUSPENDED');
      }
      if (tenant.status === 'archived') {
        throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');
      }
      if (tenant.expiresAt && tenant.expiresAt.getTime() < Date.now()) {
        throw forbidden('This subscription has expired', 'TENANT_EXPIRED');
      }
    }

    req.tenant = tenant;
    req.tenantId = tenant._id;
    // Layer 2 of tenant isolation: controllers only ever touch req.db.
    req.db = scopedModels(tenant._id);
    next();
  });
}

export const resolveTenant = makeResolver();
export const resolveTenantOptional = makeResolver({ required: false });
/** For platform routes that act on a tenant whatever its status. */
export const resolveTenantAnyStatus = makeResolver({ allowSuspended: true });

/** Explicit guard for places that must refuse a non-live tenant. */
export const requireLiveTenant = (req, _res, next) => {
  if (!req.tenant) return next(new AppError('Tenant unresolved', 400, 'TENANT_UNRESOLVED'));
  if (!req.tenant.isLive()) {
    return next(forbidden('This page is unavailable', 'TENANT_NOT_LIVE'));
  }
  next();
};
