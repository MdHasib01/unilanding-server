import { Router } from 'express';
import { z } from 'zod';

import * as pc from '../controllers/tenant/pageController.js';
import * as mc from '../controllers/tenant/mediaController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { resolveTenant } from '../middleware/resolveTenant.js';
import { requireTenantMember, requirePasswordChanged } from '../middleware/authorize.js';
import { enforceLimit } from '../middleware/enforceLimit.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { saveDraftSchema } from '../schemas/page.js';
import { objectId } from '../schemas/tenant.js';

/**
 * The tenant admin API (/api/t/*).
 *
 * Order matters: requireAuth sets req.user, resolveTenant then prefers the
 * JWT's tenant over any header or host hint, and requireTenantMember is the
 * cross-check that makes a spoofed X-Tenant-Slug useless.
 */
const router = Router();

router.use(requireAuth, resolveTenant, requireTenantMember, requirePasswordChanged);

const pageIdParam = z.object({ pageId: objectId });

// ── landing page ──
router.get('/pages/home', pc.getHomePage);
router.put(
  '/pages/:pageId/draft',
  validate({ params: pageIdParam, body: saveDraftSchema }),
  pc.requireEditor,
  pc.saveDraft
);
router.post('/pages/:pageId/publish', validate({ params: pageIdParam }), pc.requireEditor, pc.publish);
router.post('/pages/:pageId/discard', validate({ params: pageIdParam }), pc.requireEditor, pc.discard);
router.get('/pages/:pageId/preview-token', validate({ params: pageIdParam }), pc.previewToken);

// ── media library ──
router.get('/media', mc.listMedia);
router.post(
  '/media',
  pc.requireEditor,
  uploadLimiter,
  enforceLimit('mediaMb'),
  mc.receiveImage,
  mc.uploadImage
);

export default router;
