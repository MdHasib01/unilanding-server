import { Router } from 'express';

import * as auth from '../controllers/authController.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import {
  loginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  exchangeSchema,
  updateProfileSchema,
} from '../schemas/auth.js';

const router = Router();

// Public. The login endpoint infers platform vs tenant from the Host or an
// explicit tenantSlug, so one route serves both audiences.
router.post('/login', loginLimiter, validate({ body: loginSchema }), auth.login);
router.post(
  '/forgot-password',
  loginLimiter,
  validate({ body: forgotPasswordSchema }),
  auth.forgotPassword
);
router.post('/reset-password', loginLimiter, validate({ body: resetPasswordSchema }), auth.resetPassword);
router.post('/exchange', loginLimiter, validate({ body: exchangeSchema }), auth.exchange);

// Logout works with or without a valid session, so it can always clear cookies.
router.post('/logout', auth.logout);

// Authenticated. Deliberately NOT behind requirePasswordChanged — these are the
// endpoints a user needs in order to get out of that state.
router.get('/me', requireAuth, auth.me);
router.post(
  '/change-password',
  requireAuth,
  validate({ body: changePasswordSchema }),
  auth.changePassword
);
router.patch('/profile', requireAuth, validate({ body: updateProfileSchema }), auth.updateProfile);

export default router;
