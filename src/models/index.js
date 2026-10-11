import { Tenant } from './Tenant.js';
import { Domain } from './Domain.js';
import { User } from './User.js';
import { Plan } from './Plan.js';
import { LandingPage } from './LandingPage.js';
import { LandingPageRevision } from './LandingPageRevision.js';
import { Product } from './Product.js';
import { Order } from './Order.js';
import { Lead } from './Lead.js';
import { TenantSettings } from './TenantSettings.js';
import { MediaAsset } from './MediaAsset.js';
import { OtpToken } from './OtpToken.js';
import { AuditLog } from './AuditLog.js';
import { Counter } from './Counter.js';

export {
  Tenant,
  Domain,
  User,
  Plan,
  LandingPage,
  LandingPageRevision,
  Product,
  Order,
  Lead,
  TenantSettings,
  MediaAsset,
  OtpToken,
  AuditLog,
  Counter,
};

/** Models that carry a tenantId and are reachable through req.db. */
const TENANT_MODELS = {
  LandingPage,
  LandingPageRevision,
  Product,
  Order,
  Lead,
  TenantSettings,
  MediaAsset,
  OtpToken,
};

/**
 * Query methods whose FIRST argument is a filter. tenantId is merged in, and
 * any client-supplied tenantId in that filter is overwritten rather than
 * trusted.
 */
const FILTER_FIRST = new Set([
  'find',
  'findOne',
  'countDocuments',
  'distinct',
  'exists',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]);

/** Query methods shaped (filter, update|replacement, options). */
const FILTER_THEN_PAYLOAD = new Set([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
]);

/** Fields a client must never be able to set, whatever it posts. */
const stripImmutable = (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(stripImmutable);
  const { tenantId, _id, __v, createdAt, updatedAt, ...rest } = payload;
  return rest;
};

/**
 * Layer 2 of the tenant-isolation design (layer 1 is the tenantScope plugin,
 * which throws on any unscoped query; layer 3 is requireTenantMember; layer 4
 * is non-enumerable public ids).
 *
 * Controllers only ever touch req.db.<Model>. Every call gets tenantId merged
 * into the filter and stamped onto the payload, so forgetting to scope a query
 * is not something a controller author can do.
 */
export function scopedModels(tenantId) {
  if (!tenantId) throw new Error('scopedModels requires a tenantId');

  const facade = {};

  for (const [name, Model] of Object.entries(TENANT_MODELS)) {
    const bound = {
      /** The raw model, for the rare deliberate case. Scope it yourself. */
      $model: Model,
      tenantId,

      create(doc) {
        const stamp = (d) => ({ ...stripImmutable(d), tenantId });
        return Model.create(Array.isArray(doc) ? doc.map(stamp) : stamp(doc));
      },

      aggregate(pipeline = [], options = {}) {
        return Model.aggregate([{ $match: { tenantId } }, ...pipeline], options);
      },

      insertMany(docs, options) {
        return Model.insertMany(
          docs.map((d) => ({ ...stripImmutable(d), tenantId })),
          options
        );
      },

      bulkWrite(ops, options) {
        // Each operation carries its own filter, so scope them individually.
        const scoped = ops.map((op) => {
          const [kind] = Object.keys(op);
          const body = { ...op[kind] };
          if (body.filter) body.filter = { ...body.filter, tenantId };
          if (kind === 'insertOne' && body.document) {
            body.document = { ...stripImmutable(body.document), tenantId };
          }
          return { [kind]: body };
        });
        return Model.bulkWrite(scoped, options);
      },
    };

    for (const method of FILTER_FIRST) {
      bound[method] = (filter = {}, ...rest) =>
        Model[method]({ ...filter, tenantId }, ...rest);
    }

    for (const method of FILTER_THEN_PAYLOAD) {
      bound[method] = (filter = {}, payload = {}, options = undefined) => {
        // An update may be a plain patch or use operators; strip immutables
        // from both shapes without breaking $inc / $push / $pull.
        let safe = payload;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const hasOperators = Object.keys(payload).some((k) => k.startsWith('$'));
          safe = hasOperators
            ? { ...payload, ...(payload.$set ? { $set: stripImmutable(payload.$set) } : {}) }
            : stripImmutable(payload);
        }
        return Model[method]({ ...filter, tenantId }, safe, options);
      };
    }

    /** findById that cannot escape the tenant. */
    bound.findById = (id, ...rest) => Model.findOne({ _id: id, tenantId }, ...rest);

    facade[name] = bound;
  }

  return facade;
}
