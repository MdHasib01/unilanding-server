import { Router } from 'express';
import { z } from 'zod';

import * as tc from '../controllers/platform/tenantController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireScope, authorize, requirePasswordChanged } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import {
  createTenantSchema,
  updateTenantSchema,
  updatePlanSchema,
  suspendSchema,
  listTenantsQuery,
  tenantIdParam,
  objectId,
} from '../schemas/tenant.js';
import { ORDER_STATUSES, TENANT_ROLES } from '../utils/constants.js';

const router = Router();

// Everything here is platform-staff-only, and nobody gets past a pending
// password change.
router.use(requireAuth, requireScope('platform'), requirePasswordChanged);

const OWNER_ADMIN = ['platform_owner', 'platform_admin'];

router.get('/overview', tc.overview);
router.get('/plans', tc.listPlans);

// ── tenants ──
router.get('/tenants', validate({ query: listTenantsQuery }), tc.listTenants);
router.post(
  '/tenants',
  authorize(...OWNER_ADMIN),
  validate({ body: createTenantSchema }),
  tc.postTenant
);
router.get('/tenants/:tenantId', validate({ params: tenantIdParam }), tc.getTenant);
router.patch(
  '/tenants/:tenantId',
  authorize(...OWNER_ADMIN),
  validate({ params: tenantIdParam, body: updateTenantSchema }),
  tc.patchTenant
);
router.patch(
  '/tenants/:tenantId/plan',
  authorize('platform_owner'),
  validate({ params: tenantIdParam, body: updatePlanSchema }),
  tc.patchPlan
);
router.post(
  '/tenants/:tenantId/suspend',
  authorize(...OWNER_ADMIN),
  validate({ params: tenantIdParam, body: suspendSchema }),
  tc.suspend
);
router.post(
  '/tenants/:tenantId/activate',
  authorize(...OWNER_ADMIN),
  validate({ params: tenantIdParam }),
  tc.activate
);
router.delete(
  '/tenants/:tenantId',
  authorize('platform_owner'),
  validate({ params: tenantIdParam }),
  tc.archive
);

// Support staff may impersonate too, but read-only is enforced in the tenant
// API by the `imp` claim rather than here.
router.post(
  '/tenants/:tenantId/impersonate',
  authorize(...OWNER_ADMIN, 'platform_support'),
  validate({ params: tenantIdParam }),
  tc.impersonate
);

// ── tenant users, managed from the platform ──
router.get(
  '/tenants/:tenantId/users',
  validate({ params: tenantIdParam }),
  tc.listTenantUsers
);
router.post(
  '/tenants/:tenantId/users',
  authorize(...OWNER_ADMIN),
  validate({
    params: tenantIdParam,
    body: z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().toLowerCase().email(),
      role: z.enum(TENANT_ROLES).default('tenant_staff'),
      password: z.string().min(10).max(200).optional(),
    }),
  }),
  tc.createTenantUser
);
router.post(
  '/tenants/:tenantId/users/:userId/reset-password',
  authorize(...OWNER_ADMIN),
  validate({ params: z.object({ tenantId: objectId, userId: objectId }) }),
  tc.resetTenantUserPassword
);

// ── platform-wide orders ──
router.get(
  '/orders',
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      tenantId: objectId.optional(),
      status: z.enum(ORDER_STATUSES).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  tc.listAllOrders
);

export default router;
