import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * Tenant-authored text is a locale map, not a string: { bn: '...', en: '...' }.
 * Structure (section order, toggles) is shared across locales so a tenant
 * arranges the page once; only the copy is per-language. A single-locale tenant
 * just has a one-key map and the editor shows a plain input.
 */
const i18nText = { type: mongoose.Schema.Types.Mixed, default: () => ({}) };

const seoSchema = new mongoose.Schema(
  {
    title: i18nText,
    description: i18nText,
    keywords: { type: [String], default: [] },
    ogImage: { url: { type: String, default: '' }, publicId: { type: String, default: '' } },
    canonicalOverride: { type: String, default: '' },
    noindex: { type: Boolean, default: false },
  },
  { _id: false }
);

const themeSchema = new mongoose.Schema(
  {
    primary: { type: String, default: '#bd0052' },
    accent: { type: String, default: '#e37a69' },
    cta: { type: String, default: '#ffd666' },
    ctaForeground: { type: String, default: '#3a2600' },
    background: { type: String, default: '#fff9f6' },
    foreground: { type: String, default: '#111827' },
    radius: { type: String, default: '1rem' },
    fontHeading: { type: String, default: 'hind-siliguri' },
    fontBody: { type: String, default: 'hind-siliguri' },
    preset: { type: String, default: '' },
  },
  { _id: false }
);

const trackingSchema = new mongoose.Schema(
  {
    metaPixelId: { type: String, default: '' },
    metaCapiToken: { type: mongoose.Schema.Types.Mixed, default: '' }, // encrypted at rest
    metaTestEventCode: { type: String, default: '' },
    gtmId: { type: String, default: '' },
    ga4Id: { type: String, default: '' },
    tiktokPixelId: { type: String, default: '' },
    clarityId: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * A section instance. `key` is a stable nanoid that survives reorders and
 * renames, so revisions and per-section saves can address it. `data` is
 * deliberately Mixed: the per-field schemas live in the client's section
 * registry, and the server validates only the envelope plus a sanitising pass.
 */
const sectionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    type: { type: String, required: true },
    order: { type: Number, required: true, min: 0 },
    enabled: { type: Boolean, default: true },
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false }
);

const contentSlot = {
  seo: { type: seoSchema, default: () => ({}) },
  theme: { type: themeSchema, default: () => ({}) },
  tracking: { type: trackingSchema, default: () => ({}) },
  sections: { type: [sectionSchema], default: [] },
};

const landingPageSchema = new mongoose.Schema(
  {
    slug: { type: String, default: '', lowercase: true, trim: true }, // '' = home
    name: { type: String, required: [true, 'Page name is required'], trim: true },
    isHome: { type: Boolean, default: false },
    template: { type: String, default: 'bd-dtc-v1' },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revision: { type: Number, default: 0 },

    // ── LIVE: what the public renders. One document, zero joins. ──
    ...contentSlot,

    // ── DRAFT: what the editor edits. Never touches live until Publish. ──
    draft: {
      ...contentSlot,
      updatedAt: { type: Date, default: null },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      dirty: { type: Boolean, default: false },
    },

    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  },
  { timestamps: true }
);

landingPageSchema.plugin(tenantScope, { modelName: 'LandingPage' });

landingPageSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
landingPageSchema.index(
  { tenantId: 1 },
  { unique: true, partialFilterExpression: { isHome: true } }
);

export const LandingPage = mongoose.model('LandingPage', landingPageSchema);
export default LandingPage;
