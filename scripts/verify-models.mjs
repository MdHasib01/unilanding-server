/**
 * Structural verification of the data model, with no live database.
 *
 * Mongoose compiles schemas and resolves indexes locally, so this proves the
 * shape, the index design and — most importantly — that the tenant-isolation
 * guard actually fires. Run: node verify-models.mjs
 */
import mongoose from 'mongoose';
import * as M from '../src/models/index.js';
import { scopedModels } from '../src/models/index.js';

let pass = 0;
let fail = 0;
const ok = (msg) => {
  pass += 1;
  console.log(`  PASS  ${msg}`);
};
const bad = (msg, extra = '') => {
  fail += 1;
  console.log(`  FAIL  ${msg}${extra ? ` — ${extra}` : ''}`);
};

console.log('\n=== 1. Models compile ===');
const names = [
  'Tenant', 'Domain', 'User', 'Plan', 'LandingPage', 'LandingPageRevision',
  'Product', 'Order', 'Lead', 'TenantSettings', 'MediaAsset', 'OtpToken',
  'AuditLog', 'Counter',
];
for (const n of names) {
  if (M[n] && typeof M[n].findOne === 'function') ok(`${n} compiled`);
  else bad(`${n} missing or not a model`);
}

console.log('\n=== 2. Every tenant-owned model leads its indexes with tenantId ===');
const tenantOwned = [
  'LandingPage', 'LandingPageRevision', 'Product', 'Order', 'Lead',
  'TenantSettings', 'MediaAsset', 'OtpToken',
];
for (const n of tenantOwned) {
  const idx = M[n].schema.indexes();
  const compound = idx.filter(([spec]) => Object.keys(spec).length > 1);
  const offenders = compound.filter(([spec]) => Object.keys(spec)[0] !== 'tenantId');
  if (offenders.length === 0) {
    ok(`${n}: ${compound.length} compound index(es), all tenantId-leading`);
  } else {
    bad(`${n}: compound index not leading with tenantId`, JSON.stringify(offenders.map((o) => o[0])));
  }
  if (!M[n].schema.path('tenantId')) bad(`${n}: no tenantId path`);
  // Removing the standalone tenantId index only works if a compound index
  // still LEADS with tenantId, so tenantId-only reads use it as a prefix.
  const hasPrefix = idx.some(([spec]) => Object.keys(spec)[0] === 'tenantId');
  if (hasPrefix) ok(`${n}: has a tenantId-prefix index (serves tenantId-only reads)`);
  else bad(`${n}: NO tenantId-prefix index — tenantId-only reads would collscan`);
  // And the redundant standalone index must be gone.
  const standalone = idx.some(([spec]) => Object.keys(spec).length === 1 && spec.tenantId === 1 && true);
  const standaloneNonPartial = idx.some(
    ([spec, opt]) => Object.keys(spec).length === 1 && spec.tenantId === 1 && !opt?.partialFilterExpression
  );
  if (standaloneNonPartial) bad(`${n}: redundant standalone { tenantId: 1 } index still present`);
}

console.log('\n=== 3. The leak guard fires on an unscoped query ===');
const guardChecks = [
  ['Order.find({})', () => M.Order.find({})],
  ['Order.findOne({ status: "pending" })', () => M.Order.findOne({ status: 'pending' })],
  ['Product.updateMany({}, {})', () => M.Product.updateMany({}, { $set: { active: false } })],
  ['Order.deleteMany({})', () => M.Order.deleteMany({})],
  ['LandingPage.countDocuments({})', () => M.LandingPage.countDocuments({})],
  ['Order.estimatedDocumentCount()', () => M.Order.estimatedDocumentCount()],
  ['Order.aggregate([{ $group }])', () => M.Order.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])],
];
for (const [label, run] of guardChecks) {
  try {
    await run();
    bad(`${label} was ALLOWED through unscoped`);
  } catch (err) {
    if (err?.code === 'UNSCOPED_TENANT_QUERY') ok(`${label} blocked`);
    else bad(`${label} threw the wrong error`, `${err?.code || err?.name}: ${err?.message}`);
  }
}

console.log('\n=== 4. A deliberate platform-wide read is allowed ===');
try {
  // No DB, so this must fail on connection/buffering, NOT on the guard.
  await M.Order.find({}).setOptions({ allowCrossTenant: true }).maxTimeMS(1).exec();
  ok('allowCrossTenant passed the guard (and reached the driver)');
} catch (err) {
  if (err?.code === 'UNSCOPED_TENANT_QUERY') bad('allowCrossTenant was still blocked by the guard');
  else ok(`allowCrossTenant passed the guard (stopped later at the driver: ${err?.name})`);
}

console.log('\n=== 5. scopedModels injects and cannot be overridden ===');
const tA = new mongoose.Types.ObjectId();
const tB = new mongoose.Types.ObjectId();
const db = scopedModels(tA);

const q = db.Order.find({ status: 'pending' });
const f = q.getFilter();
if (String(f.tenantId) === String(tA)) ok('find() filter carries the bound tenantId');
else bad('find() filter missing tenantId', JSON.stringify(f));

// The attack: a client posts its own tenantId hoping to read another tenant.
const spoofed = db.Order.find({ status: 'pending', tenantId: tB }).getFilter();
if (String(spoofed.tenantId) === String(tA)) ok('a client-supplied tenantId in the filter is overridden');
else bad('SPOOFED tenantId survived', JSON.stringify(spoofed));

const upd = db.Product.findOneAndUpdate({ _id: '1' }, { tenantId: tB, name: 'x' });
if (String(upd.getFilter().tenantId) === String(tA)) ok('update filter is scoped');
else bad('update filter not scoped');
const updDoc = upd.getUpdate();
if (!updDoc?.$set?.tenantId && !updDoc?.tenantId) ok('tenantId stripped from the update payload');
else bad('tenantId survived into the update payload', JSON.stringify(updDoc));

const byId = db.Order.findById('507f1f77bcf86cd799439011').getFilter();
if (String(byId.tenantId) === String(tA)) ok('findById is scoped');
else bad('findById is NOT scoped');

const agg = db.Order.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]);
const firstStage = agg.pipeline()[0];
if (firstStage?.$match && String(firstStage.$match.tenantId) === String(tA)) {
  ok('aggregate() is prefixed with a tenantId $match');
} else {
  bad('aggregate() not prefixed', JSON.stringify(firstStage));
}

try {
  scopedModels(null);
  bad('scopedModels(null) was allowed');
} catch {
  ok('scopedModels refuses a missing tenantId');
}

console.log('\n=== 6. User scope/role invariants ===');
const cases = [
  ['platform user with a tenantId', { scope: 'platform', role: 'platform_owner', tenantId: tA }, false],
  ['platform user, no tenantId', { scope: 'platform', role: 'platform_owner', tenantId: null }, true],
  ['tenant user without a tenantId', { scope: 'tenant', role: 'tenant_owner', tenantId: null }, false],
  ['tenant user with a tenantId', { scope: 'tenant', role: 'tenant_owner', tenantId: tA }, true],
  ['tenant role on a platform user', { scope: 'platform', role: 'tenant_owner', tenantId: null }, false],
  ['platform role on a tenant user', { scope: 'tenant', role: 'platform_owner', tenantId: tA }, false],
];
for (const [label, attrs, shouldPass] of cases) {
  const u = new M.User({ name: 'T', email: 't@example.com', passwordHash: 'x', ...attrs });
  try {
    await u.validate();
    if (shouldPass) ok(`accepted: ${label}`);
    else bad(`accepted but should have been rejected: ${label}`);
  } catch (err) {
    if (!shouldPass) ok(`rejected: ${label}`);
    else bad(`rejected but should have been accepted: ${label}`, err.message);
  }
}

console.log('\n=== 7. Partial-unique guards (one home page / one primary domain) ===');
const homeIdx = M.LandingPage.schema
  .indexes()
  .find(([, opt]) => opt?.partialFilterExpression?.isHome === true);
homeIdx?.[1]?.unique ? ok('one isHome page per tenant enforced by a partial unique index')
  : bad('missing partial unique index for isHome');

const primaryIdx = M.Domain.schema
  .indexes()
  .find(([, opt]) => opt?.partialFilterExpression?.isPrimary === true);
primaryIdx?.[1]?.unique ? ok('one primary domain per tenant enforced by a partial unique index')
  : bad('missing partial unique index for isPrimary');

console.log('\n=== 8. Settings defaults are deep-merged and self-healing ===');
const { SETTINGS_DEFAULTS } = await import('../src/models/TenantSettings.js');
if (SETTINGS_DEFAULTS.orders.deliveryCharges.inside === 0) ok('orders.deliveryCharges default present');
else bad('orders defaults wrong');
if (SETTINGS_DEFAULTS.courier.apiKey === '') ok('courier.apiKey default present (secret path)');
else bad('courier defaults wrong');

console.log('\n=== 9. Order TTL / uniqueness surface ===');
const orderIdx = M.Order.schema.indexes();
const hasPublicUnique = orderIdx.some(
  ([spec, opt]) => spec.publicId === 1 && opt?.unique
);
hasPublicUnique ? ok('publicId is unique (non-enumerable order handle)') : bad('publicId not unique');
const hasNumberUnique = orderIdx.some(
  ([spec, opt]) => spec.tenantId === 1 && spec.orderNumber === 1 && opt?.unique
);
hasNumberUnique ? ok('orderNumber unique per tenant') : bad('orderNumber not unique per tenant');

const leadTtl = M.Lead.schema.indexes().some(([, opt]) => opt?.expireAfterSeconds);
leadTtl ? ok('Lead has a TTL index') : bad('Lead missing TTL');
const auditTtl = M.AuditLog.schema.indexes().some(([, opt]) => opt?.expireAfterSeconds);
auditTtl ? ok('AuditLog has a TTL index') : bad('AuditLog missing TTL');

console.log(`\n${'='.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);
