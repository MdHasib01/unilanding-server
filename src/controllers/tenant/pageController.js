import { TenantSettings, User } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok } from '../../utils/respond.js';
import { notFoundError, forbidden, unprocessable } from '../../utils/AppError.js';
import { signHandoff } from '../../services/cryptoService.js';
import { publishPage, discardDraft } from '../../services/pageService.js';
import { audit } from '../../services/auditService.js';
import { sanitiseSectionData, UnsafeContentError } from '../../schemas/page.js';
import {
  publicSettings,
  serialiseProduct,
  resolvePrimaryHost,
} from '../public/pageController.js';

const EDITOR_ROLES = new Set(['tenant_owner', 'tenant_admin']);
const IMPERSONATOR_EDIT_ROLES = new Set(['platform_owner', 'platform_admin']);

/**
 * Whether this session may change the page.
 *
 * Staff are read-only, like the reference's "Moderator (View-Only)". A platform
 * user impersonating the tenant inherits the owner's role in the token, so the
 * `imp` claim is checked separately: owners and admins may build a client's
 * page for them, support staff may only look.
 */
async function resolveCanEdit(req) {
  if (!EDITOR_ROLES.has(req.user.role)) return false;
  if (!req.impersonatedBy) return true;
  const impersonator = await User.findById(req.impersonatedBy).select('role');
  return Boolean(impersonator && IMPERSONATOR_EDIT_ROLES.has(impersonator.role));
}

export const requireEditor = asyncHandler(async (req, _res, next) => {
  if (!(await resolveCanEdit(req))) {
    throw forbidden('Your account can view this page but not change it', 'READ_ONLY');
  }
  next();
});

const slot = (src = {}) => ({
  brand: src.brand ?? {},
  theme: src.theme ?? {},
  seo: src.seo ?? {},
  sections: (src.sections ?? [])
    .map((s) => ({ key: s.key, type: s.type, order: s.order, enabled: s.enabled !== false, data: s.data ?? {} }))
    .sort((a, b) => a.order - b.order),
});

const serialisePage = (page) => ({
  id: page._id,
  name: page.name,
  slug: page.slug,
  isHome: page.isHome,
  template: page.template,
  status: page.status,
  revision: page.revision,
  publishedAt: page.publishedAt,
  dirty: Boolean(page.draft?.dirty),
  draftUpdatedAt: page.draft?.updatedAt ?? null,
  draft: slot(page.draft),
  live: slot(page),
});

/** Everything the customization editor needs, in one call. */
export const getHomePage = asyncHandler(async (req, res) => {
  const page = await req.db.LandingPage.findOne({ isHome: true });
  if (!page) throw notFoundError('This site has no home page yet', 'PAGE_NOT_FOUND');

  const [products, all, primaryHost, canEdit] = await Promise.all([
    req.db.Product.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 }),
    TenantSettings.getAll(req.tenant._id),
    resolvePrimaryHost(req.tenant),
    resolveCanEdit(req),
  ]);

  res.set('Cache-Control', 'no-store');
  return ok(res, {
    page: serialisePage(page),
    tenant: req.tenant.toPublicJSON(),
    primaryHost,
    products: products.map(serialiseProduct),
    settings: publicSettings(all),
    canEdit,
  });
});

/**
 * Writes the DRAFT only. Live is untouched until Publish, so a half-finished
 * edit can never reach a visitor.
 */
export const saveDraft = asyncHandler(async (req, res) => {
  const page = await req.db.LandingPage.findById(req.params.pageId);
  if (!page) throw notFoundError('Page not found', 'PAGE_NOT_FOUND');

  const { brand, theme, seo, sections } = req.body;

  let cleanSections;
  if (sections) {
    try {
      cleanSections = sections.map((s, i) => ({
        ...s,
        data: sanitiseSectionData(s.data, `sections[${i}].data`),
      }));
    } catch (err) {
      if (err instanceof UnsafeContentError) {
        throw unprocessable(err.message, 'UNSAFE_CONTENT', [{ path: err.path, message: err.message }]);
      }
      throw err;
    }
  }

  if (brand) page.draft.brand = { ...(page.draft.brand?.toObject?.() ?? {}), ...brand };
  if (theme) page.draft.theme = { ...(page.draft.theme?.toObject?.() ?? {}), ...theme };
  if (seo) page.draft.seo = { ...(page.draft.seo?.toObject?.() ?? {}), ...seo };
  if (cleanSections) {
    page.draft.sections = cleanSections;
    // section.data is Mixed; tell Mongoose the nested blobs changed.
    page.markModified('draft.sections');
  }
  page.draft.dirty = true;
  page.draft.updatedAt = new Date();
  page.draft.updatedBy = req.user._id;
  await page.save();

  audit(req, { action: 'page.draft.save', targetType: 'LandingPage', targetId: page._id });
  return ok(res, { page: serialisePage(page) });
});

export const publish = asyncHandler(async (req, res) => {
  const page = await publishPage({
    db: req.db,
    pageId: req.params.pageId,
    userId: req.user._id,
    tenantSlug: req.tenant.slug,
  });
  audit(req, {
    action: 'page.publish',
    targetType: 'LandingPage',
    targetId: page._id,
    diff: { revision: page.revision },
  });
  return ok(res, { page: serialisePage(page) });
});

export const discard = asyncHandler(async (req, res) => {
  const page = await discardDraft({ db: req.db, pageId: req.params.pageId, userId: req.user._id });
  audit(req, { action: 'page.draft.discard', targetType: 'LandingPage', targetId: page._id });
  return ok(res, { page: serialisePage(page) });
});

/**
 * A signed, 30-minute link that renders the DRAFT on the real URL, so the
 * tenant can show a client an unpublished change.
 */
export const previewToken = asyncHandler(async (req, res) => {
  const page = await req.db.LandingPage.findById(req.params.pageId).select('_id slug');
  if (!page) throw notFoundError('Page not found', 'PAGE_NOT_FOUND');
  const token = signHandoff({ pageId: String(page._id), tid: String(req.tenantId) }, 30 * 60);
  return ok(res, { token, expiresInSeconds: 30 * 60 });
});
