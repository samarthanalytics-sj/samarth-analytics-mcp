import assert from 'node:assert/strict';
import { dateContextLine, GTM_AUDIT_METHODOLOGY } from '../chat-service';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nChat system prompt — current date:');

test('dateContextLine states the real date as ISO + human and tells the model to ignore training-date', () => {
  // Construct with local components so getFullYear/Month/Date are deterministic.
  const line = dateContextLine(new Date(2026, 5, 19)); // June 19, 2026
  assert.ok(line.includes('2026-06-19'), 'ISO date present');
  assert.ok(line.includes('June 19, 2026'), 'human date present');
  assert.ok(/IGNORE any date from your training data/i.test(line), 'instructs to ignore training date');
  assert.ok(/only dates AFTER today are "in the future"/i.test(line), 'frames future correctly');
});

test('pads single-digit month/day to a valid ISO date', () => {
  const line = dateContextLine(new Date(2026, 0, 5)); // Jan 5, 2026
  assert.ok(line.includes('2026-01-05'), 'zero-padded ISO');
  assert.ok(!line.includes('2026-1-5'));
});

test('GTM_AUDIT_METHODOLOGY carries the Audit-Brain essentials', () => {
  const m = GTM_AUDIT_METHODOLOGY;
  assert.ok(/audit_gtm_container FIRST/i.test(m), 'calls the deterministic audit first');
  assert.ok(/boundary statement/i.test(m) && /runtime verification/i.test(m), 'has the container-only boundary statement');
  assert.ok(/\[Certain\]/.test(m) && /\[Likely\]/.test(m) && /runtime-required/i.test(m), 'has the three confidence levels');
  assert.ok(/Hygiene[\s\S]*NEVER leads/i.test(m), 'orders by impact — hygiene never leads');
  assert.ok(/denied consent signal correctly BLOCKING a tag is correct/i.test(m), 'has the denied-pass false-positive guard');
  assert.ok(/ad_user_data/.test(m) && /ad_personalization/.test(m), 'names the four Consent Mode v2 signals');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
