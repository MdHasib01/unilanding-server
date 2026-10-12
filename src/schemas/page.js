import { z } from 'zod';
import { LOCALES } from '../utils/constants.js';

/**
 * The editor's save payload.
 *
 * The server validates the ENVELOPE strictly — brand, theme, seo, the section
 * list — and runs `data` through sanitiseSectionData. Per-field section schemas
 * live in the client registry (they also generate the editor form); duplicating
 * them here would mean two copies drifting apart.
 */

/** Mirrors client/src/sections/types.ts SECTION_TYPES. */
export const SECTION_TYPES = [
  'announcementBar',
  'hero',
  'imagine',
  'benefitsOrbit',
  'benefitsGrid',
  'reviewsCarousel',
  'certifications',
  'doctorsCarousel',
  'faq',
  'comparison',
  'emotionalCost',
  'guarantee',
  'pricingCard',
  'orderForm',
  'countdown',
  'logoCloud',
  'videoEmbed',
  'imageText',
  'richText',
  'footer',
  'stickyCta',
  'floatingActions',
];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const hex = z.string().regex(HEX, 'Must be a hex colour such as #0284c7');

/** Anything a browser could execute when used as an href or src. */
const DANGEROUS_URL = /^\s*(javascript|vbscript|data:text\/html|data:application)/i;

const safeUrl = z
  .string()
  .max(2000)
  .refine((v) => !DANGEROUS_URL.test(v.replace(/[\u0000-\u001f]/g, '')), 'Unsafe URL');

const imageRef = z
  .object({ url: safeUrl.default(''), publicId: z.string().max(400).default('') })
  .partial();

const i18nText = (max = 400) =>
  z.union([z.string().max(max), z.record(z.enum(LOCALES), z.string().max(max))]);

export const brandSchema = z
  .object({
    name: z.string().trim().max(160),
    logoType: z.enum(['image', 'text']),
    logo: imageRef,
    logoText: z.string().max(60),
    logoTextAccent: z.string().max(60),
    productImage: imageRef,
    favicon: imageRef,
    loaderBadge: z.string().max(160),
  })
  .partial();

export const themeSchema = z
  .object({
    primary: hex,
    accent: hex,
    cta: hex,
    ctaForeground: hex,
    background: hex,
    foreground: hex,
    radius: z.string().regex(/^[0-9]*\.?[0-9]+(rem|px|em)$/),
    fontHeading: z.string().max(60),
    fontBody: z.string().max(60),
    preset: z.string().max(40),
  })
  .partial();

export const seoSchema = z
  .object({
    title: i18nText(200),
    description: i18nText(500),
    keywords: z.array(z.string().max(60)).max(20),
    ogImage: imageRef,
    canonicalOverride: safeUrl.or(z.literal('')),
    noindex: z.boolean(),
  })
  .partial();

export const sectionSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{4,32}$/, 'Invalid section key'),
  type: z.enum(SECTION_TYPES),
  order: z.number().int().min(0).max(1000),
  enabled: z.boolean().default(true),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const saveDraftSchema = z
  .object({
    brand: brandSchema.optional(),
    theme: themeSchema.optional(),
    seo: seoSchema.optional(),
    sections: z
      .array(sectionSchema)
      .max(60)
      .refine((list) => new Set(list.map((s) => s.key)).size === list.length, 'Duplicate section key')
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to save');

// ── sanitising tenant-authored section data ─────────────────────────────────

const LIMITS = { depth: 8, string: 10_000, array: 100, keys: 120 };
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class UnsafeContentError extends Error {
  constructor(path, reason) {
    super(`${reason} at ${path || '(root)'}`);
    this.path = path;
  }
}

/**
 * Deep-copies section data, refusing anything that could become markup or
 * script on a page we serve on the tenant's own domain:
 *
 *  - event-handler-shaped keys (onClick, onerror…) are dropped,
 *  - prototype-pollution keys are dropped,
 *  - javascript:/vbscript:/data:text/html strings are rejected outright
 *    (a loud 422, so the tenant sees which field is wrong),
 *  - strings, arrays, key counts and nesting depth are capped.
 */
export function sanitiseSectionData(value, path = '', depth = 0) {
  if (depth > LIMITS.depth) throw new UnsafeContentError(path, 'Content nested too deeply');

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  if (typeof value === 'string') {
    if (value.length > LIMITS.string) throw new UnsafeContentError(path, 'Text too long');
    if (DANGEROUS_URL.test(value.replace(/[\u0000-\u001f]/g, ''))) {
      throw new UnsafeContentError(path, 'Unsafe URL');
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > LIMITS.array) throw new UnsafeContentError(path, 'Too many items');
    return value.map((v, i) => sanitiseSectionData(v, `${path}[${i}]`, depth + 1));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > LIMITS.keys) throw new UnsafeContentError(path, 'Too many fields');
    const out = {};
    for (const [k, v] of entries) {
      if (FORBIDDEN_KEYS.has(k) || /^on[A-Z]/.test(k) || HANDLER_NAMES.has(k.toLowerCase())) continue;
      if (v === undefined) continue;
      out[k] = sanitiseSectionData(v, path ? `${path}.${k}` : k, depth + 1);
    }
    return out;
  }

  // functions, symbols, bigints: never valid JSON content.
  return null;
}

/** Lower-case DOM handler names, so `onerror` is caught but `only` is not. */
const HANDLER_NAMES = new Set([
  'onclick', 'onerror', 'onload', 'onmouseover', 'onmouseout', 'onfocus', 'onblur',
  'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress', 'oninput', 'onanimationstart',
  'ontoggle', 'onbegin', 'onpointerdown', 'onpointerup', 'ontouchstart',
]);
