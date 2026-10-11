import { z } from 'zod';
import { LOCALES, CURRENCIES, TENANT_STATUSES } from '../utils/constants.js';
import { TENANT_SLUG_RE } from '../utils/slug.js';

const hex = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour such as #bd0052');

export const imageRefSchema = z.object({
  url: z.string().max(2000).default(''),
  publicId: z.string().max(400).default(''),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const createTenantSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(TENANT_SLUG_RE, '3-40 characters: lowercase letters, numbers and hyphens'),
  name: z.string().trim().min(1, 'Business name is required').max(160),
  legalName: z.string().trim().max(200).optional(),
  productName: z.string().trim().max(160).optional(),
  productPrice: z.coerce.number().min(0).optional(),
  productOfferPrice: z.coerce.number().min(0).optional(),
  industry: z.string().trim().max(80).optional(),
  logo: imageRefSchema.partial().optional(),

  ownerName: z.string().trim().max(120).optional(),
  ownerEmail: z.string().trim().toLowerCase().email('A valid owner email is required'),
  // Omit to have one generated and emailed.
  ownerPassword: z.string().min(10).max(200).optional(),

  planCode: z.string().trim().toLowerCase().default('starter'),
  expiresAt: z.coerce.date().nullable().optional(),

  defaultLocale: z.enum(LOCALES).default('bn'),
  enabledLocales: z.array(z.enum(LOCALES)).min(1).optional(),
  currency: z.enum(CURRENCIES).default('BDT'),
  timezone: z.string().trim().max(60).default('Asia/Dhaka'),

  contactEmail: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  contactPhone: z.string().trim().max(40).optional(),
  contactWhatsapp: z.string().trim().max(40).optional(),
  address: z.string().trim().max(400).optional(),
  city: z.string().trim().max(80).optional(),
  country: z.string().trim().max(4).optional(),

  template: z.string().trim().default('bd-dtc-v1'),
  notes: z.string().max(4000).optional(),
});

export const updateTenantSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  legalName: z.string().trim().max(200).optional(),
  productName: z.string().trim().max(160).optional(),
  industry: z.string().trim().max(80).optional(),
  logo: imageRefSchema.partial().optional(),
  favicon: imageRefSchema.partial().optional(),
  defaultLocale: z.enum(LOCALES).optional(),
  enabledLocales: z.array(z.enum(LOCALES)).min(1).optional(),
  currency: z.enum(CURRENCIES).optional(),
  timezone: z.string().trim().max(60).optional(),
  contact: z
    .object({
      email: z.string().trim().toLowerCase().optional(),
      phone: z.string().trim().max(40).optional(),
      whatsapp: z.string().trim().max(40).optional(),
      address: z.string().trim().max(400).optional(),
      city: z.string().trim().max(80).optional(),
      country: z.string().trim().max(4).optional(),
    })
    .optional(),
  flags: z
    .object({
      autoPublish: z.boolean().optional(),
      allowCustomDomain: z.boolean().optional(),
      whiteLabel: z.boolean().optional(),
      otpOnOrder: z.boolean().optional(),
    })
    .optional(),
  notes: z.string().max(4000).optional(),
});

/** Billing is manual: the platform owner sets the plan, status and expiry. */
export const updatePlanSchema = z.object({
  planCode: z.string().trim().toLowerCase().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  status: z.enum(TENANT_STATUSES).optional(),
  // Per-tenant overrides on top of the plan snapshot, for a negotiated deal.
  limits: z
    .object({
      landingPages: z.number().int().min(0).nullable().optional(),
      products: z.number().int().min(0).nullable().optional(),
      staffUsers: z.number().int().min(0).nullable().optional(),
      ordersPerMonth: z.number().int().min(0).nullable().optional(),
      customDomains: z.number().int().min(0).nullable().optional(),
      mediaMb: z.number().int().min(0).nullable().optional(),
    })
    .optional(),
});

export const suspendSchema = z.object({
  reason: z.string().trim().max(400).optional(),
});

export const listTenantsQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(120).optional(),
  status: z.enum(TENANT_STATUSES).optional(),
  plan: z.string().trim().optional(),
  sort: z.enum(['createdAt', '-createdAt', 'name', '-name']).optional(),
});

export const tenantIdParam = z.object({ tenantId: objectId });

export const themeSchema = z.object({
  primary: hex.optional(),
  accent: hex.optional(),
  cta: hex.optional(),
  ctaForeground: hex.optional(),
  background: hex.optional(),
  foreground: hex.optional(),
  radius: z.string().max(20).optional(),
  fontHeading: z.string().max(60).optional(),
  fontBody: z.string().max(60).optional(),
  preset: z.string().max(60).optional(),
});
