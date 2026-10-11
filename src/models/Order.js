import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';
import {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ORDER_SOURCES,
  LOCALES,
} from '../utils/constants.js';

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, required: true },
    sku: { type: String, default: '' },
    unitPrice: { type: Number, required: true, min: 0 },
    qty: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const statusEventSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    /** Human-facing, per-tenant, gapless. Example: ML-000142 */
    orderNumber: { type: String, required: true },
    /**
     * Opaque handle used in the track and invoice URLs. A nanoid rather than
     * the ObjectId, so order URLs cannot be enumerated by an outsider.
     */
    publicId: { type: String, required: true },

    landingPageId: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage', default: null },
    /** Locale the customer ordered in. Emails and SMS are sent in it. */
    locale: { type: String, enum: LOCALES, default: 'bn' },

    customer: {
      name: { type: String, default: 'Customer', trim: true },
      phone: { type: String, required: [true, 'Phone number is required'], trim: true },
      altPhone: { type: String, default: '', trim: true },
      email: { type: String, default: '', lowercase: true, trim: true },
    },

    shipping: {
      district: { type: String, default: '', trim: true },
      thana: { type: String, default: '', trim: true },
      address: { type: String, default: '', trim: true },
      postcode: { type: String, default: '', trim: true },
      note: { type: String, default: '' },
    },

    items: { type: [orderItemSchema], default: [] },

    /** Every figure here is computed server-side from the catalog. */
    pricing: {
      subtotal: { type: Number, required: true, min: 0 },
      deliveryCharge: { type: Number, default: 0, min: 0 },
      discount: { type: Number, default: 0, min: 0 },
      total: { type: Number, required: true, min: 0 },
      currency: { type: String, default: 'BDT' },
    },

    payment: {
      method: { type: String, enum: PAYMENT_METHODS, default: 'cod' },
      status: { type: String, enum: PAYMENT_STATUSES, default: 'due' },
      transactionId: { type: String, default: '', trim: true },
      paidAmount: { type: Number, default: 0 },
      paidAt: { type: Date, default: null },
    },

    // Covered by { tenantId, status, createdAt }.
    status: { type: String, enum: ORDER_STATUSES, default: 'pending' },
    statusHistory: { type: [statusEventSchema], default: [] },

    source: { type: String, enum: ORDER_SOURCES, default: 'web' },

    client: {
      ip: { type: String, default: '' },
      userAgent: { type: String, default: '' },
      pageUrl: { type: String, default: '' },
      referer: { type: String, default: '' },
      ipLocation: {
        city: { type: String, default: '' },
        region: { type: String, default: '' },
        country: { type: String, default: '' },
        loc: { type: String, default: '' },
        org: { type: String, default: '' },
        postal: { type: String, default: '' },
        timezone: { type: String, default: '' },
      },
    },

    /** First-touch attribution, captured client-side and attached on submit. */
    marketing: {
      fbp: { type: String, default: '' },
      fbc: { type: String, default: '' },
      attribution: {
        fbclid: { type: String, default: '' },
        gclid: { type: String, default: '' },
        gbraid: { type: String, default: '' },
        wbraid: { type: String, default: '' },
        ttclid: { type: String, default: '' },
        msclkid: { type: String, default: '' },
        utmSource: { type: String, default: '' },
        utmMedium: { type: String, default: '' },
        utmCampaign: { type: String, default: '' },
        utmTerm: { type: String, default: '' },
        utmContent: { type: String, default: '' },
        referrer: { type: String, default: '' },
        landingUrl: { type: String, default: '' },
        landingPath: { type: String, default: '' },
        firstSeenAt: { type: Date, default: null },
      },
    },

    /**
     * Provider-shaped rather than the reference's flat steadfast* columns, so
     * adding a second courier is an adapter rather than a migration.
     */
    integrations: {
      courier: {
        provider: { type: String, default: '' },
        consignmentId: { type: String, default: '' },
        trackingCode: { type: String, default: '' },
        status: { type: String, default: '' },
        sentAt: { type: Date, default: null },
        lastSyncAt: { type: Date, default: null },
        lastError: { type: String, default: '' },
        raw: { type: mongoose.Schema.Types.Mixed, default: null },
      },
      pixel: {
        purchaseSentAt: { type: Date, default: null },
        value: { type: Number, default: null },
        status: { type: String, enum: ['', 'sent', 'failed'], default: '' },
        error: { type: String, default: '' },
      },
      sms: {
        customerSentAt: { type: Date, default: null },
        adminSentAt: { type: Date, default: null },
        lastError: { type: String, default: '' },
      },
    },

    fraud: {
      provider: { type: String, default: '' },
      checkedAt: { type: Date, default: null },
      totalDelivered: { type: Number, default: null },
      totalCancelled: { type: Number, default: null },
      score: { type: Number, default: null },
      raw: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    internalNote: { type: String, default: '' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

orderSchema.plugin(tenantScope, { modelName: 'Order' });

// ESR: equality fields first, then the sort key. These carry every admin list
// query; without tenantId leading, one big tenant slows down every other.
orderSchema.index({ tenantId: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, 'customer.phone': 1 });
orderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, 'integrations.courier.consignmentId': 1 }, { sparse: true });
orderSchema.index({ publicId: 1 }, { unique: true });
// Platform-wide feed across tenants (deliberate allowCrossTenant reads).
orderSchema.index({ createdAt: -1 });
// Drives the hourly Conversions API retry sweep.
orderSchema.index({ tenantId: 1, status: 1, 'integrations.pixel.purchaseSentAt': 1 });

export const Order = mongoose.model('Order', orderSchema);
export default Order;
