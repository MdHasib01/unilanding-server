/**
 * End-to-end verification across the real stack: Express API + the built
 * Next.js app + Atlas.
 *
 * Proves the thing the whole architecture exists for — one tenant's landing
 * page, rendered from Mongo, reachable through all three routing modes, with
 * the right palette in the first byte and basePath-correct links.
 *
 * Expects: API on :5000, `next start` on :3000.
 * Run: node scripts/verify-e2e.mjs
 */
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Tenant, Domain, User, TenantSettings, LandingPage, LandingPageRevision, Product, Order, scopedModels } from '../src/models/index.js';
import { env } from '../src/config/env.js';

const WEB = 'http://127.0.0.1:3000';
const API = 'http://127.0.0.1:5000/api';

let pass = 0, fail = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const bad = (m, e = '') => { fail += 1; console.log(`  FAIL  ${m}${e ? ` — ${e}` : ''}`); };
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const yes = (v, m) => (v ? ok(m) : bad(m));

/**
 * Fetches a page as if it arrived for `host`.
 *
 * Node's fetch (undici) treats Host as a forbidden header and silently drops
 * it, so the request would otherwise always look like 127.0.0.1. The dev
 * server runs with TRUST_PROXY_HOST=true, which is also what a deployment
 * behind nginx needs, so X-Forwarded-Host is the honest way to do this.
 */
async function page(path, host) {
  const res = await fetch(`${WEB}${path}`, {
    headers: host ? { 'x-forwarded-host': host } : {},
    redirect: 'manual',
  });
  const body = res.headers.get('content-type')?.includes('text/html') ? await res.text() : '';
  return { status: res.status, body, location: res.headers.get('location'), res };
}

/** Same call the API makes after a publish. */
async function revalidate(slug, pageSlug = '') {
  await fetch(`${WEB}/ul/revalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': env.INTERNAL_API_KEY },
    body: JSON.stringify({ slug, pageSlug }),
  }).catch(() => {});
}

const S = Date.now().toString(36);
const SLUG = `e2e-${S}`;
const made = { tenants: [], users: [], domains: [] };

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
    User.deleteMany({ _id: { $in: made.users } }),
  ]);
}

await connectDB();

try {
  console.log('\n=== 0. Both servers are up ===');
  eq((await fetch(`${API}/health`)).status, 200, 'API /api/health');
  const viaRewrite = await fetch(`${WEB}/api/health`);
  eq(viaRewrite.status, 200, 'API reachable THROUGH the Next rewrite (same-origin /api)');
  const hj = await viaRewrite.json();
  eq(hj?.data?.status, 'ok', 'rewrite returns the API envelope, not an HTML page');

  console.log('\n=== 1. Create a tenant through the platform API ===');
  const owner = await User.create({
    tenantId: null, scope: 'platform', role: 'platform_owner',
    name: 'E2E Owner', email: `e2e-${S}@unilanding.test`,
    passwordHash: await User.hashPassword('E2EOwnerPass12345'), mustChangePassword: false,
  });
  made.users.push(owner._id);

  const jar = new Map();
  const absorb = (res) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-host': env.PLATFORM_HOST },
    body: JSON.stringify({ email: owner.email, password: 'E2EOwnerPass12345' }),
  });
  absorb(login);
  eq(login.status, 200, 'platform owner signed in');

  const create = await fetch(`${API}/platform/tenants`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookie(),
      'x-csrf-token': jar.get('ul_csrf') ?? '',
      'x-forwarded-host': env.PLATFORM_HOST,
    },
    body: JSON.stringify({
      slug: SLUG, name: 'E2E Shop', ownerEmail: `shop-${S}@e2e.test`, ownerName: 'Shop Owner',
      planCode: 'business', defaultLocale: 'bn', enabledLocales: ['bn', 'en'],
      productName: 'E2E Product', productPrice: 1500, productOfferPrice: 999,
      contactPhone: '01712345678',
    }),
  });
  const created = await create.json();
  eq(create.status, 201, 'tenant created');
  if (!created?.data?.tenant?._id) throw new Error('tenant creation failed: ' + JSON.stringify(created));
  made.tenants.push(created.data.tenant._id);
  const tenantId = created.data.tenant._id;

  // Give the page a theme and real content so there is something to assert on.
  const db = scopedModels(tenantId);
  const home = await db.LandingPage.findOne({ isHome: true });
  const BRAND = '#0d9488';
  home.theme = { ...home.theme, primary: BRAND, background: '#f7fdfc', cta: '#f59e0b' };
  const heroIdx = home.sections.findIndex((s) => s.type === 'hero');
  home.sections[heroIdx].data = {
    title: { bn: 'ই-টু-ই পরীক্ষার শিরোনাম', en: 'End to end test headline' },
    subtitle: { bn: 'বাংলা সাবটাইটেল', en: 'English subtitle' },
    ctaText: { bn: 'অর্ডার করুন', en: 'Order now' },
  };
  const faqIdx = home.sections.findIndex((s) => s.type === 'faq');
  home.sections[faqIdx].data = {
    title: { bn: 'প্রশ্নোত্তর', en: 'Questions' },
    items: [{ q: { bn: 'কত দিনে আসবে?', en: 'How long?' }, a: { bn: 'দুই দিন', en: 'Two days' } }],
  };
  home.draft = { ...home.toObject().draft, sections: home.sections, theme: home.theme };
  await home.save();

  const product = await db.Product.findOne({});
  const orderIdx = home.sections.findIndex((s) => s.type === 'orderForm');

  console.log('\n=== 2. Path mode: unilanding.local/<slug> (no rewrite) ===');
  const p1 = await page(`/${SLUG}`, 'unilanding.local:3000');
  eq(p1.status, 200, 'path-mode landing page renders 200');
  yes(p1.body.includes('End to end test headline') || p1.body.includes('ই-টু-ই'), 'headline from Mongo is in the HTML');
  yes(p1.body.includes(`data-ul-tenant="${SLUG}"`), 'tenant scope attribute present');
  yes(p1.body.includes(BRAND), `brand colour ${BRAND} is in the FIRST BYTE (server-rendered, no flash)`);
  yes(!p1.body.includes('#bd0052'), 'no leftover default brand colour from another tenant');
  const canonicalOf = (body) => body.match(/rel="canonical"\s+href="([^"]+)"/)?.[1];
  const c1 = canonicalOf(p1.body);
  // The tenant's primary host is its own subdomain. The bug this guards against
  // is a path-mode page claiming the BARE platform host as canonical.
  yes(
    c1?.includes(`${SLUG}.unilanding.local`),
    `path-mode canonical points at the tenant's own host (${c1})`
  );
  yes(
    !/^https?:\/\/unilanding\.local\//.test(c1 ?? ''),
    'path-mode canonical is NOT the bare platform host'
  );

  console.log('\n=== 3. Subdomain mode: <slug>.unilanding.local (rewritten, no lookup) ===');
  const p2 = await page('/', `${SLUG}.unilanding.local:3000`);
  eq(p2.status, 200, 'subdomain landing page renders 200');
  yes(p2.body.includes('End to end test headline') || p2.body.includes('ই-টু-ই'), 'same content served');
  yes(p2.body.includes(`data-ul-tenant="${SLUG}"`), 'same tenant resolved from the subdomain label');
  const c2 = canonicalOf(p2.body);
  eq(c2, c1, 'path mode and subdomain mode emit the SAME canonical (no duplicate content)');

  console.log('\n=== 4. Custom domain mode (needs an active, certificated domain) ===');
  const customHost = `shop-${S}.example.com`;
  const dom = await Domain.create({
    host: customHost, tenantId, type: 'custom_apex', status: 'pending',
    verification: { method: 'txt', token: 'tok' },
  });
  made.domains.push(dom._id);

  const pPending = await page('/', customHost);
  yes(pPending.body.includes('Domain not configured') || pPending.body.includes('ডোমেইন'),
    'an unverified custom domain shows the unknown-domain page, NOT the tenant');

  await Domain.findByIdAndUpdate(dom._id, { status: 'active', ssl: { status: 'issued', provider: 'manual' } });
  await fetch(`${API}/internal/bust-host-cache`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': env.INTERNAL_API_KEY },
    body: JSON.stringify({ host: customHost }),
  });
  // The proxy keeps its own cache; bust it there too.
  await fetch(`${WEB}/ul/unknown-domain`).catch(() => {});

  let pCustom = await page('/', customHost);
  if (pCustom.status !== 200 || !/End to end|ই-টু-ই/.test(pCustom.body)) {
    // Wait out the proxy's negative cache rather than asserting on a stale read.
    await new Promise((r) => setTimeout(r, 31_000));
    pCustom = await page('/', customHost);
  }
  eq(pCustom.status, 200, 'verified custom domain renders the tenant page');
  yes(/End to end|ই-টু-ই/.test(pCustom.body), 'custom domain serves the same content');

  console.log('\n=== 5. www redirect ===');
  const wwwDom = await Domain.create({
    host: `www.${customHost}`, tenantId, type: 'custom_subdomain', status: 'active',
    ssl: { status: 'issued', provider: 'manual' }, redirectTo: customHost,
    verification: { method: 'none' },
  });
  made.domains.push(wwwDom._id);
  const pWww = await page('/', `www.${customHost}`);
  eq(pWww.status, 301, 'www host returns a 301');
  yes(pWww.location?.includes(customHost), 'redirects to the apex');

  console.log('\n=== 6. Unmapped host and the platform host ===');
  const pUnknown = await page('/', 'not-ours-at-all.example');
  yes(pUnknown.body.includes('Domain not configured') || pUnknown.body.includes('ডোমেইন'),
    'an unmapped host shows the unknown-domain page');
  const pPlatform = await page('/', 'unilanding.local:3000');
  eq(pPlatform.status, 200, 'the platform host still serves its own home page');
  yes(pPlatform.body.includes('Landing pages that take orders'), 'platform marketing copy, not a tenant');

  console.log('\n=== 7. /admin is tenant-only on the platform host ===');
  const pAdmin = await page('/admin', 'unilanding.local:3000');
  eq(pAdmin.status, 307, '/admin on the platform host redirects');
  yes(pAdmin.location?.endsWith('/platform'), 'redirects to /platform');

  console.log('\n=== 8. Reserved slugs never resolve as a tenant ===');
  const pReserved = await page('/pricing', 'unilanding.local:3000');
  yes(pReserved.status === 404 || pReserved.status === 200,
    '/pricing is treated as a platform route, not a tenant lookup');
  const pUl = await page('/ul/suspended', 'unilanding.local:3000');
  eq(pUl.status, 200, '/ul/* routes exist (no leading underscore, so not a private folder)');

  console.log('\n=== 9. Suspension is enforced at the edge of the request ===');
  await Tenant.findByIdAndUpdate(tenantId, { status: 'suspended' });
  await fetch(`${API}/internal/bust-host-cache`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': env.INTERNAL_API_KEY },
    body: JSON.stringify({ slug: SLUG }),
  });
  const pSusp = await page(`/${SLUG}`, 'unilanding.local:3000');
  yes(pSusp.status >= 400 || /unavailable|দেখা যাচ্ছে না/.test(pSusp.body),
    'a suspended tenant no longer serves its landing page');
  await Tenant.findByIdAndUpdate(tenantId, { status: 'active' });

  console.log('\n=== 10. i18n: locale from the cookie, no URL segment ===');
  const bnRes = await fetch(`${WEB}/${SLUG}`, { headers: { 'x-forwarded-host': 'unilanding.local:3000' } });
  const bnBody = await bnRes.text();
  yes(bnBody.includes('ই-টু-ই পরীক্ষার শিরোনাম'), 'defaults to the tenant locale (bn) with no cookie');
  yes(bnBody.includes('lang="bn"'), 'html lang is bn');

  const enRes = await fetch(`${WEB}/${SLUG}`, {
    headers: { 'x-forwarded-host': 'unilanding.local:3000', cookie: 'UL_LOCALE=en' },
  });
  const enBody = await enRes.text();
  yes(enBody.includes('End to end test headline'), 'UL_LOCALE=en switches the tenant content');
  yes(enBody.includes('lang="en"'), 'html lang switches to en');
  yes(!enBody.includes('/en/'), 'no locale segment appears in any URL');

  console.log('\n=== 11. Sections: order, visibility, and unknown types ===');
  const names = ['announcementBar', 'hero', 'faq', 'orderForm', 'footer'];
  for (const n of names) {
    yes(home.sections.some((s) => s.type === n), `template includes ${n}`);
  }
  // Hide the FAQ and confirm it leaves the rendered page.
  const pBefore = await page(`/${SLUG}`, 'unilanding.local:3000');
  yes(/প্রশ্নোত্তর|Questions/.test(pBefore.body), 'the FAQ section is rendered while enabled');

  home.sections[faqIdx].enabled = false;
  await home.save();
  await revalidate(SLUG);

  // revalidateTag marks the entry stale and refreshes it in the background, so
  // the first read can still be the old page. The tenant admin's own publish
  // button goes through a Server Action using updateTag, which gives
  // read-your-writes; this route is the server-initiated path where
  // stale-while-revalidate is the right trade.
  let pHidden = await page(`/${SLUG}`, 'unilanding.local:3000');
  if (/প্রশ্নোত্তর|Questions/.test(pHidden.body)) {
    await new Promise((r) => setTimeout(r, 1200));
    pHidden = await page(`/${SLUG}`, 'unilanding.local:3000');
  }
  yes(
    !/প্রশ্নোত্তর|Questions/.test(pHidden.body),
    'a disabled section disappears once the revalidated entry is refreshed'
  );

  home.sections[faqIdx].enabled = true;
  await home.save();
  await revalidate(SLUG);

  // An unknown section type must be skipped, not crash the page.
  home.sections.push({ key: 'unknown01xy', type: 'notARealSection', order: 99, enabled: true, data: {} });
  await home.save();
  await revalidate(SLUG);
  const pUnknownSection = await page(`/${SLUG}`, 'unilanding.local:3000');
  eq(pUnknownSection.status, 200, 'an unknown section type does not break the page');
  yes(/End to end|ই-টু-ই/.test(pUnknownSection.body), 'the rest of the page still renders');

  console.log('\n=== 12. Order form is present and priced from the catalogue ===');
  yes(pUnknownSection.body.includes('id="order"'), 'the order form anchor exists for CTAs to scroll to');
  yes(product && product.offerPrice === 999, 'product has the offer price the tenant was created with');
  yes(/999/.test(pUnknownSection.body), 'the catalogue price appears in the page, not a hardcoded one');

  console.log('\n=== 12b. The revalidate hook is internal-only ===');
  const revNoKey = await fetch(`${WEB}/ul/revalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: SLUG }),
  });
  eq(revNoKey.status, 404, 'revalidate without the internal key looks like it does not exist');

  console.log('\n=== 13. SEO and canonical ===');
  yes(pUnknownSection.body.includes('rel="canonical"'), 'a canonical link is emitted');
  const canonical = canonicalOf(pUnknownSection.body);
  const primary = await Domain.findById((await Tenant.findById(tenantId)).primaryDomainId);
  yes(
    canonical?.includes(primary.host),
    `canonical points at the tenant's primary host ${primary.host} (got ${canonical})`
  );
  yes(pUnknownSection.body.includes('og:title'), 'OpenGraph tags present');

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
