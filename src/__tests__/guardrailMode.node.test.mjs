/**
 * Node test for how the server describes its own guardrail state (utils/guardrailMode.ts).
 *
 * Imports the COMPILED module from dist (CI runs `npm run build` before `npm test`), matching the
 * other .node.test.mjs files here.
 *
 * The hole: the mode line, /health and the stdio banner were all derived from the GTM flags alone.
 * ga4WritesEnabled / ga4DeletesEnabled were populated by getGuardrailConfig() and read nowhere outside
 * enforcement, so GA4_MCP_ENABLE_DELETES=true produced "READ-ONLY (writes disabled), PUBLISH DISABLED,
 * DELETES DISABLED" while ga4_delete_account was registered and callable.
 *
 * NOTE ON WHAT THIS FILE PROVES: this module did not exist before the fix, so nothing here can fail
 * against pre-fix code. It is a contract lock for the flag matrix. The pre-fix gate lives in
 * serverInstructions.node.test.mjs, which asserts on the string a real server hands the model.
 *
 * Run: node src/__tests__/guardrailMode.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/utils/guardrailMode.js');
if (!existsSync(distPath)) {
  console.error(`\n✗ guardrailMode test: ${distPath} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { describeMode, guardrailStatus, guardrailBanner, isReadOnly } = await import(
  pathToFileURL(distPath).href
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

const OFF = {
  writesEnabled: false,
  publishEnabled: false,
  deletesEnabled: false,
  ga4WritesEnabled: false,
  ga4DeletesEnabled: false,
  dryRun: false,
};
const GA4_DELETES = { ...OFF, ga4DeletesEnabled: true };
const GA4_WRITES = { ...OFF, ga4WritesEnabled: true };
const GTM_DELETES = { ...OFF, deletesEnabled: true };
const GTM_PUBLISH = { ...OFF, publishEnabled: true };

const FLAGS = [
  'writesEnabled',
  'publishEnabled',
  'deletesEnabled',
  'ga4WritesEnabled',
  'ga4DeletesEnabled',
];

console.log('\nguardrailMode: describeMode');

test('a fully locked-down server leads with READ-ONLY and names both products', () => {
  const m = describeMode(OFF);
  assert.match(m, /READ-ONLY/);
  assert.match(m, /GTM/);
  assert.match(m, /GA4/);
});

test('GA4 deletes on means the server is NOT read-only, and says which gate is open', () => {
  const m = describeMode(GA4_DELETES);
  assert.ok(!/READ-ONLY/i.test(m), `must not claim read-only: ${m}`);
  assert.match(m, /GA4 DELETES ENABLED/);
});

test('GA4 writes on means the server is NOT read-only', () => {
  const m = describeMode(GA4_WRITES);
  assert.ok(!/READ-ONLY/i.test(m), `must not claim read-only: ${m}`);
  assert.match(m, /GA4 WRITES ENABLED/);
});

test('GTM deletes on, with writes off, is not read-only either', () => {
  // The sub-case the original report missed: READ-ONLY used to key off writesEnabled alone, so a
  // delete-enabled GTM server also described itself as read-only.
  const m = describeMode(GTM_DELETES);
  assert.ok(!/READ-ONLY/i.test(m), `must not claim read-only: ${m}`);
  assert.match(m, /GTM DELETES ENABLED/);
});

test('GTM publish on, with writes off, is not read-only either', () => {
  const m = describeMode(GTM_PUBLISH);
  assert.ok(!/READ-ONLY/i.test(m), `must not claim read-only: ${m}`);
  assert.match(m, /GTM PUBLISH ENABLED/);
});

test('across all 32 flag combinations, the word READ-ONLY appears iff isReadOnly()', () => {
  // Couples the prose to the predicate. Deliberately NOT also asserting isReadOnly() equals
  // !(w||p||d||g4w||g4d): that is the function body restated, and can only catch a typo.
  for (let mask = 0; mask < 32; mask++) {
    const c = { ...OFF };
    FLAGS.forEach((f, i) => {
      c[f] = Boolean(mask & (1 << i));
    });
    assert.strictEqual(
      /READ-ONLY/.test(describeMode(c)),
      isReadOnly(c),
      `mask ${mask}: ${describeMode(c)}`
    );
  }
});

test('DRY RUN MODE is appended in both the read-only and the mixed branch', () => {
  assert.match(describeMode({ ...OFF, dryRun: true }), /READ-ONLY.*DRY RUN MODE/);
  assert.match(describeMode({ ...GA4_DELETES, dryRun: true }), /GA4 DELETES ENABLED.*DRY RUN MODE/);
});

test('dryRun alone does NOT make a write-enabled server read-only', () => {
  // Deliberate: a dry-run server still exposes the write tools and still accepts the calls. Folding
  // dryRun into isReadOnly would recreate the same class of lie. Do not "fix" this.
  assert.strictEqual(isReadOnly({ ...OFF, writesEnabled: true, dryRun: true }), false);
});

test('no em dash reaches the mode line', () => {
  assert.ok(!describeMode(GA4_DELETES).includes('—'));
  assert.ok(!describeMode(OFF).includes('—'));
});

console.log('\nguardrailMode: guardrailStatus');

test('status reports GA4 gates and a derived readOnly', () => {
  const s = guardrailStatus(GA4_DELETES);
  assert.strictEqual(s.readOnly, false);
  assert.strictEqual(s.ga4DeletesEnabled, true);
  assert.strictEqual(s.ga4WritesEnabled, false);
  assert.strictEqual(guardrailStatus(OFF).readOnly, true);
});

test('the four keys /health already published keep their names and meanings', () => {
  // /health consumers predate this change. The object is additive, never renaming.
  const s = guardrailStatus({ ...OFF, writesEnabled: true, dryRun: true });
  assert.ok('writesEnabled' in s && 'publishEnabled' in s && 'deletesEnabled' in s && 'dryRun' in s);
  assert.strictEqual(s.writesEnabled, true);
  assert.strictEqual(s.publishEnabled, false);
  assert.strictEqual(s.dryRun, true);
});

console.log('\nguardrailMode: guardrailBanner');

test('the banner carries the GA4 gates and the readOnly verdict', () => {
  assert.match(guardrailBanner(GA4_DELETES), /ga4Deletes=true/);
  assert.match(guardrailBanner(GA4_DELETES), /readOnly=false/);
  assert.match(guardrailBanner(OFF), /readOnly=true/);
});

test('REGRESSION: the banner prints parsed booleans, never a raw env string', () => {
  // The old banner did `process.env.GTM_MCP_ENABLE_WRITES ?? 'false'`, so GTM_MCP_ENABLE_WRITES=1
  // printed "writes=1" while the gate (=== 'true') read false and /health said the opposite.
  // Case-sensitive so it does not accidentally match ga4Writes=.
  for (const c of [OFF, GA4_DELETES, { ...OFF, writesEnabled: true }]) {
    const b = guardrailBanner(c);
    assert.ok(!/(?<![a-zA-Z0-9])writes=(?!true|false)/.test(b), `raw value in banner: ${b}`);
    assert.ok(!/deletes=(?!true|false)/.test(b), `raw value in banner: ${b}`);
  }
});

console.log(`\nguardrailMode: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
