// The DOM-output -> sightings seam of phone detection. No browser: sightingsFromPage is pure given
// a driver's page output, which is the whole point of keeping the I/O in scanUrlsForPhones.
// Run: tsx apps/desktop/src/main/suggestions/__tests__/scan-phones.test.ts

import assert from 'node:assert/strict';
import { sightingsFromPage } from '../scan-phones';
import { mergePhoneSightings } from '../../../shared/phone-numbers';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  x    ${name}: ${(e as Error).message}`); failed++; }
}

console.log('\nPhone scan (DOM output -> sightings):');

test('tel: anchors become clickable sightings carrying their label and region', () => {
  const { sightings } = sightingsFromPage({
    raw: {
      elements: [
        { href: 'tel:+15551234567', text: 'Call sales', region: 'header' },
        { href: 'https://example.com/about', text: 'About' },
        { href: 'mailto:hi@example.com', text: 'Email' },
      ],
    },
  }, 'https://example.com/');
  assert.equal(sightings.length, 1, 'only the tel: link is a phone');
  assert.equal(sightings[0].source, 'tel_link');
  assert.equal(sightings[0].label, 'Call sales');
  assert.equal(sightings[0].region, 'header');
  assert.equal(sightings[0].page, 'https://example.com/');
});

test('visible text yields text sightings, and the flag says text was readable', () => {
  const { sightings, hadText } = sightingsFromPage({
    raw: { elements: [], textSample: 'Questions? Call (555) 987-6543 or +44 20 7946 0958.' },
  }, '/contact');
  assert.equal(hadText, true);
  assert.equal(sightings.length, 2);
  assert.ok(sightings.every((s) => s.source === 'text'));
});

test('a page with NO text sample reports it, so "none found" is never mistaken for "none exist"', () => {
  const { sightings, hadText } = sightingsFromPage({ raw: { elements: [] } }, '/x');
  assert.equal(hadText, false);
  assert.equal(sightings.length, 0);
});

test('a page that produced no raw output at all degrades to nothing, never a throw', () => {
  const { sightings, hadText } = sightingsFromPage({}, '/x');
  assert.equal(sightings.length, 0);
  assert.equal(hadText, false);
});

test('the same number as a link AND as text on one page merges to ONE clickable entry', () => {
  const { sightings } = sightingsFromPage({
    raw: {
      elements: [{ href: 'tel:+15551234567', text: 'Call us' }],
      textSample: 'Reach us on +1 (555) 123-4567 any time.',
    },
  }, '/contact');
  assert.equal(sightings.length, 2, 'both sightings are recorded');
  const merged = mergePhoneSightings(sightings);
  assert.equal(merged.length, 1, 'but they are ONE number');
  assert.equal(merged[0].clickable, true, 'and it is clickable because of the link');
  assert.equal(merged[0].occurrences, 2);
});

test('numbers merge ACROSS pages, keeping every page they were seen on', () => {
  const a = sightingsFromPage({ raw: { elements: [{ href: 'tel:+15551234567', text: 'Call' }] } }, '/a');
  const b = sightingsFromPage({ raw: { elements: [{ href: 'tel:+1-555-123-4567', text: 'Call' }] } }, '/b');
  const merged = mergePhoneSightings([...a.sightings, ...b.sightings]);
  assert.equal(merged.length, 1, 'one line, two pages');
  assert.deepEqual(merged[0].pages, ['/a', '/b']);
  assert.equal(merged[0].occurrences, 2);
});

test('page prose that only LOOKS numeric does not become a phone number', () => {
  const { sightings } = sightingsFromPage({
    raw: { elements: [], textSample: 'Order 12345678 placed 2026-07-24 for $1,299.00, up 12.5% year on year.' },
  }, '/order');
  assert.equal(mergePhoneSightings(sightings).length, 0, JSON.stringify(sightings));
});

console.log(`\nscan-phones: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
