import assert from 'node:assert/strict';
import { applyScan, shouldAlert, summarizeChanges, TIMELINE_CAP, type TagWatchTarget } from '../tag-watch-core';
import type { GtagSpySnapshot } from '../gtag-spy';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}

const snap = (over: Partial<GtagSpySnapshot> = {}): GtagSpySnapshot => ({
  measurementId: 'G-T', parsed: true, destinations: ['G-T'], autoEvents: null, siteSearchParams: 'q',
  keyEvents: ['purchase'], userData: null, redactEmail: true, googleSignalsDisallowedEverywhere: false,
  serverContainerUrl: null, sessionDurationSec: 0, linkerDomains: [], tagFunctions: ['__gct'], ...over,
});
const fresh = (): TagWatchTarget => ({ measurementId: 'G-T', lastSnapshot: null, timeline: [], lastScanAt: null, lastParsed: false });

console.log('\ntag-watch-core:');

test('first parseable scan captures a baseline (no alert) and one timeline row', () => {
  const { target, event } = applyScan(fresh(), { snapshot: snap() }, 1000);
  assert.equal(event.kind, 'first_scan');
  assert.equal(shouldAlert(event), false);
  assert.equal(target.lastSnapshot?.measurementId, 'G-T');
  assert.equal(target.timeline.length, 1);
  assert.equal(target.lastParsed, true);
});

test('a real config change alerts, records before/after, and adds a timeline row', () => {
  const base = applyScan(fresh(), { snapshot: snap() }, 1000).target;
  const { target, event } = applyScan(base, { snapshot: snap({ keyEvents: ['purchase', 'form_start'], redactEmail: false }) }, 2000);
  assert.equal(event.kind, 'changed');
  assert.ok(event.changes.length >= 2);
  assert.equal(shouldAlert(event), true);
  const ke = event.changes.find((c) => c.field === 'key events')!;
  assert.equal(ke.after, 'purchase, form_start');
  assert.equal(target.timeline.length, 2, 'baseline + the change');
});

test('a clean no-change scan advances the baseline time but adds NO row and NO alert', () => {
  const base = applyScan(fresh(), { snapshot: snap() }, 1000).target;
  const { target, event } = applyScan(base, { snapshot: snap() }, 5000);
  assert.equal(event.changes.length, 0);
  assert.equal(shouldAlert(event), false);
  assert.equal(target.timeline.length, 1, 'no noise row for an unchanged scan');
  assert.equal(target.lastScanAt, 5000, 'time still advances');
});

test('going unparsed alerts once; recovery with no change is a quiet reparsed note', () => {
  const base = applyScan(fresh(), { snapshot: snap() }, 1000).target;
  const gone = applyScan(base, { snapshot: snap({ parsed: false }) }, 2000);
  assert.equal(gone.event.kind, 'unparsed_now');
  assert.equal(shouldAlert(gone.event), true);
  assert.equal(gone.target.lastParsed, false);
  assert.equal(gone.target.lastSnapshot?.measurementId, 'G-T', 'baseline is preserved, not wiped');
  const back = applyScan(gone.target, { snapshot: snap() }, 3000);
  assert.equal(back.event.kind, 'reparsed');
  assert.equal(shouldAlert(back.event), false);
});

test('a fetch error is a scan_error row, never a fabricated change', () => {
  const { target, event } = applyScan(fresh(), { snapshot: null, error: 'HTTP 503' }, 1000);
  assert.equal(event.kind, 'scan_error');
  assert.ok(event.summary.includes('503'));
  assert.equal(shouldAlert(event), false);
  assert.equal(target.lastSnapshot, null);
});

test('timeline is capped newest-first', () => {
  let t = fresh();
  for (let i = 0; i < TIMELINE_CAP + 10; i++) {
    t = applyScan(t, { snapshot: null, error: `err ${i}` }, i).target;
  }
  assert.equal(t.timeline.length, TIMELINE_CAP);
  assert.equal(t.timeline[0].at, TIMELINE_CAP + 9, 'newest first');
});

test('summarizeChanges leads with field names and caps at 3 + more', () => {
  const s = summarizeChanges([
    { field: 'key events', before: 'a', after: 'b' },
    { field: 'site-search params', before: 'q', after: 'x' },
    { field: 'email redaction', before: 'true', after: 'false' },
    { field: 'destinations', before: 'x', after: 'y' },
  ]);
  assert.ok(s.startsWith('4 changes: key events, site-search params, email redaction'));
  assert.ok(s.includes('+1 more'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
