import { z } from 'zod';
import { LOCALES, PAYMENT_METHODS } from '../utils/constants.js';
import { isValidBdPhone } from '../utils/phone.js';
import { objectId } from './tenant.js';

const str = (max) => z.string().trim().max(max);

const bdPhone = z
  .string()
  .trim()
  .max(20)
  .refine(isValidBdPhone, 'Enter a valid 11-digit Bangladeshi mobile number');

/**
 * The landing page order form's payload (sections/blocks/order-form.tsx).
 * No prices: whatever the browser shows, the server prices every line itself.
 */
export const createOrderSchema = z.object({
  landingPageId: objectId.optional(),
  customer: z.object({
    name: str(120).min(1, 'Name is required'),
    phone: bdPhone,
    altPhone: bdPhone.optional().or(z.literal('')),
    email: z.string().trim().toLowerCase().email().max(160).optional().or(z.literal('')),
  }),
  shipping: z.object({
    district: str(80).optional().default(''),
    thana: str(80).optional().default(''),
    address: str(500).min(1, 'Address is required'),
    note: str(500).optional().default(''),
  }),
  items: z
    .array(
      z.object({
        productId: objectId,
        variantId: objectId.optional().nullable(),
        qty: z.coerce.number().int().min(1).max(50),
      })
    )
    .min(1, 'Choose a product')
    .max(10),
  payment: z.object({
    method: z.enum(PAYMENT_METHODS),
    transactionId: str(60).optional().default(''),
  }),
  locale: z.enum(LOCALES).optional(),
  pageUrl: str(1000).optional(),
  marketing: z
    .object({
      fbp: str(200).optional(),
      fbc: str(200).optional(),
      attribution: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const orderPublicIdParam = z.object({
  publicId: z.string().regex(/^[A-Za-z0-9]{10,20}$/, 'Invalid order id'),
});
