/**
 * Verifies the platform dashboard the way a browser uses it: real cookies,
 * real redirects, real server-rendered HTML.
 *
 * Covers the flow the product is judged on — land on /, get sent to sign in,
 * reach the dashboard, create a landing page, and find it reachable and
 * configurable.
 *
 * Expects: API on :5000, `next start` on :3000.
 * Run: node scripts/verify-dashboard.mjs
 */
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  Tenant, Domain, User, TenantSettings, LandingPage, LandingPageRevision,
  Product, Order,
} from '../src/models/index.js';
import { env } from '../src/config/env.js';

const WEB = 'http://127.0.0.1:3000';
const HOST = 'unilanding.local:3000';

let pass = 0, fail = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const bad = (m, e = '') => { fail += 1; console.log(`  FAIL  ${m}${e ? ` — ${e}` : ''}`); };
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const yes = (v, m) => (v ? ok(m) : bad(m));

function makeJar() {
  const jar = new Map();
  return {
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        const n = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (v === '') jar.delete(n); else jar.set(n, v);
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (n) => jar.get(n),
    has: (n) => jar.has(n),
  };
}

async function hit(path, { method = 'GET', body, jar, follow = false } = {}) {
  const h = { 'x-forwarded-host': HOST };
  if (body) h['content-type'] = 'application/json';
  if (jar) {
    const c = jar.header();
    if (c) h.cookie = c;
    if (method !== 'GET' && jar.get('ul_csrf')) h['x-csrf-token'] = jar.get('ul_csrf');
  }
  const res = await fetch(`${WEB}${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
    redirect: follow ? 'follow' : 'manual',
  });
  if (jar) jar.absorb(res);
  const type = res.headers.get('content-type') ?? '';
  const text = type.includes('text/html') ? await res.text() : '';
  const json = type.includes('application/json') ? await res.json() : null;
  return { status: res.status, location: res.headers.get('location'), text, json };
}

const S = Date.now().toString(36);
const OWNER = { email: `dash-${S}@unilanding.test`, pw: 'DashOwnerPass12345' };
const SLUG = `dash-${S}`;
const made = { users: [], tenants: [] };

async function cleanup() {
  const ids = made.tenants;
  await Promise.all([
    User.deleteMany({ $or: [{ _id: { $in: made.users } }, { tenantId: { $in: ids } }] }),
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
  console.log('\n=== 1. The front door ===');
  const anon = await hit('/');
  eq(anon.status, 307, '/ redirects when signed out');
  yes(anon.location?.includes('/login'), 'redirects to /login');

  const loginPage = await hit('/login');
  eq(loginPage.status, 200, '/login renders');
  yes(loginPage.text.includes('UniLanding platform') || loginPage.text.includes('প্ল্যাটফর্ম'),
    'sign-in page shows the platform heading');
  yes(loginPage.text.includes('name="email"') || loginPage.text.includes('id="email"'),
    'the form is server-rendered, not a loading shell');

  console.log('\n=== 2. The dashboard is guarded server-side ===');
  const guarded = await hit('/platform');
  eq(guarded.status, 307, '/platform redirects when signed out');
  yes(guarded.location?.includes('/login'), 'redirects to /login');
  // The redirect shell embeds next-intl's message catalogue, so UI labels
  // appear in it regardless. The real question is whether any dashboard DATA
  // rendered, so assert on something only the signed-in page produces.
  yes(
    !guarded.text.includes('Dash Owner') && !guarded.text.includes('Recently added'),
    'no dashboard data is rendered before the redirect'
  );

  const guardedTenants = await hit('/platform/tenants');
  eq(guardedTenants.status, 307, '/platform/tenants is guarded too');

  console.log('\n=== 3. Sign in ===');
  const owner = await User.create({
    tenantId: null, scope: 'platform', role: 'platform_owner',
    name: 'Dash Owner', email: OWNER.email,
    passwordHash: await User.hashPassword(OWNER.pw), mustChangePassword: false,
  });
  made.users.push(owner._id);

  const jar = makeJar();
  const login = await hit('/api/auth/login', {
    method: 'POST', jar, body: { email: OWNER.email, password: OWNER.pw },
  });
  eq(login.status, 200, 'login through the same-origin /api rewrite works');
  yes(jar.has('ul_session'), 'platform session cookie set');
  yes(jar.has('ul_csrf'), 'csrf cookie set');

  console.log('\n=== 4. The dashboard renders ===');
  const dash = await hit('/platform', { jar });
  eq(dash.status, 200, '/platform renders when signed in');
  yes(dash.text.includes('Overview') || dash.text.includes('ওভারভিউ'), 'overview heading present');
  yes(dash.text.includes('Dash Owner'), 'the signed-in user is shown in the shell');
  yes(/Tenants|টেন্যান্ট/.test(dash.text), 'navigation is rendered');
  yes(dash.text.includes('New tenant') || dash.text.includes('নতুন টেন্যান্ট'),
    'a create action is offered');

  const root = await hit('/', { jar });
  eq(root.status, 307, '/ still redirects when signed in');
  yes(root.location?.endsWith('/platform'), '…and now goes to the dashboard');

  console.log('\n=== 5. The create form ===');
  const form = await hit('/platform/tenants/new', { jar });
  eq(form.status, 200, 'the create page renders');
  yes(form.text.includes('Business name'), 'business name field present');
  yes(form.text.includes('Address'), 'the slug field is labelled as the address');
  yes(form.text.includes('Owner email'), 'owner email field present');
  yes(/Starter|Business|Pro/.test(form.text), 'plans are loaded from the API into the form');
  yes(form.text.includes('Offer both Bangla and English'), 'the bilingual option is offered');

  console.log('\n=== 6. Create a landing page ===');
  const create = await hit('/api/platform/tenants', {
    method: 'POST', jar,
    body: {
      slug: SLUG, name: 'Dashboard Test Shop', ownerEmail: `shop-${S}@dash.test`,
      planCode: 'business', defaultLocale: 'bn', enabledLocales: ['bn', 'en'],
      productName: 'Test Product', productPrice: 2000, productOfferPrice: 1200,
    },
  });
  eq(create.status, 201, 'tenant created through the dashboard API');
  const result = create.json?.data;
  if (!result?.tenant?._id) throw new Error('create failed: ' + JSON.stringify(create.json));
  made.tenants.push(result.tenant._id);

  yes(result.generatedPassword?.length === 16, 'a password is generated and returned once');
  eq(result.adminUrls.length, 2, 'both admin URLs are returned');
  yes(result.adminUrls[0].includes(`${SLUG}.unilanding.local`), 'first admin URL is the subdomain');
  yes(result.adminUrls[1].includes(`/${SLUG}/admin`), 'second admin URL is the path form');
  eq(result.page.sections, 16, 'the landing page starts with 16 sections');

  console.log('\n=== 7. It appears in the list, and is reachable ===');
  const list = await hit('/platform/tenants', { jar });
  eq(list.status, 200, 'the tenants list renders');
  yes(list.text.includes('Dashboard Test Shop'), 'the new tenant is listed');
  yes(list.text.includes(`${SLUG}.unilanding.local`), 'its subdomain URL is shown');
  yes(list.text.includes(`unilanding.local:3000/${SLUG}`) || list.text.includes(`/${SLUG}`),
    'its path URL is shown');
  yes(list.text.includes('Configure'), 'a configure action is offered');

  // The landing page itself — reachable immediately, with no further steps.
  const landing = await hit(`/${SLUG}`);
  eq(landing.status, 200, 'the landing page is live the moment the tenant exists');
  yes(landing.text.includes(`data-ul-tenant="${SLUG}"`), 'it renders as that tenant');
  yes(landing.text.includes('id="order"'), 'the order form is on the page');
  yes(/1,?200|১,?২০০/.test(landing.text), 'the catalogue offer price appears on the page');

  console.log('\n=== 8. The configure screen ===');
  const detail = await hit(`/platform/tenants/${result.tenant._id}`, { jar });
  eq(detail.status, 200, 'the tenant detail page renders');
  yes(detail.text.includes('Dashboard Test Shop'), 'shows the tenant name');
  yes(detail.text.includes('Landing pages'), 'has a landing pages section');
  yes(detail.text.includes('Plan usage'), 'shows plan usage');
  yes(detail.text.includes('Domains'), 'shows domains');
  yes(detail.text.includes(`${SLUG}.unilanding.local`), 'shows the subdomain');
  yes(detail.text.includes('Open their editor') || detail.text.includes('Configure'),
    'offers a way into the page editor');
  yes(/Orders/.test(detail.text), 'tracks order count');
  yes(detail.text.includes('Sign in as owner') || detail.text.includes('Actions'),
    'offers impersonation');

  console.log('\n=== 9. Search and filter ===');
  const searched = await hit(`/platform/tenants?search=${SLUG}`, { jar });
  yes(searched.text.includes('Dashboard Test Shop'), 'search finds it by slug');
  const filteredOut = await hit('/platform/tenants?status=archived', { jar });
  yes(!filteredOut.text.includes('Dashboard Test Shop'),
    'a status filter excludes it correctly');

  console.log('\n=== 10. Suspension is visible and effective ===');
  await hit(`/api/platform/tenants/${result.tenant._id}/suspend`, {
    method: 'POST', jar, body: { reason: 'dashboard test' },
  });
  const afterSuspend = await hit(`/platform/tenants/${result.tenant._id}`, { jar });
  yes(afterSuspend.text.includes('Suspended'), 'the dashboard shows it as suspended');
  await hit(`/api/platform/tenants/${result.tenant._id}/activate`, { method: 'POST', jar });

  console.log('\n=== 11. A tenant user cannot reach the platform dashboard ===');
  const tenantOwner = await User.findOne({ tenantId: result.tenant._id, role: 'tenant_owner' });
  await User.findByIdAndUpdate(tenantOwner._id, {
    passwordHash: await User.hashPassword('TenantOwnerPass123'),
    mustChangePassword: false,
  });
  const tJar = makeJar();
  // Next's rewrite stamps its own x-forwarded-host from the real request Host,
  // so a faked one never reaches Express. A browser on the tenant's domain
  // sends the genuine Host and that works (verified separately); in path mode
  // the client sends tenantSlug explicitly, which is what LoginForm does.
  const tLogin = await fetch(`${WEB}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-slug': SLUG },
    body: JSON.stringify({
      email: tenantOwner.email,
      password: 'TenantOwnerPass123',
      tenantSlug: SLUG,
    }),
  });
  tJar.absorb(tLogin);
  eq(tLogin.status, 200, 'the tenant owner can sign in (path-mode, explicit tenantSlug)');
  eq(tLogin.ok && (await tLogin.clone().json()).data.user.scope, 'tenant', 'signed in as a tenant user');

  const tOnPlatform = await fetch(`${WEB}/platform`, {
    headers: { 'x-forwarded-host': HOST, cookie: tJar.header() },
    redirect: 'manual',
  });
  eq(tOnPlatform.status, 307, 'a tenant session is redirected away from /platform');
  const loc = tOnPlatform.headers.get('location') ?? '';
  yes(loc.includes(`/${SLUG}/admin`) || loc.includes('/login'),
    `…to their own admin or sign-in (${loc})`);

  console.log('\n=== 12. Sign out ===');
  const out = await hit('/api/auth/logout', { method: 'POST', jar });
  eq(out.status, 200, 'logout succeeds');
  yes(!jar.has('ul_session'), 'the session cookie is cleared');
  const afterOut = await hit('/platform', { jar });
  eq(afterOut.status, 307, '/platform is guarded again after signing out');

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
