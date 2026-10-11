/**
 * Runs every verification suite in order and reports a single result.
 *
 * verify-e2e needs both servers up (API on :5000, `next start` on :3000); it is
 * skipped with a clear message rather than failing the run if the web tier is
 * not reachable.
 *
 * Run: npm test
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  { file: 'verify-models.mjs', name: 'Data model & tenant isolation', needsWeb: false },
  { file: 'verify-auth.mjs', name: 'Authentication & sessions', needsWeb: false },
  { file: 'verify-platform.mjs', name: 'Platform API & provisioning', needsWeb: false },
  { file: 'verify-localhost.mjs', name: 'Zero-setup localhost', needsWeb: true },
  { file: 'verify-dashboard.mjs', name: 'Platform dashboard (browser flow)', needsWeb: true },
  { file: 'verify-e2e.mjs', name: 'End to end (API + Next + Atlas)', needsWeb: true },
];

const webUp = await fetch('http://127.0.0.1:3000/api/health', {
  signal: AbortSignal.timeout(2500),
})
  .then((r) => r.ok)
  .catch(() => false);

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    // pino writes the suite's own request logs to stderr; captured but not printed.
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const m = out.match(/(\d+) passed, (\d+) failed/);
      resolve({
        code,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
        // Anchored: a plain includes('FAIL') also matched log lines such as
        // code: "CSRF_FAILED", which are expected assertions passing.
        failures: out.split('\n').filter((l) => /^\s*FAIL\s\s/.test(l)),
      });
    });
  });

let totalPassed = 0;
let totalFailed = 0;
let skipped = 0;

console.log('');
for (const suite of SUITES) {
  if (suite.needsWeb && !webUp) {
    console.log(`  SKIP  ${suite.name.padEnd(34)} (needs \`next start\` on :3000)`);
    skipped += 1;
    continue;
  }
  process.stdout.write(`        ${suite.name.padEnd(34)} …`);
  const r = await run(suite.file);
  totalPassed += r.passed;
  totalFailed += r.failed;
  process.stdout.write(
    `\r  ${r.failed === 0 && r.code === 0 ? ' OK ' : 'FAIL'}  ${suite.name.padEnd(34)} ${r.passed} passed` +
      (r.failed ? `, ${r.failed} failed` : '') +
      '\n'
  );
  for (const f of r.failures) console.log(`          ${f.trim()}`);
}

console.log(`\n  ${'─'.repeat(54)}`);
console.log(`  ${totalPassed} passed, ${totalFailed} failed${skipped ? `, ${skipped} suite(s) skipped` : ''}`);
console.log(`  ${'─'.repeat(54)}\n`);

process.exit(totalFailed > 0 ? 1 : 0);
