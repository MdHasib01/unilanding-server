import { z } from 'zod';
import { DOMAIN_STATUSES, DOMAIN_TYPES, SSL_STATUSES } from '../utils/constants.js';
import { objectId } from './tenant.js';

const page = z.coerce.number().int().min(1).optional();
const limit = z.coerce.number().int().min(1).max(100).optional();

// ── plans ──

const limit0 = z.coerce.number().int().min(0);

const planFields = {
  name: z.string().trim().min(1, 'A plan name is required').max(80),
  description: z.string().trim().max(400).default(''),
  price: z.coerce.number().min(0, 'Price cannot be negative'),
  currency: z.enum(['BDT', 'USD']).default('BDT'),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
  limits: z.object({
    landingPages: limit0,
    products: limit0,
    staffUsers: limit0,
    ordersPerMonth: limit0,
    customDomains: limit0,
    mediaMb: limit0,
  }),
  features: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  sortOrder: z.coerce.number().int().default(0),
  active: z.boolean().default(true),
  public: z.boolean().default(true),
};

export const createPlanSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, '3-40 characters: lowercase letters, numbers and hyphens'),
  ...planFields,
});

// The code is the join key into every tenant's plan snapshot, so it is fixed
// once created.
export const updatePlanCatalogSchema = z
  .object({
    ...planFields,
    limits: planFields.limits.partial(),
  })
  .partial();

export const planIdParam = z.object({ planId: objectId });

// ── domains ──

export const listDomainsQuery = z.object({
  page,
  limit,
  tenantId: objectId.optional(),
  status: z.enum(DOMAIN_STATUSES).optional(),
  type: z.enum(DOMAIN_TYPES).optional(),
  search: z.string().trim().max(120).optional(),
});

export const addDomainSchema = z.object({
  host: z.string().trim().min(3, 'Enter a domain such as example.com').max(253),
  makePrimary: z.boolean().default(false),
});

export const updateDomainSchema = z
  .object({
    isPrimary: z.literal(true).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    ssl: z
      .object({
        status: z.enum(SSL_STATUSES),
        provider: z.enum(['', 'vercel', 'caddy', 'cloudflare', 'manual']).optional(),
      })
      .optional(),
    redirectTo: z.string().trim().toLowerCase().max(253).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const domainIdParam = z.object({ domainId: objectId });

// ── audit ──

export const listAuditQuery = z.object({
  page,
  limit,
  tenantId: objectId.optional(),
  action: z.string().trim().max(80).optional(),
  actorEmail: z.string().trim().toLowerCase().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
