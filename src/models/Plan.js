import mongoose from 'mongoose';

/**
 * Catalog only — used to populate the create/upgrade UI. The authoritative
 * limits for a live tenant are the snapshot on Tenant.plan.
 */
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'BDT' },
    interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    limits: {
      landingPages: { type: Number, default: 1 },
      products: { type: Number, default: 10 },
      staffUsers: { type: Number, default: 2 },
      ordersPerMonth: { type: Number, default: 2000 },
      customDomains: { type: Number, default: 1 },
      mediaMb: { type: Number, default: 500 },
      sectionTypes: { type: [String], default: null },
    },
    features: { type: [String], default: [] },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    public: { type: Boolean, default: true },
  },
  { timestamps: true }
);

planSchema.index({ active: 1, sortOrder: 1 });

/** Shapes a catalog plan into the snapshot stored on a tenant. */
planSchema.methods.toSnapshot = function () {
  return {
    code: this.code,
    name: this.name,
    price: this.price,
    interval: this.interval,
    limits: {
      landingPages: this.limits.landingPages,
      products: this.limits.products,
      staffUsers: this.limits.staffUsers,
      ordersPerMonth: this.limits.ordersPerMonth,
      customDomains: this.limits.customDomains,
      mediaMb: this.limits.mediaMb,
      sectionTypes: this.limits.sectionTypes,
    },
  };
};

export const Plan = mongoose.model('Plan', planSchema);
export default Plan;
