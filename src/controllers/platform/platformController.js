import { resolveTxt, resolveCname } from 'node:dns/promises';

import { Tenant, Domain, Plan, AuditLog } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok, created, okList } from '../../utils/respond.js';
import { notFoundError, unprocessable, conflict } from '../../utils/AppError.js';
import { pageParams, pagination } from '../../utils/paginate.js';
import { normalizeHost } from '../../utils/host.js';
import { verificationToken } from '../../utils/ids.js';
import { audit } from '../../services/auditService.js';
import { pingRevalidate } from '../../services/pageService.js';
import { bustTenantCache } from '../../middleware/resolveTenant.js';
import { env, PLATFORM_HOSTNAME, PLATFORM_HOSTS } from '../../config/env.js';

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** { tenantId: { _id, slug, name } } for attaching a tenant to list rows. */
async function tenantsById(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return {};
  const tenants = await Tenant.find({ _id: { $in: unique } })
    .setOptions({ withDeleted: true })
    .select('slug name');
  return Object.fromEntries(tenants.map((t) => [String(t._id), t]));
}

// ───────────────────────────── plans ─────────────────────────────

export const listPlans = asyncHandler(async (_req, res) => {
  const [plans, counts] = await Promise.all([
    Plan.find({}).sort({ sortOrder: 1 }),
    Tenant.aggregate([{ $group: { _id: '$plan.code', n: { $sum: 1 } } }]),
  ]);
  const byCode = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  return ok(
    res,
    plans.map((p) => ({ ...p.toObject(), tenantCount: byCode[p.code] ?? 0 }))
  );
});

export const createPlan = asyncHandler(async (req, res) => {
  if (await Plan.exists({ code: req.body.code })) {
    throw conflict('A plan with that code already exists', 'PLAN_CODE_TAKEN');
  }
  const plan = await Plan.create(req.body);

  audit(req, {
    action: 'platform.plan_created',
    targetType: 'Plan',
    targetId: plan._id,
    diff: { code: plan.code, price: plan.price, interval: plan.interval },
  });

  return created(res, { ...plan.toObject(), tenantCount: 0 });
});

/**
 * Edits the catalog only. Tenants hold a snapshot of the terms they signed up
 * on, so a price change here never silently reprices an existing customer.
 */
export const updatePlan = asyncHandler(async (req, res) => {
  const plan = await Plan.findById(req.params.planId);
  if (!plan) throw notFoundError('Plan not found', 'PLAN_NOT_FOUND');

  const { limits, ...rest } = req.body;
  plan.set(rest);
  if (limits) {
    for (const [k, v] of Object.entries(limits)) {
      if (v !== undefined) plan.limits[k] = v;
    }
  }
  await plan.save();

  audit(req, {
    action: 'platform.plan_catalog_updated',
    targetType: 'Plan',
    targetId: plan._id,
    diff: { code: plan.code, after: req.body },
  });

  const tenantCount = await Tenant.countDocuments({ 'plan.code': plan.code });
  return ok(res, { ...plan.toObject(), tenantCount });
});

// ───────────────────────────── domains ─────────────────────────────

// Two-label public suffixes common for our customers. Anything under one of
// these with a single extra label (shop.com.bd) is an apex, not a subdomain.
const MULTI_PART_SUFFIXES = new Set([
  'com.bd', 'net.bd', 'org.bd', 'edu.bd', 'gov.bd', 'ac.bd', 'info.bd',
  'co.uk', 'org.uk', 'co.in', 'com.au', 'co.nz', 'com.my', 'com.sg',
]);

const isApex = (host) => {
  const labels = host.split('.');
  if (labels.length <= 2) return true;
  return labels.length === 3 && MULTI_PART_SUFFIXES.has(labels.slice(1).join('.'));
};

const HOST_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Accepts "https://Shop.Example.com:443/path" and returns "shop.example.com". */
const cleanHost = (raw) =>
  normalizeHost(String(raw).trim().replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]);

/** Drops every cache that could still be serving the old mapping. */
function bustDomainCaches(host, slug) {
  bustTenantCache(host);
  if (slug) bustTenantCache(slug);
  pingRevalidate({ slug, host });
}

export const listDomains = asyncHandler(async (req, res) => {
  const q = req.validatedQuery ?? {};
  const { page, limit, skip } = pageParams(q);

  const filter = {};
  if (q.tenantId) filter.tenantId = q.tenantId;
  if (q.status) filter.status = q.status;
  if (q.type) filter.type = q.type;
  if (q.search) filter.host = new RegExp(`^${escapeRx(q.search.toLowerCase())}`);

  const [items, total] = await Promise.all([
    Domain.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Domain.countDocuments(filter),
  ]);
  const tenants = await tenantsById(items.map((d) => d.tenantId));

  return okList(
    res,
    items.map((d) => ({ ...d.toObject(), tenant: tenants[String(d.tenantId)] ?? null })),
    pagination(total, page, limit)
  );
});

export const addDomain = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId);
  if (!tenant) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

  const host = cleanHost(req.body.host);
  if (!HOST_RE.test(host)) {
    throw unprocessable('That is not a valid domain name', 'INVALID_HOST');
  }
  // The platform's own names (and anything under them) are never a tenant's
  // custom domain; the subdomain is created automatically.
  if (PLATFORM_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))) {
    throw unprocessable('Platform hostnames cannot be added as a custom domain', 'PLATFORM_HOST');
  }
  if (!tenant.flags?.allowCustomDomain) {
    throw unprocessable('Custom domains are turned off for this tenant', 'CUSTOM_DOMAIN_DISABLED');
  }

  const max = tenant.plan?.limits?.customDomains;
  if (max !== null && max !== undefined) {
    const used = await Domain.countDocuments({
      tenantId: tenant._id,
      type: { $ne: 'platform_subdomain' },
    });
    if (used >= max) {
      throw unprocessable(
        `The ${tenant.plan?.name ?? 'current'} plan allows ${max} custom domain${max === 1 ? '' : 's'}`,
        'LIMIT_REACHED'
      );
    }
  }

  if (await Domain.exists({ host })) {
    throw conflict('That domain is already mapped to a tenant', 'DOMAIN_TAKEN');
  }

  const apex = isApex(host);
  const token = verificationToken();
  const domain = await Domain.create({
    host,
    tenantId: tenant._id,
    type: apex ? 'custom_apex' : 'custom_subdomain',
    isPrimary: false,
    status: 'pending',
    verification: apex
      ? { method: 'txt', token, recordName: `_unilanding.${host}`, recordValue: `unilanding-verify=${token}` }
      : { method: 'cname', token, recordName: host, recordValue: PLATFORM_HOSTNAME },
    ssl: { status: 'none' },
    addedBy: req.user._id,
  });

  audit(req, {
    action: 'platform.domain_added',
    targetType: 'Domain',
    targetId: domain._id,
    tenantId: tenant._id,
    diff: { host, type: domain.type },
  });

  return created(res, { ...domain.toObject(), tenant: { _id: tenant._id, slug: tenant.slug, name: tenant.name } });
});

/** Looks the verification record up in public DNS. */
async function checkDns(domain) {
  const { method, recordName, recordValue } = domain.verification;
  try {
    if (method === 'txt') {
      const records = (await resolveTxt(recordName)).map((parts) => parts.join(''));
      return records.includes(recordValue)
        ? { ok: true }
        : { ok: false, error: `TXT ${recordName} does not contain the verification value yet` };
    }
    if (method === 'cname') {
      const targets = (await resolveCname(recordName)).map((t) => t.toLowerCase().replace(/\.$/, ''));
      return targets.includes(recordValue.toLowerCase())
        ? { ok: true }
        : { ok: false, error: `CNAME ${recordName} points to ${targets.join(', ') || 'nothing'}` };
    }
    return { ok: true };
  } catch (err) {
    const why = err?.code === 'ENOTFOUND' || err?.code === 'ENODATA'
      ? `No ${method.toUpperCase()} record found for ${recordName}`
      : `DNS lookup failed (${err?.code || 'error'})`;
    return { ok: false, error: why };
  }
}

export const verifyDomain = asyncHandler(async (req, res) => {
  const domain = await Domain.findById(req.params.domainId);
  if (!domain) throw notFoundError('Domain not found', 'DOMAIN_NOT_FOUND');

  const result = await checkDns(domain);
  domain.verification.attempts = (domain.verification.attempts ?? 0) + 1;
  domain.verification.lastCheckedAt = new Date();

  if (result.ok) {
    domain.status = 'active';
    domain.verification.lastError = '';
    domain.verification.verifiedAt = domain.verification.verifiedAt ?? new Date();
    domain.activatedAt = domain.activatedAt ?? new Date();
  } else {
    domain.status = 'error';
    domain.verification.lastError = result.error;
  }
  await domain.save();

  const tenant = await Tenant.findById(domain.tenantId).select('slug name');
  if (result.ok) bustDomainCaches(domain.host, tenant?.slug);

  audit(req, {
    action: result.ok ? 'platform.domain_verified' : 'platform.domain_verify_failed',
    targetType: 'Domain',
    targetId: domain._id,
    tenantId: domain.tenantId,
    diff: { host: domain.host, error: result.error },
  });

  return ok(res, { ...domain.toObject(), tenant, verified: result.ok });
});

export const updateDomain = asyncHandler(async (req, res) => {
  const domain = await Domain.findById(req.params.domainId);
  if (!domain) throw notFoundError('Domain not found', 'DOMAIN_NOT_FOUND');
  const tenant = await Tenant.findById(domain.tenantId);
  if (!tenant) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

  const { isPrimary, status, ssl, redirectTo } = req.body;
  const before = { isPrimary: domain.isPrimary, status: domain.status, ssl: domain.ssl?.status };

  if (status) {
    if (status === 'disabled' && domain.isPrimary) {
      throw unprocessable('Make another domain primary before disabling this one', 'PRIMARY_DOMAIN');
    }
    domain.status = status;
    if (status === 'active') domain.activatedAt = domain.activatedAt ?? new Date();
  }

  if (ssl) {
    if (ssl.status !== 'issued' && domain.isPrimary && domain.type !== 'platform_subdomain') {
      throw unprocessable('Make another domain primary before clearing its certificate', 'PRIMARY_DOMAIN');
    }
    domain.ssl.status = ssl.status;
    if (ssl.provider !== undefined) domain.ssl.provider = ssl.provider;
    else if (!domain.ssl.provider) domain.ssl.provider = 'manual';
    domain.ssl.issuedAt = ssl.status === 'issued' ? new Date() : null;
    domain.ssl.lastError = '';
  }

  if (redirectTo !== undefined) {
    const target = redirectTo ? cleanHost(redirectTo) : '';
    if (target) {
      if (target === domain.host) throw unprocessable('A domain cannot redirect to itself', 'REDIRECT_LOOP');
      const owned = await Domain.exists({ host: target, tenantId: domain.tenantId });
      if (!owned) throw unprocessable('Redirects must point at another domain of the same tenant', 'REDIRECT_TARGET');
    }
    domain.redirectTo = target;
  }

  if (isPrimary && !domain.isPrimary) {
    // A primary must actually serve, or the tenant's links and admin URLs break.
    const servable = domain.status === 'active' &&
      (domain.type === 'platform_subdomain' || domain.ssl.status === 'issued');
    if (!servable) {
      throw unprocessable(
        'Only an active domain with an issued certificate can be primary',
        'DOMAIN_NOT_SERVABLE'
      );
    }
    if (domain.redirectTo) {
      throw unprocessable('A redirecting domain cannot be primary', 'DOMAIN_REDIRECTS');
    }
    // The partial unique index allows one primary per tenant, so the old one
    // is demoted first.
    const old = await Domain.findOneAndUpdate(
      { tenantId: domain.tenantId, isPrimary: true, _id: { $ne: domain._id } },
      { $set: { isPrimary: false } }
    );
    domain.isPrimary = true;
    try {
      await domain.save();
    } catch (err) {
      if (old) await Domain.updateOne({ _id: old._id }, { $set: { isPrimary: true } });
      throw err;
    }
    tenant.primaryDomainId = domain._id;
    await tenant.save();
    if (old) bustDomainCaches(old.host, tenant.slug);
  } else {
    await domain.save();
  }

  bustDomainCaches(domain.host, tenant.slug);

  audit(req, {
    action: 'platform.domain_updated',
    targetType: 'Domain',
    targetId: domain._id,
    tenantId: domain.tenantId,
    diff: { host: domain.host, before, after: req.body },
  });

  return ok(res, { ...domain.toObject(), tenant: { _id: tenant._id, slug: tenant.slug, name: tenant.name } });
});

export const deleteDomain = asyncHandler(async (req, res) => {
  const domain = await Domain.findById(req.params.domainId);
  if (!domain) throw notFoundError('Domain not found', 'DOMAIN_NOT_FOUND');
  if (domain.type === 'platform_subdomain') {
    throw unprocessable('The platform subdomain cannot be removed', 'PLATFORM_SUBDOMAIN');
  }
  if (domain.isPrimary) {
    throw unprocessable('Make another domain primary before removing this one', 'PRIMARY_DOMAIN');
  }

  // Anything redirecting here would otherwise point at nothing.
  await Domain.updateMany(
    { tenantId: domain.tenantId, redirectTo: domain.host },
    { $set: { redirectTo: '' } }
  );
  await domain.deleteOne();

  const tenant = await Tenant.findById(domain.tenantId).select('slug');
  bustDomainCaches(domain.host, tenant?.slug);

  audit(req, {
    action: 'platform.domain_removed',
    targetType: 'Domain',
    targetId: domain._id,
    tenantId: domain.tenantId,
    diff: { host: domain.host },
  });

  return ok(res, { removed: true, host: domain.host });
});

// ───────────────────────────── audit ─────────────────────────────

export const listAudit = asyncHandler(async (req, res) => {
  const q = req.validatedQuery ?? {};
  const { page, limit, skip } = pageParams(q);

  const filter = {};
  if (q.tenantId) filter.tenantId = q.tenantId;
  if (q.action) filter.action = new RegExp(`^${escapeRx(q.action)}`);
  if (q.actorEmail) filter.actorEmail = new RegExp(`^${escapeRx(q.actorEmail)}`);
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = q.from;
    if (q.to) filter.createdAt.$lte = q.to;
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  const tenants = await tenantsById(items.map((a) => a.tenantId));

  return okList(
    res,
    items.map(({ userAgent: _ua, ...a }) => ({
      ...a,
      tenant: a.tenantId ? tenants[String(a.tenantId)] ?? null : null,
    })),
    pagination(total, page, limit)
  );
});

// ───────────────────────────── settings ─────────────────────────────

/** What is configured, as booleans. Never a value, never a secret. */
export const platformSettings = asyncHandler(async (_req, res) => {
  return ok(res, {
    platformHost: env.PLATFORM_HOST,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    environment: env.NODE_ENV,
    hostAliases: env.PLATFORM_HOST_ALIASES,
    cookieSecure: env.COOKIE_SECURE,
    integrations: {
      email: Boolean(env.SMTP_HOST && env.EMAIL_FROM),
      cloudinary: Boolean(
        env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
      ),
    },
  });
});
