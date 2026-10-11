import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Tenant } from '../models/index.js';

/**
 * Plan limits, counted live rather than trusted from Tenant.usage, because a
 * stale counter would either block a tenant unfairly or let them past the cap.
 * Tenant.usage stays as a display value for the dashboard.
 */
const COUNTERS = {
  landingPages: (db) => db.LandingPage.countDocuments({}),
  products: (db) => db.Product.countDocuments({}),
  mediaMb: async (db) => {
    const [agg] = await db.MediaAsset.aggregate([
      { $group: { _id: null, bytes: { $sum: '$bytes' } } },
    ]);
    return Math.round((agg?.bytes || 0) / (1024 * 1024));
  },
  ordersPerMonth: (db) => {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return db.Order.countDocuments({ createdAt: { $gte: start } });
  },
};

/**
 * A 402 with the numbers in the body, so the client can render a real upgrade
 * prompt instead of a generic failure.
 */
export const enforceLimit = (resource) =>
  asyncHandler(async (req, _res, next) => {
    const tenant = req.tenant;
    if (!tenant) throw new AppError('Tenant unresolved', 400, 'TENANT_UNRESOLVED');

    const limit = tenant.plan?.limits?.[resource];
    // null or undefined means unmetered.
    if (limit === null || limit === undefined) return next();

    const counter = COUNTERS[resource];
    if (!counter) return next();

    const used = await counter(req.db);
    if (used >= limit) {
      throw new AppError(
        `Your ${tenant.plan.name} plan allows ${limit} ${resource}. You have ${used}.`,
        402,
        'PLAN_LIMIT',
        { resource, limit, used, plan: tenant.plan.code }
      );
    }
    next();
  });

/** Staff seats are counted on User, which is not a req.db model. */
export const enforceStaffLimit = asyncHandler(async (req, _res, next) => {
  const { User } = await import('../models/index.js');
  const tenant = req.tenant;
  const limit = tenant?.plan?.limits?.staffUsers;
  if (limit === null || limit === undefined) return next();

  const used = await User.countDocuments({ tenantId: tenant._id, active: true });
  if (used >= limit) {
    throw new AppError(
      `Your ${tenant.plan.name} plan allows ${limit} users. You have ${used}.`,
      402,
      'PLAN_LIMIT',
      { resource: 'staffUsers', limit, used, plan: tenant.plan.code }
    );
  }
  next();
});

/** Refreshes the cached usage figures shown in the dashboard. */
export async function recomputeUsage(tenantId, db) {
  const period = new Date().toISOString().slice(0, 7);
  const [landingPages, products, mediaMb, ordersThisMonth] = await Promise.all([
    COUNTERS.landingPages(db),
    COUNTERS.products(db),
    COUNTERS.mediaMb(db),
    COUNTERS.ordersPerMonth(db),
  ]);
  const { User } = await import('../models/index.js');
  const staffUsers = await User.countDocuments({ tenantId, active: true });

  await Tenant.findByIdAndUpdate(tenantId, {
    $set: {
      'usage.landingPages': landingPages,
      'usage.products': products,
      'usage.staffUsers': staffUsers,
      'usage.mediaBytes': mediaMb * 1024 * 1024,
      'usage.ordersThisMonth': ordersThisMonth,
      'usage.usagePeriod': period,
    },
  });

  return { landingPages, products, staffUsers, mediaMb, ordersThisMonth, usagePeriod: period };
}
