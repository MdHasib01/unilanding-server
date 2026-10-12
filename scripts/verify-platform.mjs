/**
 * Verifies the platform API: tenant creation (transaction + side effects),
 * role gates, plan limits, impersonation handoff, host resolution, and the
 * cross-tenant isolation guarantees.
 *
 * Run: node scripts/verify-platform.mjs
 */
import { createApp } from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  Tenant, Domain, User, TenantSettings, LandingPage, Product, Order, LandingPageRevision, Plan,
  scopedModels,
} from '../src/models/index.js';
import { env } from '../src/config/env.js';

const PORT = 5178;
const BASE = `http://127.0.0.1:${PORT}/api`;
const PLATFORM_HOST = env.PLATFORM_HOST;

let pass = 0, fail = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const bad = (m, e = '') => { fail += 1; console.log(`  FAIL  ${m}${e ? ` — ${e}` : ''}`); };
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const truthy = (v, m) => (v ? ok(m) : bad(m, `got ${JSON.stringify(v)}`));

function makeJar() {
  const jar = new Map();
  return {
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        const n = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim();
        if (v === '') jar.delete(n); else jar.set(n, v);
      }
    },
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (n) => jar.get(n),
  };
}

async function call(path, { method = 'GET', body, jar, host, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  // Node fetch forbids the Host header; x-forwarded-host is what the Next
  // rewrite sets in production and what requestHost() prefers.
  if (host) h['x-forwarded-host'] = host;
  if (jar) {
    const c = jar.header(); if (c) h.cookie = c;
    if (method !== 'GET' && jar.get('ul_csrf')) h['x-csrf-token'] = jar.get('ul_csrf');
  }
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  if (jar) jar.absorb(res);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const S = Date.now().toString(36);
const OWNER = { email: `pf-owner-${S}@unilanding.test`, pw: 'PlatformOwner12345' };
const SUPPORT = { email: `pf-sup-${S}@unilanding.test`, pw: 'PlatformSupport123' };
const SLUG_A = `vp-alpha-${S}`;
const SLUG_B = `vp-beta-${S}`;

const madeUsers = [];
const madeTenants = [];
const madePlans = [];

async function cleanup() {
  const ids = madeTenants;
  await Promise.all([
    Plan.deleteMany({ _id: { $in: madePlans.filter(Boolean) } }),
    User.deleteMany({ $or: [{ _id: { $in: madeUsers } }, { tenantId: { $in: ids } }] }),
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
const app = createApp();
const server = app.listen(PORT);
await new Promise((r) => server.once('listening', r));

try {
  const owner = await User.create({
    tenantId: null, scope: 'platform', role: 'platform_owner',
    name: 'PF Owner', email: OWNER.email,
    passwordHash: await User.hashPassword(OWNER.pw), mustChangePassword: false,
  });
  const support = await User.create({
    tenantId: null, scope: 'platform', role: 'platform_support',
    name: 'PF Support', email: SUPPORT.email,
    passwordHash: await User.hashPassword(SUPPORT.pw), mustChangePassword: false,
  });
  madeUsers.push(owner._id, support._id);

  const ownerJar = makeJar();
  await call('/auth/login', { method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: { email: OWNER.email, password: OWNER.pw } });
  const supJar = makeJar();
  await call('/auth/login', { method: 'POST', jar: supJar, host: PLATFORM_HOST,
    body: { email: SUPPORT.email, password: SUPPORT.pw } });

  console.log('\n=== 1. Platform routes reject anonymous and tenant callers ===');
  eq((await call('/platform/overview', { host: PLATFORM_HOST })).status, 401, 'anonymous -> 401');
  eq((await call('/platform/overview', { jar: ownerJar, host: PLATFORM_HOST })).status, 200,
    'platform owner -> 200');

  console.log('\n=== 2. Create a tenant (one transaction, everything wired) ===');
  const createRes = await call('/platform/tenants', {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: {
      slug: SLUG_A, name: 'Alpha Store', ownerEmail: `owner@${SLUG_A}.test`,
      ownerName: 'Alpha Owner', planCode: 'starter', defaultLocale: 'bn',
      productName: 'Alpha Product', productPrice: 1200, contactPhone: '01712345678',
    },
  });
  eq(createRes.status, 201, 'create tenant -> 201');
  const tA = createRes.json?.data;
  truthy(tA?.tenant?._id, 'tenant returned with an id');
  if (tA?.tenant?._id) madeTenants.push(tA.tenant._id);

  eq(tA?.tenant?.status, 'active', 'tenant is active immediately');
  truthy(tA?.generatedPassword, 'a password was generated and surfaced once');
  eq(tA?.generatedPassword?.length, 16, 'generated password is 16 chars');
  truthy(tA?.owner?.id, 'owner user created');
  eq(tA?.owner?.mustChangePassword, true, 'owner must change the generated password');
  eq(tA?.owner?.passwordHash, undefined, 'owner payload carries no passwordHash');
  eq(tA?.domain?.type, 'platform_subdomain', 'platform subdomain created');
  eq(tA?.domain?.status, 'active', 'subdomain is active (wildcard cert)');
  eq(tA?.domain?.isPrimary, true, 'subdomain is primary');
  truthy(tA?.page, 'landing page created');
  // 15: the MilkReady order, with the doctors carousel inside the certifications section.
  eq(tA?.page?.sections, 15, 'bd-dtc-v1 produced 15 sections');
  eq(tA?.pageError, null, 'no page error');
  eq(tA?.adminUrls?.length, 2, 'both admin URLs returned (host mode + path mode)');
  truthy(tA?.adminUrls?.[1]?.endsWith(`/${SLUG_A}/admin`), 'path-mode admin URL is correct');

  const tenantId = tA.tenant._id;
  const dbA = scopedModels(tenantId);

  const settingsCount = await TenantSettings.countDocuments({ tenantId }).setOptions({ allowCrossTenant: true });
  eq(settingsCount, 9, 'nine settings documents seeded');

  const homePage = await dbA.LandingPage.findOne({ isHome: true });
  truthy(homePage, 'home page exists');
  eq(homePage?.status, 'published', 'home page is published, so the URL works at once');
  eq(homePage?.revision, 1, 'revision starts at 1');
  truthy(homePage?.draft?.sections?.length === homePage?.sections?.length,
    'draft and live both populated');
  const keys = homePage.sections.map((s) => s.key);
  eq(new Set(keys).size, keys.length, 'every section key is unique');
  truthy(keys.every((k) => /^[A-Za-z0-9_-]{6,16}$/.test(k)), 'section keys match the envelope rule');

  const prodCount = await dbA.Product.countDocuments({});
  eq(prodCount, 1, 'starter product created');

  console.log('\n=== 3. Duplicate and reserved slugs are refused ===');
  const dup = await call('/platform/tenants', {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: { slug: SLUG_A, name: 'Dup', ownerEmail: `d@${S}.test` },
  });
  eq(dup.status, 409, 'duplicate slug -> 409');
  eq(dup.json?.code, 'SLUG_TAKEN', 'code is SLUG_TAKEN');

  const reserved = await call('/platform/tenants', {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: { slug: 'admin', name: 'Reserved', ownerEmail: `r@${S}.test` },
  });
  truthy([422].includes(reserved.status), 'reserved slug refused (422)');

  const badSlug = await call('/platform/tenants', {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: { slug: 'Has Spaces!', name: 'Bad', ownerEmail: `b@${S}.test` },
  });
  eq(badSlug.status, 422, 'malformed slug -> 422');

  console.log('\n=== 4. Role gates ===');
  const supCreate = await call('/platform/tenants', {
    method: 'POST', jar: supJar, host: PLATFORM_HOST,
    body: { slug: `vp-sup-${S}`, name: 'Nope', ownerEmail: `n@${S}.test` },
  });
  eq(supCreate.status, 403, 'platform_support cannot create a tenant');
  eq(supCreate.json?.code, 'INSUFFICIENT_ROLE', 'code is INSUFFICIENT_ROLE');
  eq((await call(`/platform/tenants/${tenantId}`, { jar: supJar, host: PLATFORM_HOST })).status, 200,
    'platform_support CAN read a tenant');
  eq((await call(`/platform/tenants/${tenantId}/plan`, { method: 'PATCH', jar: supJar,
    host: PLATFORM_HOST, body: { planCode: 'pro' } })).status, 403,
    'only platform_owner may change a plan');

  console.log('\n=== 5. Plan snapshot: changing the catalog never re-limits a tenant ===');
  const before = await Tenant.findById(tenantId);
  eq(before.plan.code, 'starter', 'tenant holds the starter snapshot');
  eq(before.plan.limits.landingPages, 1, 'starter allows 1 landing page');

  const upg = await call(`/platform/tenants/${tenantId}/plan`, {
    method: 'PATCH', jar: ownerJar, host: PLATFORM_HOST, body: { planCode: 'business' },
  });
  eq(upg.status, 200, 'plan upgrade -> 200');
  eq(upg.json?.data?.plan?.code, 'business', 'snapshot re-written to business');
  eq(upg.json?.data?.plan?.limits?.landingPages, 3, 'limits came from the new plan');

  const override = await call(`/platform/tenants/${tenantId}/plan`, {
    method: 'PATCH', jar: ownerJar, host: PLATFORM_HOST, body: { limits: { landingPages: 7 } },
  });
  eq(override.json?.data?.plan?.limits?.landingPages, 7, 'a negotiated override sticks');
  eq(override.json?.data?.plan?.code, 'business', 'override does not change the plan code');

  console.log('\n=== 6. Host resolution for the proxy ===');
  const KEY = { 'x-internal-key': env.INTERNAL_API_KEY };
  const noKey = await call(`/internal/resolve-host?host=${SLUG_A}.unilanding.local`);
  eq(noKey.status, 404, 'internal route without the key looks like it does not exist');

  const r1 = await call(`/internal/resolve-host?host=${SLUG_A}.unilanding.local`, { headers: KEY });
  eq(r1.status, 200, 'resolve-host -> 200');
  eq(r1.json?.data?.found, true, 'platform subdomain resolves');
  eq(r1.json?.data?.slug, SLUG_A, 'correct slug');
  eq(r1.json?.data?.status, 'active', 'status active');
  eq(r1.json?.data?.defaultLocale, 'bn', 'defaultLocale returned for the no-flash locale');

  const r2 = await call('/internal/resolve-host?host=unilanding.local', { headers: KEY });
  eq(r2.json?.data?.found, false, 'the platform host is not a tenant');
  eq(r2.json?.data?.platform, true, 'flagged as the platform');

  const r3 = await call('/internal/resolve-host?host=totally-unmapped.example', { headers: KEY });
  eq(r3.status, 200, 'an unmapped host still answers 200 (cacheable negative)');
  eq(r3.json?.data?.found, false, 'unmapped host not found');

  const r4 = await call('/internal/resolve-host?host=admin.unilanding.local', { headers: KEY });
  eq(r4.json?.data?.found, false, 'a reserved subdomain label never resolves to a tenant');

  console.log('\n=== 7. An unverified custom domain must NOT serve the tenant ===');
  const pending = await Domain.create({
    host: `shop-${S}.example.com`, tenantId, type: 'custom_apex', status: 'pending',
    verification: { method: 'txt', token: 'tok' },
  });
  const r5 = await call(`/internal/resolve-host?host=shop-${S}.example.com`, { headers: KEY });
  eq(r5.json?.data?.found, false, 'pending domain does not serve');
  eq(r5.json?.data?.reason, 'domain not active', 'reason explains why');

  await Domain.findByIdAndUpdate(pending._id, {
    status: 'active', ssl: { status: 'issued', provider: 'manual' },
  });
  const r6 = await call(`/internal/resolve-host?host=shop-${S}.example.com`, { headers: KEY });
  eq(r6.json?.data?.found, true, 'active + issued cert does serve');

  await Domain.findByIdAndUpdate(pending._id, { status: 'active', ssl: { status: 'pending' } });
  const r7 = await call(`/internal/resolve-host?host=shop-${S}.example.com`, { headers: KEY });
  eq(r7.json?.data?.found, false, 'active but no certificate does NOT serve');

  console.log('\n=== 8. Suspension flows through to the proxy answer ===');
  const susp = await call(`/platform/tenants/${tenantId}/suspend`, {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST, body: { reason: 'non-payment' },
  });
  eq(susp.status, 200, 'suspend -> 200');
  const r8 = await call(`/internal/resolve-host?host=${SLUG_A}.unilanding.local`, { headers: KEY });
  eq(r8.json?.data?.status, 'suspended', 'proxy is told the tenant is suspended');
  await call(`/platform/tenants/${tenantId}/activate`, { method: 'POST', jar: ownerJar, host: PLATFORM_HOST });

  console.log('\n=== 9. An expired plan reads as suspended ===');
  await Tenant.findByIdAndUpdate(tenantId, { expiresAt: new Date(Date.now() - 86400_000) });
  const r9 = await call(`/internal/resolve-host?host=${SLUG_A}.unilanding.local`, { headers: KEY });
  eq(r9.json?.data?.status, 'suspended', 'a lapsed expiry is treated as suspended');
  await Tenant.findByIdAndUpdate(tenantId, { expiresAt: null });

  console.log('\n=== 10. Impersonation handoff ===');
  const imp = await call(`/platform/tenants/${tenantId}/impersonate`, {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
  });
  eq(imp.status, 200, 'impersonate -> 200');
  truthy(imp.json?.data?.url?.includes('/ul/session?t='), 'returns a handoff URL');
  eq(imp.json?.data?.expiresInSeconds, 60, 'handoff lives 60 seconds');
  truthy(imp.json?.data?.url?.startsWith(`http://${SLUG_A}.unilanding.local/`),
    "handoff points at the tenant's own host");

  const token = new URL(imp.json.data.url).searchParams.get('t');
  const impJar = makeJar();
  const ex = await call('/auth/exchange', {
    method: 'POST', jar: impJar, host: `${SLUG_A}.unilanding.local`, body: { token },
  });
  eq(ex.status, 200, 'exchange -> 200');
  eq(ex.json?.data?.impersonated, true, 'session is flagged as impersonated');
  const meImp = await call('/auth/me', { jar: impJar, host: `${SLUG_A}.unilanding.local` });
  eq(meImp.json?.data?.impersonated, true, '/auth/me reports impersonation for the banner');
  eq(meImp.json?.data?.user?.scope, 'tenant', 'acting as the tenant owner');

  console.log('\n=== 11. Cross-tenant isolation, with a real second tenant ===');
  const createB = await call('/platform/tenants', {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: { slug: SLUG_B, name: 'Beta Store', ownerEmail: `owner@${SLUG_B}.test`,
      ownerPassword: 'BetaOwnerPass123', planCode: 'starter' },
  });
  eq(createB.status, 201, 'second tenant created');
  const tB = createB.json.data;
  madeTenants.push(tB.tenant._id);
  eq(tB.generatedPassword, null, 'an explicit password is not echoed back');
  eq(tB.owner.mustChangePassword, false, 'explicit password does not force a change');

  const dbB = scopedModels(tB.tenant._id);
  const pageB = await dbB.LandingPage.findOne({ isHome: true });
  truthy(pageB, 'tenant B has its own home page');

  // Each tenant's scoped handle must see exactly one page: its own.
  eq(await dbA.LandingPage.countDocuments({}), 1, 'tenant A sees 1 page');
  eq(await dbB.LandingPage.countDocuments({}), 1, 'tenant B sees 1 page');
  const crossRead = await dbA.LandingPage.findById(pageB._id);
  eq(crossRead, null, "tenant A cannot read tenant B's page by id");

  const bOwner = await User.findOne({ tenantId: tB.tenant._id, role: 'tenant_owner' });
  const bJar = makeJar();
  await call('/auth/login', { method: 'POST', jar: bJar, host: `${SLUG_B}.unilanding.local`,
    body: { email: bOwner.email, password: 'BetaOwnerPass123' } });
  eq((await call('/auth/me', { jar: bJar, host: `${SLUG_B}.unilanding.local` })).status, 200,
    'tenant B owner is signed in');
  // A tenant session must not open platform endpoints.
  const bOnPlatform = await call('/platform/overview', { jar: bJar, host: PLATFORM_HOST });
  eq(bOnPlatform.status, 403, 'a tenant session cannot reach platform endpoints');
  eq(bOnPlatform.json?.code, 'WRONG_SCOPE', 'code is WRONG_SCOPE');

  console.log('\n=== 12. Platform-wide order feed requires a deliberate cross-tenant read ===');
  await dbA.Order.create({
    orderNumber: 'A-1', publicId: `pidA${S}`,
    customer: { name: 'A', phone: '01712345678' },
    items: [], pricing: { subtotal: 100, total: 100 },
  });
  await dbB.Order.create({
    orderNumber: 'B-1', publicId: `pidB${S}`,
    customer: { name: 'B', phone: '01787654321' },
    items: [], pricing: { subtotal: 200, total: 200 },
  });
  const feed = await call('/platform/orders', { jar: ownerJar, host: PLATFORM_HOST });
  eq(feed.status, 200, 'platform order feed -> 200');
  const slugs = (feed.json?.data ?? []).map((o) => o.tenant?.slug).filter(Boolean);
  truthy(slugs.includes(SLUG_A) && slugs.includes(SLUG_B),
    'feed spans both tenants and labels each order with its tenant');

  const filtered = await call(`/platform/orders?tenantId=${tenantId}`, { jar: ownerJar, host: PLATFORM_HOST });
  const onlyA = (filtered.json?.data ?? []).every((o) => String(o.tenantId) === String(tenantId));
  truthy(onlyA, 'tenantId filter narrows the feed correctly');

  console.log('\n=== 13. Archiving locks the tenant out immediately ===');
  const arch = await call(`/platform/tenants/${tB.tenant._id}`, {
    method: 'DELETE', jar: ownerJar, host: PLATFORM_HOST,
  });
  eq(arch.status, 200, 'archive -> 200');
  const meAfterArchive = await call('/auth/me', { jar: bJar, host: `${SLUG_B}.unilanding.local` });
  truthy([401, 403].includes(meAfterArchive.status),
    "an archived tenant's existing session stops working at once");
  const rArch = await call(`/internal/resolve-host?host=${SLUG_B}.unilanding.local`, { headers: KEY });
  eq(rArch.json?.data?.found, false, 'an archived tenant no longer resolves for the proxy');
  const slugStillTaken = await call('/platform/tenants', {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: { slug: SLUG_B, name: 'Reclaim', ownerEmail: `rc@${S}.test` },
  });
  eq(slugStillTaken.status, 409, 'the archived slug stays reserved (no silent takeover)');

  console.log('\n=== 14. Validation surfaces the offending field ===');
  const invalid = await call('/platform/tenants', {
    method: 'POST', jar: ownerJar, host: PLATFORM_HOST,
    body: { slug: `vp-x-${S}`, name: '', ownerEmail: 'not-an-email' },
  });
  eq(invalid.status, 422, 'invalid body -> 422');
  const paths = (invalid.json?.details ?? []).map((d) => d.path);
  truthy(paths.includes('name') && paths.includes('ownerEmail'),
    'details name both offending fields');

  console.log('\n=== 15. Dashboard menus: domains, plans, audit, settings ===');
  const dl = await call(`/platform/domains?tenantId=${tenantId}`, { jar: supJar, host: PLATFORM_HOST });
  eq(dl.status, 200, 'support can list domains');
  truthy(dl.json?.pagination?.total >= 2, 'domain list is paginated and includes the custom domain');
  truthy((dl.json?.data ?? []).every((d) => d.tenant?.slug === SLUG_A), 'each domain row names its tenant');

  eq((await call(`/platform/tenants/${tenantId}/domains`, { method: 'POST', jar: supJar,
    host: PLATFORM_HOST, body: { host: `x-${S}.example.org` } })).status, 403,
    'support cannot add a domain');

  const atLimit = await call(`/platform/tenants/${tenantId}/domains`, { method: 'POST', jar: ownerJar,
    host: PLATFORM_HOST, body: { host: `second-${S}.example.org` } });
  eq(atLimit.json?.code, 'LIMIT_REACHED', "the plan's custom-domain limit is enforced");

  const platformHostAdd = await call(`/platform/tenants/${tenantId}/domains`, { method: 'POST',
    jar: ownerJar, host: PLATFORM_HOST, body: { host: `evil.${env.PLATFORM_HOST.split(':')[0]}` } });
  eq(platformHostAdd.json?.code, 'PLATFORM_HOST', 'a platform hostname cannot be claimed');

  const rm = await call(`/platform/domains/${pending._id}`, { method: 'DELETE', jar: ownerJar, host: PLATFORM_HOST });
  eq(rm.status, 200, 'a non-primary custom domain can be removed');

  const added = await call(`/platform/tenants/${tenantId}/domains`, { method: 'POST', jar: ownerJar,
    host: PLATFORM_HOST, body: { host: `https://Shop-${S}.COM.bd:443/path` } });
  eq(added.status, 201, 'add custom domain -> 201');
  const nd = added.json?.data;
  eq(nd?.host, `shop-${S}.com.bd`, 'host normalised (scheme, case, port, path stripped)');
  eq(nd?.type, 'custom_apex', 'name under a two-part suffix (.com.bd) is an apex');
  eq(nd?.verification?.method, 'txt', 'apex verifies by TXT');
  eq(nd?.verification?.recordName, `_unilanding.shop-${S}.com.bd`, 'TXT record name returned');
  eq(nd?.status, 'pending', 'starts pending');

  const dupHost = await call(`/platform/tenants/${tenantId}/domains`, { method: 'POST', jar: ownerJar,
    host: PLATFORM_HOST, body: { host: `shop-${S}.com.bd` } });
  truthy([409, 422].includes(dupHost.status), 'the same host cannot be added twice');

  const vr = await call(`/platform/domains/${nd._id}/verify`, { method: 'POST', jar: ownerJar, host: PLATFORM_HOST });
  eq(vr.status, 200, 'verify answers 200 even when DNS is missing');
  eq(vr.json?.data?.verified, false, 'an absent TXT record does not verify');
  eq(vr.json?.data?.status, 'error', 'domain moves to error with a reason');
  truthy(vr.json?.data?.verification?.lastError, 'lastError explains what is missing');

  const earlyPrimary = await call(`/platform/domains/${nd._id}`, { method: 'PATCH', jar: ownerJar,
    host: PLATFORM_HOST, body: { isPrimary: true } });
  eq(earlyPrimary.json?.code, 'DOMAIN_NOT_SERVABLE', 'an unverified domain cannot become primary');

  await call(`/platform/domains/${nd._id}`, { method: 'PATCH', jar: ownerJar, host: PLATFORM_HOST,
    body: { status: 'active', ssl: { status: 'issued' } } });
  const prim = await call(`/platform/domains/${nd._id}`, { method: 'PATCH', jar: ownerJar,
    host: PLATFORM_HOST, body: { isPrimary: true } });
  eq(prim.status, 200, 'active + certificate -> can be made primary');
  eq((await Tenant.findById(tenantId)).primaryDomainId?.toString(), String(nd._id),
    'tenant.primaryDomainId follows the new primary');
  eq(await Domain.countDocuments({ tenantId, isPrimary: true }), 1, 'still exactly one primary');
  const rp = await call(`/internal/resolve-host?host=shop-${S}.com.bd`, { headers: KEY });
  eq(rp.json?.data?.found, true, 'the new primary serves the tenant');

  const rmPrimary = await call(`/platform/domains/${nd._id}`, { method: 'DELETE', jar: ownerJar, host: PLATFORM_HOST });
  eq(rmPrimary.json?.code, 'PRIMARY_DOMAIN', 'the primary domain cannot be removed');
  const sub = await Domain.findOne({ tenantId, type: 'platform_subdomain' });
  const rmSub = await call(`/platform/domains/${sub._id}`, { method: 'DELETE', jar: ownerJar, host: PLATFORM_HOST });
  eq(rmSub.json?.code, 'PLATFORM_SUBDOMAIN', 'the platform subdomain cannot be removed');

  const PLAN_CODE = `vp-plan-${S}`;
  const planBody = {
    code: PLAN_CODE, name: 'VP Plan', price: 999, interval: 'monthly',
    limits: { landingPages: 2, products: 4, staffUsers: 1, ordersPerMonth: 100, customDomains: 0, mediaMb: 50 },
    features: ['One thing'],
  };
  eq((await call('/platform/plans', { method: 'POST', jar: supJar, host: PLATFORM_HOST, body: planBody })).status,
    403, 'support cannot create a plan');
  const pc = await call('/platform/plans', { method: 'POST', jar: ownerJar, host: PLATFORM_HOST, body: planBody });
  eq(pc.status, 201, 'owner creates a plan');
  madePlans.push(pc.json?.data?._id);
  eq((await call('/platform/plans', { method: 'POST', jar: ownerJar, host: PLATFORM_HOST, body: planBody })).json?.code,
    'PLAN_CODE_TAKEN', 'a plan code is unique');
  const pu = await call(`/platform/plans/${pc.json?.data?._id}`, { method: 'PATCH', jar: ownerJar,
    host: PLATFORM_HOST, body: { price: 1299, limits: { products: 9 } } });
  eq(pu.json?.data?.price, 1299, 'plan price updated');
  eq(pu.json?.data?.limits?.products, 9, 'a single limit can be changed');
  eq(pu.json?.data?.limits?.landingPages, 2, 'the other limits are kept');
  const pl = await call('/platform/plans', { jar: ownerJar, host: PLATFORM_HOST });
  truthy((pl.json?.data ?? []).every((p) => typeof p.tenantCount === 'number'), 'plan list carries tenant counts');

  const au = await call(`/platform/audit?tenantId=${tenantId}&action=platform.domain`, { jar: ownerJar, host: PLATFORM_HOST });
  eq(au.status, 200, 'owner reads the audit log');
  const actions = new Set((au.json?.data ?? []).map((a) => a.action));
  truthy(actions.has('platform.domain_added') && actions.has('platform.domain_removed'),
    'domain changes are in the audit trail');
  truthy((au.json?.data ?? []).every((a) => a.action.startsWith('platform.domain')), 'action prefix filter works');
  truthy((au.json?.data ?? []).every((a) => a.userAgent === undefined), 'user agents are not sent to the client');
  eq((await call('/platform/audit', { jar: supJar, host: PLATFORM_HOST })).status, 403,
    'support cannot read the audit log');

  const st = await call('/platform/settings', { jar: ownerJar, host: PLATFORM_HOST });
  eq(st.status, 200, 'owner reads platform settings');
  eq(typeof st.json?.data?.integrations?.email, 'boolean', 'integrations are reported as booleans');
  truthy(!JSON.stringify(st.json?.data ?? {}).includes(env.JWT_SECRET), 'no secret leaks into settings');
  eq((await call('/platform/settings', { jar: supJar, host: PLATFORM_HOST })).status, 403,
    'support cannot read platform settings');

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(56));
} catch (err) {
  console.error('\nHARNESS ERROR:', err);
  fail += 1;
} finally {
  await cleanup();
  server.close();
  await disconnectDB();
}

process.exit(fail > 0 ? 1 : 0);
