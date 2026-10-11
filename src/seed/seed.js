/**
 * Bootstraps a fresh database: the plan catalog and the first platform owner.
 *
 * Idempotent — safe to re-run. An existing owner is left alone (its password is
 * never silently reset), and plans are upserted by code.
 *
 * Run: npm run seed
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { env } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/db.js';
import { logger } from '../config/logger.js';
import * as models from '../models/index.js';
import { Plan, User } from '../models/index.js';
import { generatePassword } from '../utils/ids.js';

const here = dirname(fileURLToPath(import.meta.url));

async function seedPlans() {
  const plans = JSON.parse(await readFile(join(here, 'data', 'plans.json'), 'utf8'));
  let created = 0;
  let updated = 0;

  for (const plan of plans) {
    const existing = await Plan.findOne({ code: plan.code });
    if (existing) {
      // Refresh presentation, but never silently change the limits a live
      // tenant was sold on — tenants hold their own plan snapshot anyway.
      existing.set({
        name: plan.name,
        description: plan.description,
        price: plan.price,
        features: plan.features,
        sortOrder: plan.sortOrder,
        active: plan.active,
        public: plan.public,
      });
      await existing.save();
      updated += 1;
    } else {
      await Plan.create(plan);
      created += 1;
    }
  }
  return { created, updated, total: plans.length };
}

async function seedOwner() {
  const email = env.SEED_OWNER_EMAIL.toLowerCase().trim();
  const existing = await User.findOne({ email, tenantId: null });

  if (existing) {
    return { status: 'exists', email, password: null };
  }

  const password = env.SEED_OWNER_PASSWORD || generatePassword();
  const user = await User.create({
    tenantId: null,
    scope: 'platform',
    role: 'platform_owner',
    name: env.SEED_OWNER_NAME,
    email,
    passwordHash: await User.hashPassword(password),
    // Forced on first login unless an explicit password was supplied in .env.
    mustChangePassword: !env.SEED_OWNER_PASSWORD,
    active: true,
  });

  return {
    status: 'created',
    email: user.email,
    password: env.SEED_OWNER_PASSWORD ? null : password,
  };
}

/**
 * Mongoose builds indexes in the background when a model is first used, so a
 * script that exits early can leave half the indexes uncreated. Build them
 * explicitly and wait, otherwise the first production query silently
 * collection-scans.
 */
async function syncIndexes() {
  const names = Object.keys(models).filter(
    (k) => typeof models[k]?.syncIndexes === 'function'
  );
  const results = [];
  for (const name of names) {
    try {
      await models[name].syncIndexes();
      const built = await models[name].collection.indexes();
      results.push({ model: name, indexes: built.length });
    } catch (err) {
      results.push({ model: name, error: err.message });
    }
  }
  return results;
}

async function main() {
  await connectDB();

  const idx = await syncIndexes();
  const failed = idx.filter((r) => r.error);
  logger.info(
    { models: idx.length, indexes: idx.reduce((t, r) => t + (r.indexes || 0), 0) },
    'indexes synced'
  );
  for (const f of failed) logger.error(f, 'index sync failed');

  const plans = await seedPlans();
  logger.info(plans, 'plans seeded');

  const owner = await seedOwner();

  console.log(`\n${'='.repeat(62)}`);
  console.log('  UniLanding seed complete');
  console.log('='.repeat(62));
  console.log(`  Indexes          ${idx.reduce((t, r) => t + (r.indexes || 0), 0)} across ${idx.length} collections`);
  console.log(`  Plans            ${plans.created} created, ${plans.updated} updated`);
  if (owner.status === 'created') {
    console.log(`  Platform owner   ${owner.email}`);
    if (owner.password) {
      console.log(`  Password         ${owner.password}`);
      console.log('                   ^ shown once. You must change it at first login.');
    } else {
      console.log('  Password         (from SEED_OWNER_PASSWORD)');
    }
  } else {
    console.log(`  Platform owner   ${owner.email} (already existed — left unchanged)`);
  }
  console.log(`  Sign in at       ${env.PUBLIC_BASE_URL}/login`);
  console.log(`${'='.repeat(62)}\n`);

  await disconnectDB();
  process.exit(0);
}

main().catch(async (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'seed failed');
  await disconnectDB().catch(() => {});
  process.exit(1);
});
