export const LOCALES = ['bn', 'en'];
export const DEFAULT_LOCALE = 'bn';

export const TENANT_STATUSES = ['pending', 'active', 'suspended', 'archived'];

export const USER_SCOPES = ['platform', 'tenant'];
export const PLATFORM_ROLES = ['platform_owner', 'platform_admin', 'platform_support'];
export const TENANT_ROLES = ['tenant_owner', 'tenant_admin', 'tenant_staff'];
export const ALL_ROLES = [...PLATFORM_ROLES, ...TENANT_ROLES];

export const DOMAIN_TYPES = ['platform_subdomain', 'custom_apex', 'custom_subdomain'];
export const DOMAIN_STATUSES = ['pending', 'verifying', 'active', 'error', 'disabled'];
export const SSL_STATUSES = ['none', 'pending', 'issued', 'error'];

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'returned',
  'cancelled',
];
export const PAYMENT_METHODS = [
  'cod',
  'manual_bkash',
  'manual_nagad',
  'manual_rocket',
  'bank_transfer',
];
export const PAYMENT_STATUSES = ['due', 'paid', 'partial', 'refunded'];
export const ORDER_SOURCES = ['web', 'admin', 'api'];

export const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost', 'spam'];

export const SETTINGS_KEYS = [
  'general',
  'orders',
  'courier',
  'sms',
  'email',
  'payments',
  'tracking',
  'invoice',
  'notifications',
];

/**
 * Paths inside TenantSettings.values that hold credentials. Encrypted at rest,
 * masked on read, and redacted from audit diffs.
 */
export const SECRET_PATHS = {
  courier: ['apiKey', 'secretKey'],
  sms: ['token', 'apiKey'],
  email: ['smtpPass'],
  payments: ['bkash.secret', 'nagad.secret'],
  tracking: ['metaCapiToken'],
};

export const CURRENCIES = ['BDT', 'USD'];
