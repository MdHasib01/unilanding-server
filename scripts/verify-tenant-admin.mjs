/**
 * Verifies the tenant admin API and the storefront order path:
 *
 *   - a tenant owner signs in and loads the editor bundle (MilkReady defaults),
 *   - draft saves never touch live; publish does,
 *   - unsafe section content is refused, handler-shaped keys are dropped,
 *   - image upload (local fallback) is stored, served, and type-sniffed,
 *   - cross-tenant spoofing is useless, staff are read-only,
 *   - public orders are priced from the catalogue, not the request,
 *   - discard and the signed draft preview.
 *
 * Run: node scripts/verify-tenant-admin.mjs
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  Tenant, Domain, User, TenantSettings, LandingPage, LandingPageRevision, Product, Order,
  MediaAsset, Counter, AuditLog,
} from '../src/models/index.js';
import { createTenant } from '../src/services/tenantService.js';
import { UPLOAD_ROOT, cloudinaryEnabled } from '../src/services/mediaService.js';
import { env } from '../src/config/env.js';

const PORT = 5179;
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

async function call(path, { method = 'GET', body, form, jar, host = PLATFORM_HOST, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  if (host) h['x-forwarded-host'] = host;
  if (jar) {
    const c = jar.header(); if (c) h.cookie = c;
    if (method !== 'GET' && jar.get('ul_csrf')) h['x-csrf-token'] = jar.get('ul_csrf');
  }
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: form ?? (body ? JSON.stringify(body) : undefined), redirect: 'manual',
  });
  if (jar) jar.absorb(res);
  let json = null; try { json = await res.clone().json(); } catch {}
  return { status: res.status, json, res };
}

const S = Date.now().toString(36);
const SLUG_A = `ta-alpha-${S}`;
const SLUG_B = `ta-beta-${S}`;
const PW = 'TenantOwner12345';

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const made = [];

async function cleanup() {
  const ids = made;
  await Promise.all([
    User.deleteMany({ tenantId: { $in: ids } }),
    Domain.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    TenantSettings.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    LandingPage.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    LandingPageRevision.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    Product.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    Order.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    MediaAsset.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    AuditLog.deleteMany({ tenantId: { $in: ids } }).setOptions({ allowCrossTenant: true }),
    Counter.deleteMany({ _id: { $in: ids.map((id) => `order:${id}`) } }),
    Tenant.deleteMany({ _id: { $in: ids } }).setOptions({ withDeleted: true }),
  ]);
  await Promise.all(ids.map((id) => rm(join(UPLOAD_ROOT, String(id)), { recursive: true, force: true })));
}

await connectDB();
const app = createApp();
const server = app.listen(PORT);
await new Promise((r) => server.once('listening', r));

try {
  const a = await createTenant({
    slug: SLUG_A, name: 'Alpha Shop', ownerEmail: `owner@${SLUG_A}.test`, ownerPassword: PW,
    planCode: 'business', productName: 'Alpha Jar', productPrice: 5650, productOfferPrice: 3399,
  });
  const b = await createTenant({
    slug: SLUG_B, name: 'Beta Shop', ownerEmail: `owner@${SLUG_B}.test`, ownerPassword: PW,
    planCode: 'business', productName: 'Beta Jar', productPrice: 900,
  });
  made.push(a.tenant._id, b.tenant._id);

  const staff = await User.create({
    tenantId: a.tenant._id, scope: 'tenant', role: 'tenant_staff', name: 'Alpha Staff',
    email: `staff@${SLUG_A}.test`, passwordHash: await User.hashPassword(PW), mustChangePassword: false,
  });

  const login = async (email, slug) => {
    const jar = makeJar();
    const r = await call('/auth/login', { method: 'POST', jar, body: { email, password: PW, tenantSlug: slug } });
    return { jar, status: r.status };
  };

  console.log('\n=== 1. Owner signs in and loads the editor ===');
  const ownerA = await login(`owner@${SLUG_A}.test`, SLUG_A);
  eq(ownerA.status, 200, 'tenant owner login -> 200');
  eq((await call('/t/pages/home')).status, 401, 'anonymous /t/pages/home -> 401');

  const home = await call('/t/pages/home', { jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(home.status, 200, 'GET /t/pages/home -> 200');
  const page = home.json?.data?.page;
  eq(home.json?.data?.canEdit, true, 'owner canEdit = true');
  eq(page?.live?.brand?.logoTextAccent, 'Milk', 'new page starts with the MilkReady brand');
  eq(page?.live?.theme?.primary, '#0284c7', 'new page starts with the MilkReady palette');
  eq(page?.draft?.sections?.length, 15, 'template has the 15 MilkReady sections');
  eq(home.json?.data?.products?.length, 1, 'editor bundle carries the product catalogue');
  const hero = page.draft.sections.find((s) => s.type === 'hero');

  console.log('\n=== 2. Draft saves never touch live ===');
  const sections = page.draft.sections.map((s) =>
    s.key === hero.key ? { ...s, data: { title: { bn: 'নতুন শিরোনাম' }, onClick: 'alert(1)', onerror: 'x' } } : s
  );
  const save = await call(`/t/pages/${page.id}/draft`, {
    method: 'PUT', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A },
    body: {
      theme: { primary: '#bd0052', accent: '#e37a69' },
      brand: { logoType: 'text', logoTextAccent: 'Alpha', logoText: 'Shop' },
      sections,
    },
  });
  eq(save.status, 200, 'PUT draft -> 200');
  eq(save.json?.data?.page?.dirty, true, 'draft is marked dirty');
  const savedHero = save.json?.data?.page?.draft?.sections?.find((s) => s.key === hero.key);
  eq(savedHero?.data?.title?.bn, 'নতুন শিরোনাম', 'hero title saved to draft');
  eq('onClick' in (savedHero?.data ?? {}) || 'onerror' in (savedHero?.data ?? {}), false, 'handler-shaped keys dropped');

  const publicBefore = await call(`/public/pages/${SLUG_A}`);
  eq(publicBefore.json?.data?.page?.theme?.primary, '#0284c7', 'public page still on the live palette');

  console.log('\n=== 3. Publish puts the draft live ===');
  const pub = await call(`/t/pages/${page.id}/publish`, { method: 'POST', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(pub.status, 200, 'publish -> 200');
  eq(pub.json?.data?.page?.revision, 2, 'revision bumped to 2');
  const publicAfter = await call(`/public/pages/${SLUG_A}`);
  eq(publicAfter.json?.data?.page?.theme?.primary, '#bd0052', 'public page now on the new palette');
  eq(publicAfter.json?.data?.page?.brand?.logoTextAccent, 'Alpha', 'public page carries the new brand');
  eq(
    publicAfter.json?.data?.page?.sections?.find((s) => s.type === 'hero')?.data?.title?.bn,
    'নতুন শিরোনাম',
    'public hero shows the published title'
  );

  console.log('\n=== 4. Unsafe content is refused ===');
  const evil = await call(`/t/pages/${page.id}/draft`, {
    method: 'PUT', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A },
    body: { sections: sections.map((s) => (s.key === hero.key ? { ...s, data: { messengerUrl: 'javascript:alert(1)' } } : s)) },
  });
  eq(evil.status, 422, 'javascript: URL in section data -> 422');
  eq(evil.json?.code, 'UNSAFE_CONTENT', 'error code UNSAFE_CONTENT');
  const badColour = await call(`/t/pages/${page.id}/draft`, {
    method: 'PUT', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A },
    body: { theme: { primary: 'red;}body{display:none' } },
  });
  eq(badColour.status, 422, 'non-hex theme colour -> 422');
  const badType = await call(`/t/pages/${page.id}/draft`, {
    method: 'PUT', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A },
    body: { sections: [{ key: 'abcdefgh', type: 'scriptBlock', order: 0, data: {} }] },
  });
  eq(badType.status, 422, 'unknown section type -> 422');

  console.log('\n=== 5. Image upload ===');
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'pixel.png');
  const up = await call('/t/media', { method: 'POST', form, jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(up.status, 201, 'upload -> 201');
  const url = up.json?.data?.url ?? '';
  if (cloudinaryEnabled()) {
    truthy(url.startsWith('https://'), 'stored on Cloudinary');
  } else {
    truthy(url.startsWith(`/api/media/${a.tenant._id}/`), 'stored locally under the tenant');
    const served = await fetch(`http://127.0.0.1:${PORT}${url}`);
    eq(served.status, 200, 'local upload is served');
    truthy(served.headers.get('content-security-policy')?.includes('sandbox'), 'served with a sandboxing CSP');
  }
  const lib = await call('/t/media', { jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(lib.json?.data?.length, 1, 'media library lists the upload');

  const fakeForm = new FormData();
  fakeForm.append('file', new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' }), 'evil.png');
  const fake = await call('/t/media', { method: 'POST', form: fakeForm, jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(fake.status, 415, 'HTML disguised as PNG -> 415');
  eq((await fetch(`http://127.0.0.1:${PORT}/api/media/${a.tenant._id}/..%2F..%2F.env`)).status, 404, 'path traversal -> 404');

  console.log('\n=== 6. Cross-tenant spoofing is useless ===');
  const spoof = await call('/t/pages/home', { jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_B } });
  const bPage = await LandingPage.findOne({ tenantId: b.tenant._id, isHome: true });
  truthy(spoof.status === 403 || (spoof.status === 200 && spoof.json?.data?.page?.id === page.id),
    "A's cookie + X-Tenant-Slug: B never yields B's page");
  const crossWrite = await call(`/t/pages/${bPage._id}/draft`, {
    method: 'PUT', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_B }, body: { theme: { primary: '#000000' } },
  });
  eq(crossWrite.status, 404, "A cannot save B's page by id -> 404");
  const bAfter = await LandingPage.findOne({ _id: bPage._id, tenantId: b.tenant._id });
  eq(bAfter.draft.theme.primary, '#0284c7', "B's draft untouched");

  console.log('\n=== 7. Staff are read-only ===');
  const staffLogin = await login(staff.email, SLUG_A);
  eq(staffLogin.status, 200, 'staff login -> 200');
  const staffHome = await call('/t/pages/home', { jar: staffLogin.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(staffHome.json?.data?.canEdit, false, 'staff canEdit = false');
  const staffSave = await call(`/t/pages/${page.id}/draft`, {
    method: 'PUT', jar: staffLogin.jar, headers: { 'x-tenant-slug': SLUG_A }, body: { theme: { primary: '#111111' } },
  });
  eq(staffSave.status, 403, 'staff save -> 403');
  eq(staffSave.json?.code, 'READ_ONLY', 'error code READ_ONLY');
  const staffUp = new FormData();
  staffUp.append('file', new Blob([PNG], { type: 'image/png' }), 'p.png');
  eq((await call('/t/media', { method: 'POST', form: staffUp, jar: staffLogin.jar, headers: { 'x-tenant-slug': SLUG_A } })).status, 403, 'staff upload -> 403');

  console.log('\n=== 8. Public orders are priced by the server ===');
  const product = await Product.findOne({ tenantId: a.tenant._id });
  const orderBody = {
    customer: { name: 'Test Buyer', phone: '01712345678' },
    shipping: { district: 'Dhaka', address: 'House 1, Road 2' },
    items: [{ productId: String(product._id), qty: 1 }],
    payment: { method: 'cod' },
    // Tampering: none of these may influence what is stored.
    total: 1, price: 1, pricing: { total: 1 },
  };
  const order = await call('/public/orders', { method: 'POST', body: orderBody, headers: { 'x-tenant-slug': SLUG_A } });
  eq(order.status, 201, 'POST /public/orders -> 201');
  eq(order.json?.data?.total, 3399, 'total is the catalogue offer price, not the posted one');
  truthy(/^UL-\d{5}$/.test(order.json?.data?.orderNumber ?? ''), 'order number from the tenant sequence');
  const stored = await Order.findOne({ tenantId: a.tenant._id, publicId: order.json?.data?.publicId });
  eq(stored?.items?.[0]?.unitPrice, 3399, 'stored line priced from the catalogue');
  truthy(stored?.landingPageId, 'order linked to the landing page');

  const summary = await call(`/public/orders/${order.json?.data?.publicId}`, { headers: { 'x-tenant-slug': SLUG_A } });
  eq(summary.status, 200, 'thank-you summary -> 200');
  eq(summary.json?.data?.customer?.phone, '017••••5678', 'phone is masked in the summary');
  eq((await call(`/public/orders/${order.json?.data?.publicId}`, { headers: { 'x-tenant-slug': SLUG_B } })).status, 404,
    "another tenant cannot read the order -> 404");

  const bkash = await call('/public/orders', {
    method: 'POST', headers: { 'x-tenant-slug': SLUG_A },
    body: { ...orderBody, payment: { method: 'manual_bkash', transactionId: 'ABC123' } },
  });
  eq(bkash.status, 422, 'disabled payment method -> 422');
  const foreign = await call('/public/orders', {
    method: 'POST', headers: { 'x-tenant-slug': SLUG_B }, body: orderBody,
  });
  eq(foreign.status, 422, "B's storefront cannot sell A's product -> 422");
  const badPhone = await call('/public/orders', {
    method: 'POST', headers: { 'x-tenant-slug': SLUG_A },
    body: { ...orderBody, customer: { name: 'X', phone: '12345' } },
  });
  eq(badPhone.status, 422, 'invalid phone -> 422');

  console.log('\n=== 9. Discard and the signed draft preview ===');
  await call(`/t/pages/${page.id}/draft`, {
    method: 'PUT', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A }, body: { theme: { primary: '#15803d' } },
  });
  const tok = await call(`/t/pages/${page.id}/preview-token`, { jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(tok.status, 200, 'preview token -> 200');
  const preview = await call(`/public/pages/${SLUG_A}/preview?token=${encodeURIComponent(tok.json?.data?.token)}`);
  eq(preview.json?.data?.page?.theme?.primary, '#15803d', 'preview renders the unpublished draft');
  eq(preview.json?.data?.preview, true, 'preview is flagged');
  const disc = await call(`/t/pages/${page.id}/discard`, { method: 'POST', jar: ownerA.jar, headers: { 'x-tenant-slug': SLUG_A } });
  eq(disc.status, 200, 'discard -> 200');
  eq(disc.json?.data?.page?.draft?.theme?.primary, '#bd0052', 'draft is back to live');
  eq(disc.json?.data?.page?.dirty, false, 'draft no longer dirty');
} catch (err) {
  bad('suite crashed', err.stack || err.message);
} finally {
  await cleanup().catch((e) => console.log('cleanup failed', e.message));
  server.close();
  await disconnectDB();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
