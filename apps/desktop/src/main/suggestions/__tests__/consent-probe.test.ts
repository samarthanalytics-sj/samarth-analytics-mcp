import assert from 'node:assert/strict';
import { parseGa4CollectHit } from '../consent-probe';

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

console.log('\nconsent probe (hit classifier):');

test('classifies GA4 collect hits and extracts the gcs consent parameter', () => {
  const hit = parseGa4CollectHit('https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&gcs=G111&dl=https%3A%2F%2Fshop.example%2F');
  assert.equal(hit.isCollect, true);
  assert.equal(hit.gcs, 'G111', 'gcs extracted');

  const denied = parseGa4CollectHit('https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&gcs=G100');
  assert.equal(denied.isCollect, true, 'region1 collect endpoint recognised');
  assert.equal(denied.gcs, 'G100');

  const noConsent = parseGa4CollectHit('https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2');
  assert.equal(noConsent.isCollect, true);
  assert.equal(noConsent.gcs, null, 'a hit without gcs reads null, never a fake value');
});

test('non-collect traffic is never classified as a hit', () => {
  for (const u of [
    'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
    'https://shop.example/collect?utm_source=x', // same path on a NON-Google host
    'https://fonts.googleapis.com/css2?family=Inter',
    'not a url at all',
  ]) {
    assert.equal(parseGa4CollectHit(u).isCollect, false, u);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
