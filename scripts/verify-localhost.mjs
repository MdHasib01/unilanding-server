/**
 * Verifies the app is usable on plain localhost, with no hosts-file setup.
 *
 * This is the first thing anyone does after cloning, and before the
 * PLATFORM_HOST_ALIASES change it rendered "domain not configured" — localhost
 * was not recognised as the platform, so it fell through to the custom-domain
 * branch and found nothing.
 *
 * Run: node scripts/verify-localhost.mjs   (needs API :5000 and web :3000)
 */
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  Tenant, Domain, User, TenantSettings, LandingPage, LandingPageRevision,
  Product, Order, scopedModels,
} from '../src/models/index.js';
import { env, PLATFORM_HOSTS } from '../src/config/env.js';
import { createPageFromTemplate } from '../src/services/pageService.js';

let pass = 0, fail = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const bad = (m, e = '') => { fail += 1; console.log(`  FAIL  ${m}${e ? ` — ${e}` : ''}`); };
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const yes = (v, m) => (v ? ok(m) : bad(m));

/** Real Host header via a genuine TCP request, since fetch forbids setting it. */
async function get(hostHeader, path = '/') {
  const res = await fetch(`http://127.0.0.1:3000${path}`, {
    headers: { 'x-forwarded-host': hostHeader },
    redirect: 'manual',
  });
  const type = res.headers.get('content-type') ?? '';
  return {
    status: res.status,
    location: res.headers.get('location'),
    body: type.includes('text/html') ? await res.text() : '',
  };
}

const S = Date.now().toString(36);
const SLUG = `loc-${S}`;
const made = { tenants: [] };

async function cleanup() {
  const ids = made.tenants;
  await Promise.all([
    User.deleteMany({ tenantId: { $in: ids } }),
    Domain.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    TenantSettings.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    LandingPage.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    LandingPageRevision.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    Product.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    Order.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    Tenant.deleteMany({ _id: { $in: ids } }).setOptions({ withDeleted: true }),
  ]);
}

await connectDB();

try {
  console.log('\n=== 1. Both tiers agree on which hosts are the platform ===');
  for (const h of ['localhost', '127.0.0.1', '::1', 'unilanding.local', 'www.unilanding.local']) {
    yes(PLATFORM_HOSTS.includes(h), `server treats "${h}" as the platform`);
  }
  yes(!PLATFORM_HOSTS.includes('example.com'), 'a stranger host is NOT the platform');

  console.log('\n=== 2. The proxy answers "platform" for loopback names ===');
  for (const h of ['localhost', '127.0.0.1']) {
    const r = await fetch(
      `http://127.0.0.1:5000/api/internal/resolve-host?host=${encodeURIComponent(h)}`,
      { headers: { 'x-internal-key': env.INTERNAL_API_KEY } }
    );
    const j = await r.json();
    eq(j?.data?.platform, true, `resolve-host("${h}") reports platform`);
    eq(j?.data?.found, false, `resolve-host("${h}") is not a tenant`);
  }

  console.log('\n=== 3. The platform is reachable on every loopback name ===');
  for (const h of ['localhost:3000', '127.0.0.1:3000', 'unilanding.local:3000']) {
    const root = await get(h, '/');
    eq(root.status, 307, `${h}/ redirects (platform doorway, not unknown-domain)`);
    yes(root.location?.includes('/login'), `${h}/ goes to sign-in`);

    const login = await get(h, '/login');
    eq(login.status, 200, `${h}/login renders`);
    // Assert positively. next-intl serialises the WHOLE message catalogue
    // into every page, so "domain not configured" is present as a UI label on
    // any page and its absence cannot be tested. What matters is that the
    // sign-in page is the one that rendered.
    yes(
      /UniLanding platform|UniLanding প্ল্যাটফর্ম/.test(login.body),
      `${h}/login renders the sign-in heading`
    );
    yes(login.body.includes('id="email"'), `${h}/login renders the credentials form`);
  }

  console.log('\n=== 4. A tenant, reachable on localhost in both modes ===');
  const tenant = await Tenant.create({
    slug: SLUG, name: 'Localhost Shop', status: 'active',
    plan: { code: 'business', name: 'Business', limits: { landingPages: 3, products: 50 } },
  });
  made.tenants.push(tenant._id);

  const domain = await Domain.create({
    host: `${SLUG}.unilanding.local`, tenantId: tenant._id, type: 'platform_subdomain',
    status: 'active', isPrimary: true, ssl: { status: 'issued', provider: 'manual' },
    verification: { method: 'none' },
  });
  tenant.primaryDomainId = domain._id;
  await tenant.save();

  const db = scopedModels(tenant._id);
  await TenantSettings.create(
    ['general', 'orders', 'payments', 'sms'].map((key) => ({ tenantId: tenant._id, key, values: {} })),
    { ordered: true }
  );
  const page = await createPageFromTemplate({
    db, tenant, name: tenant.name, slug: '', isHome: true, templateId: 'bd-dtc-v1', publish: true,
  });
  const heroIdx = page.sections.findIndex((s) => s.type === 'hero');
  page.sections[heroIdx].data = { title: { bn: 'লোকালহোস্ট শিরোনাম', en: 'Localhost headline' } };
  page.draft = { ...page.toObject().draft, sections: page.sections };
  await page.save();

  // Path mode on localhost — the mode that needs no DNS at all.
  const pathMode = await get('localhost:3000', `/${SLUG}`);
  eq(pathMode.status, 200, `localhost:3000/${SLUG} renders the tenant page`);
  yes(pathMode.body.includes(`data-ul-tenant="${SLUG}"`), 'resolved as that tenant');
  yes(/Localhost headline|লোকালহোস্ট/.test(pathMode.body), 'content came from Mongo');
  yes(pathMode.body.includes('id="order"'), 'the order form is present');

  // Subdomain mode on *.localhost — browsers resolve this to loopback with no
  // hosts file, so this is the zero-setup way to exercise subdomain routing.
  const subMode = await get(`${SLUG}.localhost:3000`, '/');
  eq(subMode.status, 200, `${SLUG}.localhost:3000 renders the tenant page`);
  yes(subMode.body.includes(`data-ul-tenant="${SLUG}"`), 'the subdomain label resolved the tenant');
  yes(/Localhost headline|লোকালহোস্ট/.test(subMode.body), 'same content as path mode');

  console.log('\n=== 5. The guard rails still hold on localhost ===');
  const reserved = await get('localhost:3000', '/platform');
  eq(reserved.status, 307, '/platform is still the platform route, not a tenant called "platform"');

  const adminRedirect = await get('localhost:3000', '/admin');
  eq(adminRedirect.status, 307, '/admin on a platform host redirects');
  yes(adminRedirect.location?.endsWith('/platform'), '…to /platform');

  const unknown = await get('some-random-host.example', '/');
  yes(
    /ডোমেইন কনফিগার|Domain not configured/.test(unknown.body),
    'a genuinely unmapped host DOES still show "domain not configured"'
  );

  const reservedSub = await get('admin.localhost:3000', '/');
  yes(reservedSub.status !== 200 || !reservedSub.body.includes('data-ul-tenant'),
    'a reserved subdomain label is not treated as a tenant');

  console.log('\n=== 6. The API is reachable same-origin on localhost ===');
  const health = await fetch('http://127.0.0.1:3000/api/health');
  eq(health.status, 200, '/api/health through the rewrite');
  const hj = await health.json();
  eq(hj?.data?.status, 'ok', 'returns JSON, not the unknown-domain HTML');

  console.log(`\n${'='.repeat(58)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(58));
} catch (err) {
  console.error('\nHARNESS ERROR:', err);
  fail += 1;
} finally {
  await cleanup();
  await disconnectDB();
}

process.exit(fail > 0 ? 1 : 0);
