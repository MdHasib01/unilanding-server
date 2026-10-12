import { Router } from 'express';
import { z } from 'zod';

import * as pc from '../controllers/public/pageController.js';
import * as oc from '../controllers/public/orderController.js';
import { publicOrderLimiter } from '../middleware/rateLimit.js';
import { createOrderSchema, orderPublicIdParam } from '../schemas/order.js';
import { resolveTenant } from '../middleware/resolveTenant.js';
import { validate } from '../middleware/validate.js';
import { LOCALES } from '../utils/constants.js';

/**
 * The storefront API. No auth: these serve anonymous visitors.
 *
 * Every route resolves the tenant from the Host (a tenant domain or platform
 * subdomain), the X-Tenant-Slug header, or the :tenantSlug path param — in that
 * order of authority, per resolveTenant.
 */
const router = Router();

const slugParam = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(1).max(60),
});
const pageParam = slugParam.extend({
  pageSlug: z.string().trim().toLowerCase().max(80).optional(),
});
const localeQuery = z.object({ locale: z.enum(LOCALES).optional() });

router.get('/bootstrap/:tenantSlug', validate({ params: slugParam }), resolveTenant, pc.bootstrap);

// Preview is declared before the generic page route so "preview" is not
// swallowed as a pageSlug.
router.get(
  '/pages/:tenantSlug/preview',
  validate({ params: slugParam, query: z.object({ token: z.string().min(16) }) }),
  resolveTenant,
  pc.previewPage
);

router.get(
  '/pages/:tenantSlug',
  validate({ params: slugParam, query: localeQuery }),
  resolveTenant,
  pc.getPage
);
router.get(
  '/pages/:tenantSlug/:pageSlug',
  validate({ params: pageParam, query: localeQuery }),
  resolveTenant,
  pc.getPage
);

router.get('/products/:tenantSlug', validate({ params: slugParam }), resolveTenant, pc.listProducts);

// Orders. The tenant comes from the host or the X-Tenant-Slug header the order
// form sends (path mode runs on the platform host, so the host alone is not
// enough there). Rate-limited per subnet per tenant: there is no session here.
router.post(
  '/orders',
  resolveTenant,
  publicOrderLimiter,
  validate({ body: createOrderSchema }),
  oc.createOrder
);
router.get(
  '/orders/:publicId',
  validate({ params: orderPublicIdParam }),
  resolveTenant,
  oc.getOrderSummary
);

export default router;
