import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';

/**
 * Makes a cross-tenant data leak a crash instead of a breach.
 *
 * Every tenant-owned model gets this plugin. Any query that reaches Mongo
 * without a tenantId filter throws a 500 — so the failure mode is a loud error
 * in development, never silent exfiltration in production. Platform-wide reads
 * must opt out explicitly with .setOptions({ allowCrossTenant: true }), which
 * is deliberately verbose so it is greppable in review.
 *
 * This is layer 1 of 4. Layer 2 is scopedModels() (binds tenantId into every
 * call), layer 3 is requireTenantMember (cross-checks the JWT against the
 * resolved host), layer 4 is nanoid public ids so order URLs can't be walked.
 */

const READ_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'distinct',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'replaceOne',
];

export function tenantScope(schema, options = {}) {
  const modelName = options.modelName || 'model';

  schema.add({
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      // Deliberately NOT index: true. Each model declares a compound index
      // leading with tenantId, and that prefix already serves tenantId-only
      // queries. A standalone index here would be redundant write cost — and
      // would collide with the partial-unique { tenantId: 1 } guards.
    },
  });

  function guard(next) {
    const opts = typeof this.getOptions === 'function' ? this.getOptions() : {};
    if (opts?.allowCrossTenant === true) return next();

    const filter = typeof this.getFilter === 'function' ? this.getFilter() : {};
    if (filter && filter.tenantId !== undefined && filter.tenantId !== null) return next();

    return next(
      new AppError(
        `Unscoped query on ${modelName}. Use req.db.${modelName} or ` +
          `.setOptions({ allowCrossTenant: true }) for a deliberate platform-wide read.`,
        500,
        'UNSCOPED_TENANT_QUERY'
      )
    );
  }

  for (const hook of READ_HOOKS) schema.pre(hook, guard);

  // estimatedDocumentCount ignores filters entirely, so it can never be scoped.
  schema.pre('estimatedDocumentCount', function (next) {
    next(
      new AppError(
        `estimatedDocumentCount is not tenant-scopable on ${modelName}; use countDocuments.`,
        500,
        'UNSCOPED_TENANT_QUERY'
      )
    );
  });

  // An aggregation must begin with a $match carrying tenantId, otherwise the
  // first stage reads across every tenant before anything can narrow it.
  schema.pre('aggregate', function (next) {
    const opts = this.options || {};
    if (opts.allowCrossTenant === true) return next();
    const first = this.pipeline()[0];
    if (first && first.$match && first.$match.tenantId !== undefined) return next();
    return next(
      new AppError(
        `Aggregation on ${modelName} must start with { $match: { tenantId } } ` +
          `or pass { allowCrossTenant: true }.`,
        500,
        'UNSCOPED_TENANT_QUERY'
      )
    );
  });

  schema.pre('validate', function (next) {
    if (!this.tenantId) {
      return next(
        new AppError(`${modelName} requires a tenantId`, 500, 'MISSING_TENANT_ID')
      );
    }
    next();
  });
}
