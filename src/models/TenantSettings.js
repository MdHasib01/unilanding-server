import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';
import { SETTINGS_KEYS } from '../utils/constants.js';

/**
 * One document per settings section rather than a single blob, so a courier
 * save cannot clobber a concurrent SMS save and GET /settings/courier returns
 * one small document.
 *
 * Credential fields inside `values` are stored encrypted (see cryptoService)
 * and are masked by the controller on the way out. They are never returned in
 * plaintext, and the client echoes the UNCHANGED sentinel when it is not
 * editing them.
 */
const tenantSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, enum: SETTINGS_KEYS, required: true },
    values: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false }
);

tenantSettingsSchema.plugin(tenantScope, { modelName: 'TenantSettings' });
tenantSettingsSchema.index({ tenantId: 1, key: 1 }, { unique: true });

/** Defaults are applied on read, so adding a setting never needs a migration. */
export const SETTINGS_DEFAULTS = {
  general: {
    supportPhone: '',
    supportEmail: '',
    whatsapp: '',
    businessHours: '',
  },
  orders: {
    // Server-side authority for delivery pricing. The client computes the same
    // numbers for display only.
    deliveryCharges: { inside: 0, outside: 0, freeAbove: null, insideLabel: 'Dhaka' },
    requireDistrict: true,
    requireThana: false,
    allowAltPhone: false,
    requireEmail: false,
    orderNumberPrefix: 'UL',
    // Empty means fall back to the bundled 64-district Bangladesh dataset.
    locations: [],
  },
  courier: {
    provider: '', // '' | 'steadfast'
    enabled: false,
    apiKey: '',
    secretKey: '',
    autoDispatchOnConfirm: true,
  },
  sms: {
    provider: '', // '' | 'bdbulksms'
    enabled: false,
    apiUrl: '',
    token: '',
    senderId: '',
    notifyCustomerOnOrder: true,
    notifyAdminOnOrder: true,
    otpOnOrder: false,
  },
  email: {
    // Blank uses the platform SMTP transport.
    useOwnSmtp: false,
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    fromName: '',
    fromEmail: '',
    notifyOnOrder: true,
    adminRecipients: [],
  },
  payments: {
    cod: { enabled: true, label: '' },
    manualBkash: { enabled: false, number: '', instructions: '' },
    manualNagad: { enabled: false, number: '', instructions: '' },
    manualRocket: { enabled: false, number: '', instructions: '' },
    bankTransfer: { enabled: false, details: '' },
  },
  tracking: {
    metaPixelId: '',
    metaCapiToken: '',
    metaTestEventCode: '',
    gtmId: '',
    ga4Id: '',
    tiktokPixelId: '',
    clarityId: '',
  },
  invoice: {
    prefix: 'INV',
    footerNote: '',
    showLogo: true,
    terms: '',
  },
  notifications: {
    emailOnNewOrder: true,
    emailOnNewLead: false,
    dailySummary: false,
  },
};

const deepDefaults = (defaults, stored) => {
  if (Array.isArray(defaults)) return stored === undefined ? defaults : stored;
  if (defaults && typeof defaults === 'object') {
    const out = {};
    const keys = new Set([...Object.keys(defaults), ...Object.keys(stored || {})]);
    for (const k of keys) out[k] = deepDefaults(defaults[k], (stored || {})[k]);
    return out;
  }
  return stored === undefined ? defaults : stored;
};

/** Upsert-with-defaults, self-healing as new settings are introduced. */
tenantSettingsSchema.statics.get = async function (tenantId, key) {
  const doc = await this.findOne({ tenantId, key });
  const values = deepDefaults(SETTINGS_DEFAULTS[key] || {}, doc?.values || {});
  return { key, values, updatedAt: doc?.updatedAt || null };
};

tenantSettingsSchema.statics.getAll = async function (tenantId) {
  const docs = await this.find({ tenantId });
  const byKey = Object.fromEntries(docs.map((d) => [d.key, d.values]));
  const out = {};
  for (const key of SETTINGS_KEYS) {
    out[key] = deepDefaults(SETTINGS_DEFAULTS[key] || {}, byKey[key] || {});
  }
  return out;
};

export const TenantSettings = mongoose.model('TenantSettings', tenantSettingsSchema);
export default TenantSettings;
