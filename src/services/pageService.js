import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LandingPage, LandingPageRevision } from '../models/index.js';
import { sectionKey } from '../utils/ids.js';
import { AppError, notFoundError } from '../utils/AppError.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { safeAsync } from '../utils/safeAsync.js';

const here = dirname(fileURLToPath(import.meta.url));
let templateCache = null;

export async function getTemplates() {
  if (!templateCache) {
    templateCache = JSON.parse(
      await readFile(join(here, '..', 'seed', 'data', 'templates.json'), 'utf8')
    );
  }
  return templateCache;
}

/**
 * A template contributes only the section LIST — type, order, enabled — with
 * empty data. The per-section default copy lives in the client's section
 * registry, and every renderer and editor form merges
 * `{ ...meta.defaults(), ...section.data }`.
 *
 * That keeps one source of truth for default content instead of duplicating
 * all of it server-side, and means adding a field to a section does not need a
 * data migration for existing pages.
 */
export async function buildSectionsFromTemplate(templateId = 'bd-dtc-v1') {
  const templates = await getTemplates();
  const template = templates[templateId];
  if (!template) throw new AppError(`Unknown template: ${templateId}`, 422, 'UNKNOWN_TEMPLATE');

  return template.sections.map((s) => ({
    key: sectionKey(),
    type: s.type,
    order: s.order,
    enabled: s.enabled !== false,
    data: {},
  }));
}

const DEFAULT_THEME = {
  primary: '#bd0052',
  accent: '#e37a69',
  cta: '#ffd666',
  ctaForeground: '#3a2600',
  background: '#fff9f6',
  foreground: '#111827',
  radius: '1rem',
  fontHeading: 'hind-siliguri',
  fontBody: 'hind-siliguri',
};

/**
 * Creates a page with live AND draft populated, and published, so a brand new
 * tenant's URL works the instant the tenant exists rather than 404ing until
 * someone opens the editor.
 */
export async function createPageFromTemplate({
  db,
  tenant,
  name,
  slug = '',
  isHome = false,
  templateId = 'bd-dtc-v1',
  publish = true,
  createdBy = null,
}) {
  const sections = await buildSectionsFromTemplate(templateId);

  const content = {
    seo: {
      title: { [tenant.defaultLocale]: tenant.name },
      description: {},
      keywords: [],
      noindex: false,
    },
    theme: { ...DEFAULT_THEME },
    tracking: {},
    sections,
  };

  const page = await db.LandingPage.create({
    name,
    slug,
    isHome,
    template: templateId,
    status: publish ? 'published' : 'draft',
    publishedAt: publish ? new Date() : null,
    publishedBy: publish ? createdBy : null,
    revision: publish ? 1 : 0,
    ...content,
    draft: { ...content, updatedAt: new Date(), updatedBy: createdBy, dirty: false },
  });

  return page;
}

/** Copies draft over live, snapshots the result, and bumps the revision. */
export async function publishPage({ db, pageId, userId, tenantSlug }) {
  const page = await db.LandingPage.findById(pageId);
  if (!page) throw notFoundError('Page not found', 'PAGE_NOT_FOUND');

  const draft = page.draft || {};
  page.seo = draft.seo ?? page.seo;
  page.theme = draft.theme ?? page.theme;
  page.tracking = draft.tracking ?? page.tracking;
  page.sections = draft.sections ?? page.sections;
  page.status = 'published';
  page.publishedAt = new Date();
  page.publishedBy = userId ?? null;
  page.revision = (page.revision ?? 0) + 1;
  page.draft.dirty = false;
  await page.save();

  await db.LandingPageRevision.create({
    pageId: page._id,
    revision: page.revision,
    snapshot: {
      seo: page.seo,
      theme: page.theme,
      tracking: page.tracking,
      sections: page.sections,
    },
    createdBy: userId ?? null,
  });

  await pruneRevisions(db, page._id);

  if (tenantSlug) pingRevalidate({ slug: tenantSlug, pageSlug: page.slug });

  return page;
}

/**
 * Tells the Next app to drop its cached copy of this page.
 *
 * Fire-and-forget: a tenant's publish must succeed even if the web tier is
 * momentarily unreachable — the cache would then expire on its own within 30s.
 */
export function pingRevalidate({ slug, pageSlug = '', host }) {
  return safeAsync(
    async () => {
      const res = await fetch(`${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/ul/revalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': env.INTERNAL_API_KEY },
        body: JSON.stringify({ slug, pageSlug, host }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`revalidate returned ${res.status}`);
      return true;
    },
    { kind: 'revalidate', slug }
  );
}

/** Keeps the newest 20 revisions per page; history is a safety net, not an archive. */
const KEEP_REVISIONS = 20;

export async function pruneRevisions(db, pageId) {
  const stale = await db.LandingPageRevision.find({ pageId })
    .sort({ revision: -1 })
    .skip(KEEP_REVISIONS)
    .select('_id');
  if (stale.length === 0) return 0;
  await db.LandingPageRevision.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
  return stale.length;
}

export async function restoreRevision({ db, pageId, revision, userId }) {
  const [page, snap] = await Promise.all([
    db.LandingPage.findById(pageId),
    db.LandingPageRevision.findOne({ pageId, revision }),
  ]);
  if (!page) throw notFoundError('Page not found', 'PAGE_NOT_FOUND');
  if (!snap) throw notFoundError('Revision not found', 'REVISION_NOT_FOUND');

  // A restore lands in the DRAFT, so it can be reviewed before going live.
  page.draft = {
    ...snap.snapshot,
    updatedAt: new Date(),
    updatedBy: userId ?? null,
    dirty: true,
  };
  await page.save();
  logger.info({ pageId: String(pageId), revision }, 'revision restored into draft');
  return page;
}

export { DEFAULT_THEME };
