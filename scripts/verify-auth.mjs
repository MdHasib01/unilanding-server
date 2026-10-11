/**
 * End-to-end auth verification against the real database.
 *
 * Boots the app on a spare port and drives it with fetch, so this exercises the
 * genuine middleware chain: cookies, CSRF, scope, role, the mustChangePassword
 * gate and revocation.
 *
 * Run: node scripts/verify-auth.mjs
 */
import { createApp } from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { User, Tenant, Domain } from '../src/models/index.js';
import { signHandoff } from '../src/services/cryptoService.js';

const PORT = 5177;
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const bad = (m, e = '') => { fail += 1; console.log(`  FAIL  ${m}${e ? ` — ${e}` : ''}`); };
const eq = (actual, expected, m) =>
  actual === expected ? ok(m) : bad(m, `expected ${expected}, got ${actual}`);

/** Minimal cookie jar: name -> value, plus attribute capture for assertions. */
function makeJar() {
  const jar = new Map();
  const attrs = new Map();
  return {
    absorb(res) {
      const raw = res.headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair, ...rest] = line.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value === '' ) jar.delete(name); else jar.set(name, value);
        attrs.set(name, rest.map((a) => a.trim().toLowerCase()));
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get: (n) => jar.get(n),
    attrs: (n) => attrs.get(n) || [],
    has: (n) => jar.has(n),
  };
}

async function call(path, { method = 'GET', body, jar, host, headers = {}, csrf = true } = {}) {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  // Node's fetch (undici) treats `Host` as a forbidden header and silently
  // drops it, so setting it here would be a no-op and every request would look
  // like 127.0.0.1. x-forwarded-host is what the Next.js rewrite sets in
  // production anyway, and requestHost() prefers it.
  if (host) h['x-forwarded-host'] = host;
  if (jar) {
    const cookie = jar.header();
    if (cookie) h.cookie = cookie;
    if (csrf && method !== 'GET' && jar.get('ul_csrf')) h['x-csrf-token'] = jar.get('ul_csrf');
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  if (jar) jar.absorb(res);
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, res };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const SUFFIX = Date.now().toString(36);
const T1 = { slug: `vauth-a-${SUFFIX}`, email: `owner-a-${SUFFIX}@t.test`, pw: 'TenantAPass123' };
const T2 = { slug: `vauth-b-${SUFFIX}`, email: `owner-b-${SUFFIX}@t.test`, pw: 'TenantBPass123' };
const PLAT = { email: `plat-${SUFFIX}@unilanding.test`, pw: 'PlatformPass123' };

const created = { tenants: [], users: [], domains: [] };

async function makeTenant(spec) {
  const tenant = await Tenant.create({
    slug: spec.slug,
    name: spec.slug,
    status: 'active',
    plan: { code: 'starter', name: 'Starter', limits: { landingPages: 1, products: 5, staffUsers: 2 } },
  });
  const domain = await Domain.create({
    host: `${spec.slug}.unilanding.local`,
    tenantId: tenant._id,
    type: 'platform_subdomain',
    status: 'active',
    isPrimary: true,
    ssl: { status: 'issued', provider: 'manual' },
    verification: { method: 'none' },
  });
  const user = await User.create({
    tenantId: tenant._id,
    scope: 'tenant',
    role: 'tenant_owner',
    name: `Owner ${spec.slug}`,
    email: spec.email,
    passwordHash: await User.hashPassword(spec.pw),
    mustChangePassword: false,
  });
  tenant.ownerUserId = user._id;
  tenant.primaryDomainId = domain._id;
  await tenant.save();
  created.tenants.push(tenant._id);
  created.users.push(user._id);
  created.domains.push(domain._id);
  return { tenant, user, domain };
}

async function cleanup() {
  await Promise.all([
    User.deleteMany({ _id: { $in: created.users } }),
    Domain.deleteMany({ _id: { $in: created.domains } }).setOptions({ allowCrossTenant: true }),
    Tenant.deleteMany({ _id: { $in: created.tenants } }),
  ]);
}

// ── run ─────────────────────────────────────────────────────────────────────
await connectDB();
const app = createApp();
const server = app.listen(PORT);
await new Promise((r) => server.once('listening', r));

try {
  const a = await makeTenant(T1);
  const b = await makeTenant(T2);

  const platUser = await User.create({
    tenantId: null,
    scope: 'platform',
    role: 'platform_owner',
    name: 'Plat Owner',
    email: PLAT.email,
    passwordHash: await User.hashPassword(PLAT.pw),
    mustChangePassword: false,
  });
  created.users.push(platUser._id);

  console.log('\n=== 1. Login rejects bad credentials without leaking which part failed ===');
  const jarX = makeJar();
  const wrongPw = await call('/auth/login', {
    method: 'POST', jar: jarX, host: 'unilanding.local:3000',
    body: { email: PLAT.email, password: 'wrong-password-here' },
  });
  eq(wrongPw.status, 401, 'wrong password -> 401');
  const noUser = await call('/auth/login', {
    method: 'POST', jar: jarX, host: 'unilanding.local:3000',
    body: { email: `nobody-${SUFFIX}@nowhere.test`, password: 'whatever12345' },
  });
  eq(noUser.status, 401, 'unknown email -> 401');
  eq(
    wrongPw.json?.error === noUser.json?.error,
    true,
    'identical message for both (no account enumeration)'
  );

  console.log('\n=== 2. Platform login on the platform host ===');
  const platJar = makeJar();
  const platLogin = await call('/auth/login', {
    method: 'POST', jar: platJar, host: 'unilanding.local:3000',
    body: { email: PLAT.email, password: PLAT.pw },
  });
  eq(platLogin.status, 200, 'platform login -> 200');
  eq(platLogin.json?.data?.user?.scope, 'platform', 'scope is platform');
  eq(platJar.has('ul_session'), true, 'platform cookie ul_session set');
  eq(platJar.has('ul_t_session'), false, 'tenant cookie NOT set');
  eq(platJar.has('ul_csrf'), true, 'csrf cookie issued');

  const sessAttrs = platJar.attrs('ul_session');
  eq(sessAttrs.includes('httponly'), true, 'session cookie is HttpOnly');
  eq(sessAttrs.some((x) => x.startsWith('samesite=lax')), true, 'session cookie is SameSite=Lax');
  eq(
    sessAttrs.some((x) => x.startsWith('domain=')),
    false,
    'session cookie is HOST-ONLY (no Domain attribute) — the cross-tenant guard'
  );
  eq(platJar.attrs('ul_csrf').includes('httponly'), false, 'csrf cookie is readable by JS (by design)');

  console.log('\n=== 3. Tenant login resolved from the Host header ===');
  const aJar = makeJar();
  const aLogin = await call('/auth/login', {
    method: 'POST', jar: aJar, host: `${T1.slug}.unilanding.local`,
    body: { email: T1.email, password: T1.pw },
  });
  eq(aLogin.status, 200, 'tenant login via subdomain host -> 200');
  eq(aLogin.json?.data?.user?.scope, 'tenant', 'scope is tenant');
  eq(String(aLogin.json?.data?.tenant?.slug), T1.slug, 'correct tenant resolved');
  eq(aJar.has('ul_t_session'), true, 'tenant cookie ul_t_session set');
  eq(aJar.has('ul_session'), false, 'platform cookie NOT set');

  console.log('\n=== 4. A tenant user cannot sign in on the platform host ===');
  const crossJar = makeJar();
  const cross = await call('/auth/login', {
    method: 'POST', jar: crossJar, host: 'unilanding.local:3000',
    body: { email: T1.email, password: T1.pw },
  });
  eq(cross.status, 401, 'tenant credentials on the platform host -> 401');

  console.log('\n=== 5. A tenant user cannot sign in on ANOTHER tenant host ===');
  const wrongHostJar = makeJar();
  const wrongHost = await call('/auth/login', {
    method: 'POST', jar: wrongHostJar, host: `${T2.slug}.unilanding.local`,
    body: { email: T1.email, password: T1.pw },
  });
  eq(wrongHost.status, 401, "tenant A credentials on tenant B's host -> 401");

  console.log('\n=== 6. /auth/me and session identity ===');
  const meA = await call('/auth/me', { jar: aJar, host: `${T1.slug}.unilanding.local` });
  eq(meA.status, 200, 'me -> 200 with a session');
  eq(meA.json?.data?.user?.email, T1.email, 'me returns the right user');
  const meAnon = await call('/auth/me', { host: `${T1.slug}.unilanding.local` });
  eq(meAnon.status, 401, 'me without a session -> 401');

  console.log('\n=== 7. passwordHash never appears in a response ===');
  const bodyText = JSON.stringify(meA.json);
  eq(bodyText.includes('passwordHash'), false, 'no passwordHash key in /auth/me');
  eq(bodyText.includes('tokenVersion'), false, 'no tokenVersion key in /auth/me');
  eq(bodyText.includes('passwordResetHash'), false, 'no passwordResetHash key in /auth/me');

  console.log('\n=== 8. CSRF double-submit is enforced ===');
  const noCsrf = await call('/auth/change-password', {
    method: 'POST', jar: aJar, host: `${T1.slug}.unilanding.local`, csrf: false,
    body: { currentPassword: T1.pw, newPassword: 'BrandNewPass9876' },
  });
  eq(noCsrf.status, 403, 'state-changing request without the CSRF header -> 403');
  eq(noCsrf.json?.code, 'CSRF_FAILED', 'error code is CSRF_FAILED');

  const badCsrf = await call('/auth/change-password', {
    method: 'POST', jar: aJar, host: `${T1.slug}.unilanding.local`, csrf: false,
    headers: { 'x-csrf-token': 'not-the-right-token' },
    body: { currentPassword: T1.pw, newPassword: 'BrandNewPass9876' },
  });
  eq(badCsrf.status, 403, 'mismatched CSRF token -> 403');

  console.log('\n=== 9. Validation rejects a weak password ===');
  const weak = await call('/auth/change-password', {
    method: 'POST', jar: aJar, host: `${T1.slug}.unilanding.local`,
    body: { currentPassword: T1.pw, newPassword: 'short' },
  });
  eq(weak.status, 422, 'short password -> 422');
  eq(weak.json?.code, 'VALIDATION_FAILED', 'code is VALIDATION_FAILED');
  eq(Array.isArray(weak.json?.details), true, 'details array names the offending field');

  console.log('\n=== 10. Changing a password revokes other sessions ===');
  // A second device for the same user.
  const aJar2 = makeJar();
  await call('/auth/login', {
    method: 'POST', jar: aJar2, host: `${T1.slug}.unilanding.local`,
    body: { email: T1.email, password: T1.pw },
  });
  eq((await call('/auth/me', { jar: aJar2, host: `${T1.slug}.unilanding.local` })).status, 200,
    'second device is signed in');

  const changed = await call('/auth/change-password', {
    method: 'POST', jar: aJar, host: `${T1.slug}.unilanding.local`,
    body: { currentPassword: T1.pw, newPassword: 'BrandNewPass9876' },
  });
  eq(changed.status, 200, 'password change -> 200');
  eq((await call('/auth/me', { jar: aJar, host: `${T1.slug}.unilanding.local` })).status, 200,
    'the device that changed it stays signed in');
  eq((await call('/auth/me', { jar: aJar2, host: `${T1.slug}.unilanding.local` })).status, 401,
    'the OTHER device is signed out (tokenVersion bumped)');

  const reuseOld = await call('/auth/login', {
    method: 'POST', jar: makeJar(), host: `${T1.slug}.unilanding.local`,
    body: { email: T1.email, password: T1.pw },
  });
  eq(reuseOld.status, 401, 'the old password no longer works');

  console.log('\n=== 11. mustChangePassword gates everything else ===');
  const forced = await User.findById(created.users[0]);
  forced.mustChangePassword = true;
  await forced.save();

  const fJar = makeJar();
  const fLogin = await call('/auth/login', {
    method: 'POST', jar: fJar, host: `${T1.slug}.unilanding.local`,
    body: { email: T1.email, password: 'BrandNewPass9876' },
  });
  eq(fLogin.status, 200, 'login succeeds while mustChangePassword is set');
  eq(fLogin.json?.data?.user?.mustChangePassword, true, 'flag is reported to the client');
  eq((await call('/auth/me', { jar: fJar, host: `${T1.slug}.unilanding.local` })).status, 200,
    '/auth/me is exempt from the gate');

  console.log('\n=== 12. Deactivating an account takes effect immediately ===');
  const liveJar = makeJar();
  await call('/auth/login', {
    method: 'POST', jar: liveJar, host: `${T2.slug}.unilanding.local`,
    body: { email: T2.email, password: T2.pw },
  });
  eq((await call('/auth/me', { jar: liveJar, host: `${T2.slug}.unilanding.local` })).status, 200,
    'tenant B owner signed in');
  await User.findByIdAndUpdate(b.user._id, { active: false });
  const afterDisable = await call('/auth/me', { jar: liveJar, host: `${T2.slug}.unilanding.local` });
  eq(afterDisable.status, 403, 'existing session rejected the moment the account is disabled');
  eq(afterDisable.json?.code, 'ACCOUNT_DISABLED', 'code is ACCOUNT_DISABLED');
  await User.findByIdAndUpdate(b.user._id, { active: true });

  console.log('\n=== 13. A forged/garbage token is rejected ===');
  const forged = await fetch(`${BASE}/auth/me`, {
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.bad-signature' },
  });
  eq(forged.status, 401, 'unsigned/forged bearer token -> 401');

  console.log('\n=== 14. Cross-domain handoff: single use, tenant-bound ===');
  const handoff = signHandoff({ sub: String(b.user._id), tid: String(b.tenant._id) }, 60);
  const hJar = makeJar();
  const exch = await call('/auth/exchange', {
    method: 'POST', jar: hJar, host: `${T2.slug}.unilanding.local`, body: { token: handoff },
  });
  eq(exch.status, 200, 'valid handoff -> 200');
  eq(hJar.has('ul_t_session'), true, 'handoff sets a host-only tenant cookie on THIS host');
  eq(
    hJar.attrs('ul_t_session').some((x) => x.startsWith('domain=')),
    false,
    'handoff cookie is host-only too'
  );

  const wrongTenantHandoff = signHandoff({ sub: String(b.user._id), tid: String(a.tenant._id) }, 60);
  const bad1 = await call('/auth/exchange', {
    method: 'POST', jar: makeJar(), host: `${T1.slug}.unilanding.local`,
    body: { token: wrongTenantHandoff },
  });
  eq(bad1.status, 401, "a handoff bound to another tenant is refused");

  const expired = signHandoff({ sub: String(b.user._id), tid: String(b.tenant._id) }, -5);
  const bad2 = await call('/auth/exchange', {
    method: 'POST', jar: makeJar(), host: `${T2.slug}.unilanding.local`, body: { token: expired },
  });
  eq(bad2.status, 400, 'an expired handoff is refused');

  const tampered = `${handoff.split('.')[0]}.AAAAtamperedsignatureAAAA`;
  const bad3 = await call('/auth/exchange', {
    method: 'POST', jar: makeJar(), host: `${T2.slug}.unilanding.local`, body: { token: tampered } });
  eq(bad3.status, 400, 'a tampered handoff signature is refused');

  console.log('\n=== 15. Logout clears both cookies ===');
  const outRes = await call('/auth/logout', { method: 'POST', jar: hJar, host: `${T2.slug}.unilanding.local` });
  eq(outRes.status, 200, 'logout -> 200');
  eq(hJar.has('ul_t_session'), false, 'tenant cookie cleared');
  eq((await call('/auth/me', { jar: hJar, host: `${T2.slug}.unilanding.local` })).status, 401,
    'session is dead after logout');

  console.log('\n=== 16. Password reset survives a restart (persisted, hashed, single-use) ===');
  const fp = await call('/auth/forgot-password', {
    method: 'POST', jar: makeJar(), host: `${T2.slug}.unilanding.local`, body: { email: T2.email },
  });
  eq(fp.status, 200, 'forgot-password -> 200');
  const fpUnknown = await call('/auth/forgot-password', {
    method: 'POST', jar: makeJar(), host: `${T2.slug}.unilanding.local`,
    body: { email: `ghost-${SUFFIX}@nowhere.test` },
  });
  eq(fpUnknown.status, 200, 'unknown email also -> 200 (no enumeration)');

  const stored = await User.findById(b.user._id).select('+passwordResetHash +passwordResetExpiresAt');
  eq(Boolean(stored.passwordResetHash), true, 'reset token persisted on the user document');
  eq(stored.passwordResetHash.length, 64, 'stored as a sha256 hash, not plaintext');
  eq(stored.passwordResetExpiresAt > new Date(), true, 'has a future expiry');

  const badToken = await call('/auth/reset-password', {
    method: 'POST', jar: makeJar(), host: `${T2.slug}.unilanding.local`,
    body: { token: 'x'.repeat(40), newPassword: 'AnotherPass12345' },
  });
  eq(badToken.status, 400, 'a wrong reset token -> 400');

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
