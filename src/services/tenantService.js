import mongoose from 'mongoose';

import {
  Tenant,
  Domain,
  User,
  Plan,
  TenantSettings,
  scopedModels,
} from '../models/index.js';
import { SETTINGS_KEYS } from '../utils/constants.js';
import { assertUsableSlug } from '../utils/slug.js';
import { generatePassword } from '../utils/ids.js';
import { AppError, conflict, unprocessable } from '../utils/AppError.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createPageFromTemplate } from './pageService.js';
import { bustTenantCache } from '../middleware/resolveTenant.js';

/**
 * Creates a tenant and everything it needs to be immediately usable:
 * the tenant, its owner, its platform subdomain, its settings documents, a
 * published landing page and a starter product.
 *
 * Wrapped in a transaction so a half-created tenant is impossible — a tenant
 * without an owner, or with a slug taken but no page, would need manual repair.
 * (Atlas replica sets support transactions; a standalone mongod would not.)
 *
 * The welcome email is sent AFTER the commit, never inside it: an SMTP timeout
 * must not roll back a successful creation.
 */
export async function createTenant(input, { actor = null } = {}) {
  const slugError = assertUsableSlug(input.slug);
  if (slugError) throw unprocessable(slugError, 'INVALID_SLUG');

  const existing = await Tenant.findOne({ slug: input.slug }).setOptions({ withDeleted: true });
  if (existing) {
    throw conflict(`The slug "${input.slug}" is already taken`, 'SLUG_TAKEN');
  }

  const planDoc = await Plan.findOne({ code: input.planCode || 'starter', active: true });
  if (!planDoc) throw unprocessable('Unknown plan', 'UNKNOWN_PLAN');

  const ownerEmail = String(input.ownerEmail).toLowerCase().trim();
  const password = input.ownerPassword || generatePassword();
  const passwordHash = await User.hashPassword(password);
  const defaultLocale = input.defaultLocale || 'bn';

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const [tenant] = await Tenant.create(
        [
          {
            slug: input.slug,
            name: input.name,
            legalName: input.legalName || '',
            productName: input.productName || '',
            industry: input.industry || '',
            logo: input.logo || {},
            status: 'active',
            defaultLocale,
            enabledLocales: input.enabledLocales?.length ? input.enabledLocales : [defaultLocale],
            currency: input.currency || 'BDT',
            timezone: input.timezone || 'Asia/Dhaka',
            contact: {
              email: input.contactEmail || ownerEmail,
              phone: input.contactPhone || '',
              whatsapp: input.contactWhatsapp || '',
              address: input.address || '',
              city: input.city || '',
              country: input.country || 'BD',
            },
            plan: planDoc.toSnapshot(),
            expiresAt: input.expiresAt || null,
            notes: input.notes || '',
            onboarding: { step: 'created' },
          },
        ],
        { session }
      );

      const [owner] = await User.create(
        [
          {
            tenantId: tenant._id,
            scope: 'tenant',
            role: 'tenant_owner',
            name: input.ownerName || input.name,
            email: ownerEmail,
            passwordHash,
            phone: input.contactPhone || '',
            locale: defaultLocale,
            // Forced unless the operator chose the password deliberately.
            mustChangePassword: !input.ownerPassword,
            active: true,
            invitedBy: actor?._id || null,
          },
        ],
        { session }
      );

      // The platform subdomain is covered by the wildcard certificate, so it is
      // active immediately and needs no DNS verification.
      const [domain] = await Domain.create(
        [
          {
            host: `${input.slug}.${env.PLATFORM_HOST.split(':')[0]}`.toLowerCase(),
            tenantId: tenant._id,
            type: 'platform_subdomain',
            isPrimary: true,
            status: 'active',
            verification: { method: 'none', verifiedAt: new Date() },
            ssl: { status: 'issued', provider: 'manual', issuedAt: new Date() },
            addedBy: actor?._id || null,
            activatedAt: new Date(),
          },
        ],
        { session }
      );

      tenant.ownerUserId = owner._id;
      tenant.primaryDomainId = domain._id;
      await tenant.save({ session });

      // One settings document per section, seeded empty — TenantSettings.get()
      // applies defaults on read, so adding a setting later needs no migration.
      // ordered: true is required by Mongoose for a multi-document create()
      // inside a session.
      await TenantSettings.create(
        SETTINGS_KEYS.map((key) => ({ tenantId: tenant._id, key, values: {} })),
        { session, ordered: true }
      );

      result = { tenant, owner, domain, password: input.ownerPassword ? null : password };
    });
  } finally {
    await session.endSession();
  }

  // ── Post-commit: the page and starter product. ──
  // Deliberately outside the transaction. createPageFromTemplate reads the
  // template file from disk, and a slow read inside a transaction holds locks;
  // if either fails the tenant still exists and is repairable from the UI.
  const db = scopedModels(result.tenant._id);
  try {
    const page = await createPageFromTemplate({
      db,
      tenant: result.tenant,
      name: result.tenant.name,
      slug: '',
      isHome: true,
      templateId: input.template || 'bd-dtc-v1',
      publish: true,
      createdBy: result.owner._id,
    });
    result.page = page;

    if (input.productName) {
      result.product = await db.Product.create({
        name: input.productName,
        basePrice: Number(input.productPrice) || 0,
        offerPrice: input.productOfferPrice ? Number(input.productOfferPrice) : null,
        active: true,
        sortOrder: 0,
      });
    }

    await Tenant.findByIdAndUpdate(result.tenant._id, {
      $set: { 'onboarding.step': 'page_built' },
    });
  } catch (err) {
    logger.error(
      { tenantId: String(result.tenant._id), err: { message: err.message } },
      'tenant created but initial page/product failed — repairable from the dashboard'
    );
    result.pageError = err.message;
  }

  bustTenantCache(result.tenant.slug);
  return result;
}

/** Both URLs a tenant owner can use, for the welcome email. */
export function adminUrlsFor(tenant, primaryHost) {
  const scheme = env.COOKIE_SECURE ? 'https' : 'http';
  return [
    `${scheme}://${primaryHost}/admin`,
    `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/${tenant.slug}/admin`,
  ];
}

export async function suspendTenant(tenantId, reason, actor) {
  const tenant = await Tenant.findByIdAndUpdate(
    tenantId,
    { $set: { status: 'suspended', suspendedReason: reason || '' } },
    { new: true }
  );
  if (!tenant) throw new AppError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  bustTenantCache(tenant.slug);
  logger.warn({ tenantId: String(tenantId), actor: actor?.email }, 'tenant suspended');
  return tenant;
}

export async function activateTenant(tenantId) {
  const tenant = await Tenant.findByIdAndUpdate(
    tenantId,
    { $set: { status: 'active', suspendedReason: '' } },
    { new: true }
  );
  if (!tenant) throw new AppError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  bustTenantCache(tenant.slug);
  return tenant;
}

/**
 * Soft delete. The slug stays reserved so a half-remembered URL cannot be
 * claimed by someone else and silently serve a different business.
 */
export async function archiveTenant(tenantId) {
  const tenant = await Tenant.findByIdAndUpdate(
    tenantId,
    { $set: { status: 'archived', deletedAt: new Date() } },
    { new: true }
  );
  if (!tenant) throw new AppError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  // Sessions for this tenant's users stop working immediately.
  await User.updateMany({ tenantId }, { $inc: { tokenVersion: 1 }, $set: { active: false } });
  bustTenantCache(tenant.slug);
  return tenant;
}
