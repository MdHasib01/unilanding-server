import mongoose from 'mongoose';
import { softDelete } from './plugins/softDelete.js';
import {
  TENANT_STATUSES,
  LOCALES,
  DEFAULT_LOCALE,
  CURRENCIES,
} from '../utils/constants.js';
import { TENANT_SLUG_RE } from '../utils/slug.js';

const imageRef = {
  url: { type: String, default: '' },
  publicId: { type: String, default: '' },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
};

/**
 * Plan is stored as a SNAPSHOT, not a reference. Editing a plan in the catalog
 * must never silently re-limit a tenant that already signed up on the old
 * terms; an upgrade explicitly rewrites this subdocument.
 */
const planSnapshot = new mongoose.Schema(
  {
    code: { type: String, default: 'starter' },
    name: { type: String, default: 'Starter' },
    price: { type: Number, default: 0 },
    interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    limits: {
      landingPages: { type: Number, default: 1 },
      products: { type: Number, default: 10 },
      staffUsers: { type: Number, default: 2 },
      ordersPerMonth: { type: Number, default: 2000 },
      customDomains: { type: Number, default: 1 },
      mediaMb: { type: Number, default: 500 },
      // null = every section type is allowed
      sectionTypes: { type: [String], default: null },
    },
  },
  { _id: false }
);

const tenantSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: [true, 'Slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [TENANT_SLUG_RE, 'Invalid slug format'],
    },
    name: { type: String, required: [true, 'Business name is required'], trim: true },
    legalName: { type: String, default: '', trim: true },
    logo: imageRef,
    favicon: { url: { type: String, default: '' }, publicId: { type: String, default: '' } },
    productName: { type: String, default: '', trim: true },
    industry: { type: String, default: '', trim: true },

    // Covered by { status, createdAt }.
    status: { type: String, enum: TENANT_STATUSES, default: 'pending' },
    suspendedReason: { type: String, default: '' },

    // i18n: the page renders in defaultLocale unless the visitor picks another
    // enabled one. A single-locale tenant never sees a language switcher.
    defaultLocale: { type: String, enum: LOCALES, default: DEFAULT_LOCALE },
    enabledLocales: {
      type: [{ type: String, enum: LOCALES }],
      default: [DEFAULT_LOCALE],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'At least one locale must be enabled',
      },
    },

    currency: { type: String, enum: CURRENCIES, default: 'BDT' },
    timezone: { type: String, default: 'Asia/Dhaka' },

    contact: {
      email: { type: String, default: '', lowercase: true, trim: true },
      phone: { type: String, default: '', trim: true },
      whatsapp: { type: String, default: '', trim: true },
      address: { type: String, default: '', trim: true },
      city: { type: String, default: '', trim: true },
      country: { type: String, default: 'BD', trim: true },
    },

    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    primaryDomainId: { type: mongoose.Schema.Types.ObjectId, ref: 'Domain', default: null },

    plan: { type: planSnapshot, default: () => ({}) },
    // Billing is manual: the platform owner sets plan/status/expiresAt by hand.
    expiresAt: { type: Date, default: null },

    usage: {
      landingPages: { type: Number, default: 0 },
      products: { type: Number, default: 0 },
      staffUsers: { type: Number, default: 0 },
      mediaBytes: { type: Number, default: 0 },
      ordersThisMonth: { type: Number, default: 0 },
      usagePeriod: { type: String, default: '' }, // 'YYYY-MM'
    },

    flags: {
      autoPublish: { type: Boolean, default: false },
      allowCustomDomain: { type: Boolean, default: true },
      whiteLabel: { type: Boolean, default: false },
      otpOnOrder: { type: Boolean, default: false },
    },

    onboarding: {
      step: {
        type: String,
        enum: ['created', 'branded', 'page_built', 'domain_mapped', 'live'],
        default: 'created',
      },
      completedAt: { type: Date, default: null },
    },

    notes: { type: String, default: '' }, // platform-internal, never sent to the tenant
  },
  { timestamps: true }
);

tenantSchema.plugin(softDelete);

tenantSchema.index({ status: 1, createdAt: -1 });
tenantSchema.index({ 'plan.code': 1 });
tenantSchema.index({ ownerUserId: 1 });

/** A tenant whose plan lapsed is treated as suspended by the public renderer. */
tenantSchema.methods.isLive = function () {
  if (this.status !== 'active') return false;
  if (this.expiresAt && this.expiresAt.getTime() < Date.now()) return false;
  return true;
};

tenantSchema.methods.toPublicJSON = function () {
  return {
    id: this._id,
    slug: this.slug,
    name: this.name,
    logo: this.logo,
    favicon: this.favicon,
    productName: this.productName,
    defaultLocale: this.defaultLocale,
    enabledLocales: this.enabledLocales,
    currency: this.currency,
    timezone: this.timezone,
    contact: {
      phone: this.contact?.phone || '',
      whatsapp: this.contact?.whatsapp || '',
      email: this.contact?.email || '',
      address: this.contact?.address || '',
    },
    whiteLabel: this.flags?.whiteLabel || false,
  };
};

export const Tenant = mongoose.model('Tenant', tenantSchema);
export default Tenant;
