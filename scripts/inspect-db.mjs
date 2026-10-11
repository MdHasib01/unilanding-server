/**
 * Confirms the unilanding database is populated and separate, and that the
 * milkimom database on the same cluster was not touched.
 * Run: node inspect-db.mjs
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
const admin = mongoose.connection.db.admin();

const { databases } = await admin.listDatabases();
console.log('\n=== Databases on the cluster ===');
for (const d of databases) {
  const mark = d.name === 'unilanding' ? '  <-- ours' : d.name === 'milkimom' ? '  <-- milkimom (must be untouched)' : '';
  console.log(`  ${d.name.padEnd(22)} ${String(d.sizeOnDisk ?? 0).padStart(12)} bytes${mark}`);
}

console.log('\n=== unilanding collections ===');
const ours = mongoose.connection.useDb('unilanding');
const cols = await ours.db.listCollections().toArray();
if (cols.length === 0) console.log('  (none)');
for (const c of cols.sort((a, b) => a.name.localeCompare(b.name))) {
  const count = await ours.db.collection(c.name).countDocuments();
  const idx = await ours.db.collection(c.name).indexes();
  console.log(`  ${c.name.padEnd(16)} ${String(count).padStart(4)} doc(s)`);
  for (const i of idx) {
    const flags = [
      i.unique ? 'unique' : null,
      i.partialFilterExpression ? `partial(${JSON.stringify(i.partialFilterExpression)})` : null,
      i.expireAfterSeconds !== undefined ? `ttl=${i.expireAfterSeconds}s` : null,
    ].filter(Boolean);
    console.log(`      - ${JSON.stringify(i.key)}${flags.length ? '  [' + flags.join(', ') + ']' : ''}`);
  }
}

console.log('\n=== milkimom collections (read-only check) ===');
const theirs = mongoose.connection.useDb('milkimom');
const theirCols = await theirs.db.listCollections().toArray();
console.log(`  ${theirCols.length} collection(s): ${theirCols.map((c) => c.name).sort().join(', ') || '(none)'}`);
const overlap = theirCols.map((c) => c.name).filter((n) => cols.some((c) => c.name === n));
console.log(`  shared collection NAMES (expected, different databases): ${overlap.join(', ') || '(none)'}`);

await mongoose.disconnect();
process.exit(0);
