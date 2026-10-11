import mongoose from 'mongoose';
import { DOMAIN_TYPES, DOMAIN_STATUSES, SSL_STATUSES } from '../utils/constants.js';

/**
 * A hostname mapped to a tenant. Three kinds:
 *  - platform_subdomain  <slug>.unilanding.com — auto-created, covered by the
 *    wildcard cert, never needs DNS verification.
 *  - custom_subdomain    shop.example.com      — verified by CNAME.
 *  - custom_apex         example.com           — verified by TXT at _unilanding.
 *
 * host is the lookup key for the Next proxy, so it is stored normalized:
 * lowercase, no scheme, no port, no trailing dot.
 */
const domainSchema = new mongoose.Schema(
  {
    host: {
      type: String,
      required: [true, 'Host is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      // Covered by the { tenantId, isPrimary } compound index below.
    },
    type: { type: String, enum: DOMAIN_TYPES, required: true },
    isPrimary: { type: Boolean, default: false },
    // Covered by { status, verification.lastCheckedAt }.
    status: { type: String, enum: DOMAIN_STATUSES, default: 'pending' },

    verification: {
      method: { type: String, enum: ['txt', 'cname', 'none'], default: 'txt' },
      token: { type: String, default: '' },
      recordName: { type: String, default: '' },
      recordValue: { type: String, default: '' },
      attempts: { type: Number, default: 0 },
      lastCheckedAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
      verifiedAt: { type: Date, default: null },
    },

    ssl: {
      status: { type: String, enum: SSL_STATUSES, default: 'none' },
      provider: {
        type: String,
        enum: ['', 'vercel', 'caddy', 'cloudflare', 'manual'],
        default: '',
      },
      issuedAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
    },

    /** Set on www.example.com to 301 it to the apex. */
    redirectTo: { type: String, default: '' },

    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

domainSchema.index({ tenantId: 1, isPrimary: -1 });
domainSchema.index({ status: 1, 'verification.lastCheckedAt': 1 });
// At most one primary domain per tenant, enforced by the database rather than
// by application code that could race.
domainSchema.index(
  { tenantId: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true } }
);

/** Only an active domain with a usable certificate may serve a tenant. */
domainSchema.methods.isServable = function () {
  if (this.status !== 'active') return false;
  if (this.type === 'platform_subdomain') return true;
  return this.ssl.status === 'issued';
};

export const Domain = mongoose.model('Domain', domainSchema);
export default Domain;
