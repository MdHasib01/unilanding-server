import { Domain, TenantSettings } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok } from '../../utils/respond.js';
import { notFoundError, forbidden } from '../../utils/AppError.js';
import { verifyHandoff } from '../../services/cryptoService.js';
import { PLATFORM_HOSTNAME } from '../../config/env.js';
import { LOCALES } from '../../utils/constants.js';

/** Only the fields a public page may see. Never ship a whole settings doc. */
function publicSettings(all) {
  return {
    general: {
      supportPhone: all.general?.supportPhone || '',
      supportEmail: all.general?.supportEmail || '',
      whatsapp: all.general?.whatsapp || '',
      businessHours: all.general?.businessHours || '',
    },
    orders: {
      deliveryCharges: all.orders?.deliveryCharges || { inside: 0, outside: 0, freeAbove: null },
      requireDistrict: all.orders?.requireDistrict ?? true,
      requireThana: all.orders?.requireThana ?? false,
      allowAltPhone: all.orders?.allowAltPhone ?? false,
      requireEmail: all.orders?.requireEmail ?? false,
      locations: all.orders?.locations || [],
    },
    payments: {
      // Credentials are never in this subtree; these are display-only.
      cod: { enabled: all.payments?.cod?.enabled ?? true, label: all.payments?.cod?.label || '' },
      manualBkash: {
        enabled: all.payments?.manualBkash?.enabled ?? false,
        number: all.payments?.manualBkash?.number || '',
        instructions: all.payments?.manualBkash?.instructions || '',
      },
      manualNagad: {
        enabled: all.payments?.manualNagad?.enabled ?? false,
        number: all.payments?.manualNagad?.number || '',
        instructions: all.payments?.manualNagad?.instructions || '',
      },
      manualRocket: {
        enabled: all.payments?.manualRocket?.enabled ?? false,
        number: all.payments?.manualRocket?.number || '',
        instructions: all.payments?.manualRocket?.instructions || '',
      },
      bankTransfer: {
        enabled: all.payments?.bankTransfer?.enabled ?? false,
        details: all.payments?.bankTransfer?.details || '',
      },
    },
    otpOnOrder: all.sms?.otpOnOrder ?? false,
  };
}

/**
 * Tracking IDs that belong in the browser. metaCapiToken is deliberately NOT
 * here — it is a server-side credential and must never reach a page.
 */
function publicTracking(tracking = {}) {
  return {
    metaPixelId: tracking.metaPixelId || '',
    gtmId: tracking.gtmId || '',
    ga4Id: tracking.ga4Id || '',
    tiktokPixelId: tracking.tiktokPixelId || '',
    clarityId: tracking.clarityId || '',
  };
}

const serialiseProduct = (p) => ({
  id: p._id,
  name: p.name,
  nameEn: p.nameEn,
  slug: p.slug,
  sku: p.sku,
  description: p.description,
  image: p.image,
  gallery: p.gallery,
  basePrice: p.basePrice,
  offerPrice: p.offerPrice,
  weight: p.weight,
  unit: p.unit,
  tag: p.tag,
  sortOrder: p.sortOrder,
  variants: (p.variants || [])
    .filter((v) => v.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((v) => ({
      id: v._id,
      name: v.name,
      nameEn: v.nameEn,
      sku: v.sku,
      price: v.price,
      offerPrice: v.offerPrice,
      weight: v.weight,
      image: v.image,
    })),
});

async function resolvePrimaryHost(tenant) {
  if (tenant.primaryDomainId) {
    const d = await Domain.findById(tenant.primaryDomainId);
    if (d?.host) return d.host;
  }
  return `${tenant.slug}.${PLATFORM_HOSTNAME}`;
}

/**
 * Everything the tenant layout needs in one call: brand, locale, public
 * settings and the primary host used for canonical URLs.
 */
export const bootstrap = asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  const all = await TenantSettings.getAll(tenant._id);

  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');

  return ok(res, {
    tenant: tenant.toPublicJSON(),
    primaryHost: await resolvePrimaryHost(tenant),
    settings: publicSettings(all),
  });
});

/**
 * The published page for a tenant. `pageSlug` empty means the home page.
 *
 * Returns the LIVE slot only. Drafts are reachained through /preview with a
 * signed token, so an unpublished edit can never leak to a visitor.
 */
export const getPage = asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  if (!tenant.isLive()) {
    throw forbidden('This page is unavailable', 'TENANT_NOT_LIVE');
  }

  const slug = (req.params.pageSlug || '').toLowerCase();
  const page = slug
    ? await req.db.LandingPage.findOne({ slug, status: 'published' })
    : await req.db.LandingPage.findOne({ isHome: true, status: 'published' });

  if (!page) throw notFoundError('Page not found', 'PAGE_NOT_FOUND');

  const products = await req.db.Product.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 });
  const all = await TenantSettings.getAll(tenant._id);

  const requested = String(req.query.locale || '');
  const locale =
    LOCALES.includes(requested) && tenant.enabledLocales.includes(requested)
      ? requested
      : tenant.defaultLocale;

  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');

  return ok(res, {
    tenant: tenant.toPublicJSON(),
    primaryHost: await resolvePrimaryHost(tenant),
    locale,
    page: {
      id: page._id,
      name: page.name,
      slug: page.slug,
      isHome: page.isHome,
      template: page.template,
      revision: page.revision,
      publishedAt: page.publishedAt,
      brand: page.brand,
      seo: page.seo,
      theme: page.theme,
      tracking: publicTracking(page.tracking),
      sections: page.sections
        .filter((s) => s.enabled)
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ key: s.key, type: s.type, order: s.order, data: s.data })),
    },
    products: products.map(serialiseProduct),
    settings: publicSettings(all),
  });
});

/**
 * Renders the DRAFT on the real URL, behind a signed short-lived token, so a
 * tenant can show a client an unpublished change without publishing it.
 */
export const previewPage = asyncHandler(async (req, res) => {
  const payload = verifyHandoff(req.query.token);
  if (!payload?.pageId || String(payload.tid) !== String(req.tenantId)) {
    throw forbidden('This preview link has expired', 'PREVIEW_INVALID');
  }

  const page = await req.db.LandingPage.findById(payload.pageId);
  if (!page) throw notFoundError('Page not found', 'PAGE_NOT_FOUND');

  const products = await req.db.Product.find({ active: true }).sort({ sortOrder: 1 });
  const all = await TenantSettings.getAll(req.tenant._id);
  const draft = page.draft || {};

  // A preview must never be cached or indexed.
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');

  return ok(res, {
    tenant: req.tenant.toPublicJSON(),
    primaryHost: await resolvePrimaryHost(req.tenant),
    locale: req.tenant.defaultLocale,
    preview: true,
    page: {
      id: page._id,
      name: page.name,
      slug: page.slug,
      brand: draft.brand || page.brand,
      seo: { ...(draft.seo || {}), noindex: true },
      theme: draft.theme || page.theme,
      tracking: {},
      sections: (draft.sections || [])
        .filter((s) => s.enabled)
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ key: s.key, type: s.type, order: s.order, data: s.data })),
    },
    products: products.map(serialiseProduct),
    settings: publicSettings(all),
  });
});

export const listProducts = asyncHandler(async (req, res) => {
  const products = await req.db.Product.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 });
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  return ok(res, products.map(serialiseProduct));
});

export { publicSettings, publicTracking, serialiseProduct, resolvePrimaryHost };
