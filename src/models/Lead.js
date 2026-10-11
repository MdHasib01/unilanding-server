import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';
import { LEAD_STATUSES } from '../utils/constants.js';

/**
 * Abandoned-cart capture. Replaces the reference's UnfinishedOrder. Expires on
 * its own so a tenant's lead table cannot grow without bound.
 */
const leadSchema = new mongoose.Schema(
  {
    landingPageId: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage', default: null },
    phone: { type: String, default: '', trim: true },
    name: { type: String, default: '', trim: true },
    email: { type: String, default: '', lowercase: true, trim: true },
    partial: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // Covered by { tenantId, status, lastSeenAt }.
    status: { type: String, enum: LEAD_STATUSES, default: 'new' },
    convertedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    note: { type: String, default: '' },
    touches: { type: Number, default: 1 },
    client: {
      ip: { type: String, default: '' },
      userAgent: { type: String, default: '' },
      pageUrl: { type: String, default: '' },
    },
    marketing: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

leadSchema.plugin(tenantScope, { modelName: 'Lead' });

leadSchema.index({ tenantId: 1, status: 1, lastSeenAt: -1 });
leadSchema.index({ tenantId: 1, phone: 1 });
leadSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const Lead = mongoose.model('Lead', leadSchema);
export default Lead;
