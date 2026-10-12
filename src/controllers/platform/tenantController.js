import {
  Tenant,
  Domain,
  User,
  Plan,
  Order,
  scopedModels,
} from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok, created, okList } from '../../utils/respond.js';
import { notFoundError, unprocessable } from '../../utils/AppError.js';
import { pageParams, pagination } from '../../utils/paginate.js';
import { audit } from '../../services/auditService.js';
import { safeAsync } from '../../utils/safeAsync.js';
import { sendMail } from '../../services/emailService.js';
import { tenantWelcome, staffInvite } from '../../emails/templates.js';
import {
  createTenant,
  adminUrlsFor,
  suspendTenant,
  activateTenant,
  archiveTenant,
} from '../../services/tenantService.js';
import { recomputeUsage } from '../../middleware/enforceLimit.js';
import { signHandoff } from '../../services/cryptoService.js';
import { generatePassword } from '../../utils/ids.js';
import { env } from '../../config/env.js';
import { bustTenantCache } from '../../middleware/resolveTenant.js';

const primaryHostOf = async (tenant) => {
  if (tenant.primaryDomainId) {
    const d = await Domain.findById(tenant.primaryDomainId);
    if (d?.host) return d.host;
  }
  return `${tenant.slug}.${env.PLATFORM_HOST.split(':')[0]}`;
};

// ───────────────────────────── overview ─────────────────────────────

export const overview = asyncHandler(async (_req, res) => {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400_000);

  const [byStatus, byPlan, totalTenants, ordersToday, orders7d, recent] = await Promise.all([
    Tenant.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Tenant.aggregate([{ $group: { _id: '$plan.code', n: { $sum: 1 } } }]),
    Tenant.countDocuments({}),
    // Deliberate platform-wide reads: the guard requires saying so out loud.
    Order.countDocuments({ createdAt: { $gte: startOfDay } }).setOptions({
      allowCrossTenant: true,
    }),
    Order.countDocuments({ createdAt: { $gte: weekAgo } }).setOptions({
      allowCrossTenant: true,
    }),
    Tenant.find({}).sort({ createdAt: -1 }).limit(5).select('slug name status plan.code createdAt'),
  ]);

  // Monthly recurring revenue from the plan snapshots actually in force.
  const mrrAgg = await Tenant.aggregate([
    { $match: { status: 'active' } },
    {
      $group: {
        _id: null,
        mrr: {
          $sum: {
            $cond: [
              { $eq: ['$plan.interval', 'yearly'] },
              { $divide: ['$plan.price', 12] },
              '$plan.price',
            ],
          },
        },
      },
    },
  ]);

  return ok(res, {
    tenants: {
      total: totalTenants,
      byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
      byPlan: Object.fromEntries(byPlan.map((r) => [r._id ?? 'none', r.n])),
    },
    orders: { today: ordersToday, last7Days: orders7d },
    mrr: Math.round(mrrAgg[0]?.mrr ?? 0),
    recentTenants: recent,
  });
});

// ───────────────────────────── tenants ─────────────────────────────

export const listTenants = asyncHandler(async (req, res) => {
  const q = req.validatedQuery ?? {};
  const { page, limit, skip } = pageParams(q);

  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.plan) filter['plan.code'] = q.plan;
  if (q.search) {
    // Anchored so the index on slug is usable; an unanchored .* would scan.
    const rx = new RegExp(`^${q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    filter.$or = [{ slug: rx }, { name: rx }, { 'contact.email': rx }];
  }

  const sort = q.sort || '-createdAt';
  const [items, total] = await Promise.all([
    Tenant.find(filter).sort(sort).skip(skip).limit(limit),
    Tenant.countDocuments(filter),
  ]);

  return okList(res, items, pagination(total, page, limit));
});

export const getTenant = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId).setOptions({ withDeleted: true });
  if (!tenant) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

  const db = scopedModels(tenant._id);
  const [domains, users, pages, products, orderCount, usage] = await Promise.all([
    Domain.find({ tenantId: tenant._id }).sort({ isPrimary: -1, createdAt: 1 }),
    User.find({ tenantId: tenant._id }).sort({ createdAt: 1 }),
    db.LandingPage.find({}).select('name slug isHome status revision publishedAt'),
    db.Product.countDocuments({}),
    db.Order.countDocuments({}),
    recomputeUsage(tenant._id, db),
  ]);

  return ok(res, {
    tenant,
    domains,
    users: users.map((u) => u.toSafeJSON()),
    pages,
    counts: { products, orders: orderCount },
    usage,
    primaryHost: await primaryHostOf(tenant),
  });
});

export const postTenant = asyncHandler(async (req, res) => {
  const result = await createTenant(req.body, { actor: req.user });
  const primaryHost = await primaryHostOf(result.tenant);
  const urls = adminUrlsFor(result.tenant, primaryHost);

  // Post-commit side effect: never let a mail failure undo the creation.
  if (result.password) {
    safeAsync(
      () =>
        sendMail(
          {
            to: result.owner.email,
            ...tenantWelcome({
              tenant: result.tenant,
              user: result.owner,
              password: result.password,
              adminUrls: urls,
              locale: result.tenant.defaultLocale,
            }),
          },
          {}
        ),
      { kind: 'email.tenant_welcome', tenantId: String(result.tenant._id) }
    );
  }

  audit(req, {
    action: 'platform.tenant_created',
    targetType: 'Tenant',
    targetId: result.tenant._id,
    tenantId: result.tenant._id,
    diff: { slug: result.tenant.slug, plan: result.tenant.plan.code },
  });

  return created(res, {
    tenant: result.tenant,
    owner: result.owner.toSafeJSON(),
    domain: result.domain,
    page: result.page ? { id: result.page._id, sections: result.page.sections.length } : null,
    pageError: result.pageError ?? null,
    adminUrls: urls,
    // Shown once in the UI so the operator can pass it on if email fails.
    generatedPassword: result.password,
  });
});

export const patchTenant = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId);
  if (!tenant) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

  const before = tenant.toObject();
  tenant.set(req.body);
  await tenant.save();
  bustTenantCache(tenant.slug);

  audit(req, {
    action: 'platform.tenant_updated',
    targetType: 'Tenant',
    targetId: tenant._id,
    tenantId: tenant._id,
    diff: { before: { name: before.name, flags: before.flags }, after: req.body },
  });

  return ok(res, tenant);
});

export const patchPlan = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId);
  if (!tenant) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

  const { planCode, expiresAt, status, limits } = req.body;

  if (planCode && planCode !== tenant.plan?.code) {
    const plan = await Plan.findOne({ code: planCode });
    if (!plan) throw unprocessable('Unknown plan', 'UNKNOWN_PLAN');
    // Re-snapshot: the tenant now holds the new plan's terms.
    tenant.plan = plan.toSnapshot();
  }
  // A negotiated override sits on top of the snapshot.
  if (limits) {
    for (const [k, v] of Object.entries(limits)) {
      if (v !== undefined) tenant.plan.limits[k] = v;
    }
  }
  if (expiresAt !== undefined) tenant.expiresAt = expiresAt;
  if (status) tenant.status = status;

  await tenant.save();
  bustTenantCache(tenant.slug);

  audit(req, {
    action: 'platform.plan_updated',
    targetType: 'Tenant',
    targetId: tenant._id,
    tenantId: tenant._id,
    diff: { planCode, expiresAt, status, limits },
  });

  return ok(res, tenant);
});

export const suspend = asyncHandler(async (req, res) => {
  const tenant = await suspendTenant(req.params.tenantId, req.body.reason, req.user);
  audit(req, {
    action: 'platform.tenant_suspended',
    targetType: 'Tenant',
    targetId: tenant._id,
    tenantId: tenant._id,
    diff: { reason: req.body.reason },
  });
  return ok(res, tenant);
});

export const activate = asyncHandler(async (req, res) => {
  const tenant = await activateTenant(req.params.tenantId);
  audit(req, {
    action: 'platform.tenant_activated',
    targetType: 'Tenant',
    targetId: tenant._id,
    tenantId: tenant._id,
  });
  return ok(res, tenant);
});

export const archive = asyncHandler(async (req, res) => {
  const tenant = await archiveTenant(req.params.tenantId);
  audit(req, {
    action: 'platform.tenant_archived',
    targetType: 'Tenant',
    targetId: tenant._id,
    tenantId: tenant._id,
  });
  return ok(res, { archived: true, slug: tenant.slug });
});

/**
 * Mints a 60-second, single-use handoff token and returns the URL to send the
 * operator to. The cookie is then set on the TENANT's own host, host-only —
 * which is how cross-domain sign-in works without a shared cookie.
 */
export const impersonate = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId);
  if (!tenant) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

  const owner = tenant.ownerUserId
    ? await User.findById(tenant.ownerUserId)
    : await User.findOne({ tenantId: tenant._id, role: 'tenant_owner', active: true });
  if (!owner) throw notFoundError('This tenant has no active owner', 'NO_OWNER');

  const token = signHandoff(
    { sub: String(owner._id), tid: String(tenant._id), imp: String(req.user._id) },
    60
  );

  const scheme = env.COOKIE_SECURE ? 'https' : 'http';
  const host = await primaryHostOf(tenant);

  audit(req, {
    action: 'platform.impersonate',
    targetType: 'Tenant',
    targetId: tenant._id,
    tenantId: tenant._id,
    diff: { asUser: owner.email, readOnly: req.user.role === 'platform_support' },
  });

  return ok(res, {
    url: `${scheme}://${host}/ul/session?t=${encodeURIComponent(token)}&next=/admin`,
    expiresInSeconds: 60,
    asUser: owner.toSafeJSON(),
  });
});

// ───────────────────── tenant users (from the platform) ─────────────────────

export const listTenantUsers = asyncHandler(async (req, res) => {
  const users = await User.find({ tenantId: req.params.tenantId }).sort({ createdAt: 1 });
  return ok(res, users.map((u) => u.toSafeJSON()));
});

export const createTenantUser = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId);
  if (!tenant) throw notFoundError('Tenant not found', 'TENANT_NOT_FOUND');

  const password = req.body.password || generatePassword();
  const user = await User.create({
    tenantId: tenant._id,
    scope: 'tenant',
    role: req.body.role || 'tenant_staff',
    name: req.body.name,
    email: String(req.body.email).toLowerCase().trim(),
    passwordHash: await User.hashPassword(password),
    locale: tenant.defaultLocale,
    mustChangePassword: !req.body.password,
    invitedBy: req.user._id,
  });

  const host = await primaryHostOf(tenant);
  const scheme = env.COOKIE_SECURE ? 'https' : 'http';
  safeAsync(
    () =>
      sendMail(
        {
          to: user.email,
          ...staffInvite({
            tenant,
            user,
            password,
            loginUrl: `${scheme}://${host}/login`,
            locale: tenant.defaultLocale,
          }),
        },
        {}
      ),
    { kind: 'email.staff_invite', tenantId: String(tenant._id) }
  );

  audit(req, {
    action: 'platform.tenant_user_created',
    targetType: 'User',
    targetId: user._id,
    tenantId: tenant._id,
    diff: { email: user.email, role: user.role },
  });

  return created(res, { user: user.toSafeJSON(), generatedPassword: req.body.password ? null : password });
});

export const resetTenantUserPassword = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.userId, tenantId: req.params.tenantId });
  if (!user) throw notFoundError('User not found', 'USER_NOT_FOUND');

  const password = generatePassword();
  user.passwordHash = await User.hashPassword(password);
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  // Kill every existing session for this user.
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  audit(req, {
    action: 'platform.tenant_user_password_reset',
    targetType: 'User',
    targetId: user._id,
    tenantId: req.params.tenantId,
  });

  return ok(res, { user: user.toSafeJSON(), generatedPassword: password });
});

// ───────────────────────── platform-wide orders ─────────────────────────

export const listAllOrders = asyncHandler(async (req, res) => {
  const q = req.validatedQuery ?? {};
  const { page, limit, skip } = pageParams(q);

  const filter = {};
  if (q.tenantId) filter.tenantId = q.tenantId;
  if (q.status) filter.status = q.status;
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = new Date(q.from);
    if (q.to) filter.createdAt.$lte = new Date(q.to);
  }

  // Explicit cross-tenant read. The guard throws without this, which is the
  // point: a platform-wide query has to be deliberate and greppable.
  const [items, total] = await Promise.all([
    Order.find(filter)
      .setOptions({ allowCrossTenant: true })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter).setOptions({ allowCrossTenant: true }),
  ]);

  const tenantIds = [...new Set(items.map((o) => String(o.tenantId)))];
  const tenants = await Tenant.find({ _id: { $in: tenantIds } }).select('slug name');
  const bySlug = Object.fromEntries(tenants.map((t) => [String(t._id), t]));

  return okList(
    res,
    items.map((o) => ({ ...o.toObject(), tenant: bySlug[String(o.tenantId)] ?? null })),
    pagination(total, page, limit)
  );
});
