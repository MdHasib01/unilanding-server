import { z } from 'zod';
import { LOCALES } from '../utils/constants.js';

export const email = z.string().trim().toLowerCase().email('A valid email address is required');

/**
 * Minimum 10 characters rather than the usual 8, and no composition rules.
 * Length beats character classes, and the provisioning flow generates
 * 16-character passwords anyway.
 */
export const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
  // Lets the client disambiguate when one host serves both the platform and a
  // path-mode tenant admin. The server still verifies the tenant exists.
  tenantSlug: z.string().trim().toLowerCase().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Your current password is required'),
  newPassword: password,
});

export const forgotPasswordSchema = z.object({
  email,
  tenantSlug: z.string().trim().toLowerCase().optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(16, 'Invalid reset token'),
  newPassword: password,
});

export const exchangeSchema = z.object({
  token: z.string().min(16, 'Invalid handoff token'),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  locale: z.enum(LOCALES).optional(),
});
