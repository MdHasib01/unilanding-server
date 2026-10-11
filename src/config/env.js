import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Env is parsed once, at boot, and the process refuses to start on a bad
 * config. A multi-tenant server that boots with a missing JWT_SECRET or
 * SETTINGS_ENC_KEY fails later, in production, on a request that matters.
 */
const csv = () =>
  z
    .string()
    .default('')
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  // Hosts
  PLATFORM_HOST: z.string().min(1, 'PLATFORM_HOST is required (e.g. unilanding.local:3000)'),
  PUBLIC_BASE_URL: z.string().url().default('http://unilanding.local:3000'),
  TRUST_PROXY: z.string().default('1'),
  CORS_ORIGINS: csv(),

  // Data
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  // Auth / crypto
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // 32 raw bytes, base64-encoded, for AES-256-GCM of tenant integration secrets.
  SETTINGS_ENC_KEY: z
    .string()
    .min(1, 'SETTINGS_ENC_KEY is required')
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'SETTINGS_ENC_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  INTERNAL_API_KEY: z.string().min(16, 'INTERNAL_API_KEY must be at least 16 characters'),

  // Cloudinary (optional at boot; uploads fail with a clear error when unset)
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CLOUDINARY_ROOT_FOLDER: z.string().default('unilanding'),

  // SMTP (optional at boot; email degrades to a logged no-op)
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  EMAIL_FROM: z.string().default(''),

  // Integration defaults (per-tenant values in TenantSettings take precedence)
  BD_SMS_API_URL: z.string().default('https://api.bdbulksms.net/api.php'),
  STEADFAST_BASE_URL: z.string().default('https://portal.packzy.com/api/v1'),
  META_GRAPH_API_VERSION: z.string().default('v21.0'),

  // Seed
  SEED_OWNER_NAME: z.string().default('Platform Owner'),
  SEED_OWNER_EMAIL: z.string().email().default('owner@unilanding.com'),
  SEED_OWNER_PASSWORD: z.string().default(''),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`[env] Invalid environment configuration:\n${lines.join('\n')}`);
  console.error('[env] See server/.env.example for the full list.');
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

/** Hostname only, no port — for comparing against a request Host header. */
export const PLATFORM_HOSTNAME = env.PLATFORM_HOST.split(':')[0].toLowerCase();
