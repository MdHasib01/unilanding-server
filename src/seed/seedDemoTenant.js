/**
 * Creates the `milkready` demo tenant: a MilkReady storefront with its product, an owner
 * login and a published home page built from the bd-dtc-v1 template.
 *
 * ("demo" itself is a reserved slug.) Idempotent. An existing demo tenant is left alone unless --reset-page is
 * passed, which rebuilds its home page from the template (draft and live).
 *
 * Run after `npm run seed` (plans must exist):
 *   npm run seed:demo
 *   npm run seed:demo -- --reset-page
 *
 * DEMO_OWNER_PASSWORD in .env fixes the owner's password; otherwise one is
 * generated, printed once, and must be changed at first sign-in.
 */
import { connectDB, disconnectDB } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Tenant, TenantSettings, scopedModels } from '../models/index.js';
import { createTenant } from '../services/tenantService.js';
import { createPageFromTemplate } from '../services/pageService.js';

const SLUG = process.env.DEMO_SLUG || 'milkready';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL || 'owner@milkready.local';
const resetPage = process.argv.includes('--reset-page');

async function ensurePayments(tenantId) {
  // MilkReady takes cash on delivery and manual bKash. A placeholder bKash
  // number makes the payment box visible; the tenant replaces it in settings.
  const existing = await TenantSettings.findOne({ tenantId, key: 'payments' });
  if (existing && Object.keys(existing.values || {}).length) return false;
  await TenantSettings.updateOne(
    { tenantId, key: 'payments' },
    {
      $set: {
        values: {
          cod: { enabled: true, label: '' },
          manualBkash: {
            enabled: true,
            number: '01XXXXXXXXX',
            instructions: 'Send Money করে TrxID নিচে লিখুন',
          },
        },
      },
    },
    { upsert: true }
  );
  return true;
}

async function ensureOrderSettings(tenantId) {
  // The MilkReady form asks only for name, phone and a full address — no
  // district picker — and delivery is free.
  const existing = await TenantSettings.findOne({ tenantId, key: 'orders' });
  if (existing && Object.keys(existing.values || {}).length) return false;
  await TenantSettings.updateOne(
    { tenantId, key: 'orders' },
    {
      $set: {
        values: {
          requireDistrict: false,
          deliveryCharges: { inside: 0, outside: 0, freeAbove: null, insideLabel: 'Dhaka' },
        },
      },
    },
    { upsert: true }
  );
  return true;
}

async function main() {
  await connectDB();

  let tenant = await Tenant.findOne({ slug: SLUG });
  let password = null;
  let createdNow = false;

  if (!tenant) {
    const result = await createTenant({
      slug: SLUG,
      name: 'MilkReady',
      productName: 'MilkReady™ Prenatal Dose',
      productPrice: 5650,
      productOfferPrice: 3399,
      ownerName: 'Demo Owner',
      ownerEmail: OWNER_EMAIL,
      ownerPassword: process.env.DEMO_OWNER_PASSWORD || undefined,
      planCode: 'business',
      defaultLocale: 'bn',
      enabledLocales: ['bn'],
      contactPhone: '01517-102603',
      template: 'bd-dtc-v1',
    });
    tenant = result.tenant;
    password = result.password;
    createdNow = true;
  } else if (resetPage) {
    const db = scopedModels(tenant._id);
    await db.LandingPage.deleteMany({ isHome: true });
    await createPageFromTemplate({
      db,
      tenant,
      name: tenant.name,
      isHome: true,
      templateId: 'bd-dtc-v1',
      publish: true,
    });
  }

  const paymentsSet = await ensurePayments(tenant._id);
  const ordersSet = await ensureOrderSettings(tenant._id);

  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  console.log(`\n${'='.repeat(62)}`);
  console.log('  Demo tenant');
  console.log('='.repeat(62));
  console.log(`  Tenant           ${tenant.name} (/${tenant.slug}) ${createdNow ? 'created' : 'already existed'}`);
  if (resetPage && !createdNow) console.log('  Home page        rebuilt from bd-dtc-v1');
  if (paymentsSet) console.log('  Payments         COD + manual bKash enabled');
  if (ordersSet) console.log('  Orders           no district step, free delivery');
  console.log(`  Landing page     ${base}/${tenant.slug}`);
  console.log(`  Admin            ${base}/${tenant.slug}/admin`);
  console.log(`  Owner            ${OWNER_EMAIL}`);
  if (password) {
    console.log(`  Password         ${password}`);
    console.log('                   ^ shown once. You must change it at first sign-in.');
  } else if (createdNow) {
    console.log('  Password         (from DEMO_OWNER_PASSWORD)');
  }
  console.log(`${'='.repeat(62)}\n`);

  await disconnectDB();
  process.exit(0);
}

main().catch(async (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'demo seed failed');
  await disconnectDB().catch(() => {});
  process.exit(1);
});
