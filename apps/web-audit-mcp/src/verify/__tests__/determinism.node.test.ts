/**
 * Determinism harness — run the pure pipeline (assert + report) 5 times over a
 * FIXED capture and assert the verdicts are byte-for-byte identical across runs.
 * This is the guarantee that makes the engine's output trustworthy.
 * Run: tsx apps/web-audit-mcp/src/verify/__tests__/determinism.node.test.ts
 */

import { reportFromCapture } from '../index.js';
import { runAssertions } from '../assert/engine.js';
import { specHash } from '../spec-schema.js';
import type { VerifySpec } from '../types.js';
import { harness, capture, hit, tracker, action, consentEvent } from './_helpers.js';

const { check, done } = harness('determinism');

const rawSpec = {
  url: 'https://example.test/',
  measurementIds: ['G-1'],
  expectedTrackers: ['ga4', 'clarity'],
  consent: { acceptSelector: '#ok', checkPreConsent: true },
  checks: [
    { id: 'pv', type: 'event_fired', event: 'page_view', phase: 'post_consent', params: { 'ep.page_type': 'home' } },
    { id: 'pur', type: 'param_validation', event: 'purchase', params: { 'epn.value': 9.99 } },
    { id: 'cta', type: 'event_on_interaction', event: 'cta_click', action: { click: '#hero' } },
    { id: 'cm', type: 'consent_mode', expectedDefault: { analytics_storage: 'denied' } },
    { id: 'dup', type: 'duplicate_event', event: 'purchase' },
    { id: 'clr', type: 'tracker_present', tracker: 'clarity' },
    { id: 'ln', type: 'cross_domain_linker', expectedDomains: ['shop.example.com'] },
  ],
};

const fixedCapture = capture({
  consentActionTMs: 1000,
  consentAction: { action: 'accept', clicked: true, atTMs: 1000 },
  consentEvents: [consentEvent({ kind: 'default', fields: { analytics_storage: 'denied', ad_storage: 'denied' } })],
  ga4Hits: [
    hit({ en: 'page_view', tid: 'G-1', gcs: 'G100', tRelativeMs: 500 }),
    // Pre-consent hit that leaked with analytics_storage granted → a real violation.
    hit({ en: 'ad_impression', tid: 'G-1', gcs: 'G111', tRelativeMs: 400 }),
    hit({ en: 'page_view', tid: 'G-1', params: { 'ep.page_type': 'home' }, gcs: 'G111', tRelativeMs: 1500 }),
    hit({ en: 'purchase', tid: 'G-1', params: { 'epn.value': '9.99' }, tRelativeMs: 1800 }),
    hit({ en: 'cta_click', tid: 'G-1', tRelativeMs: 2200 }),
  ],
  trackers: [tracker({ vendor: 'clarity', domain: 'www.clarity.ms', tRelativeMs: 700 })],
  actions: [action({ checkId: 'cta', kind: 'click', atTMs: 2000 })],
});

// Baseline
const baseSpec = rawSpec as unknown as VerifySpec;
const baseline = JSON.stringify(runAssertions(fixedCapture, baseSpec).map((c) => ({ id: c.id, status: c.status })));
const baselineReport = JSON.stringify(stripTimings(reportFromCapture(rawSpec, fixedCapture)));

let allIdentical = true;
for (let i = 0; i < 5; i += 1) {
  const runStatuses = JSON.stringify(runAssertions(fixedCapture, baseSpec).map((c) => ({ id: c.id, status: c.status })));
  if (runStatuses !== baseline) allIdentical = false;
  const runReport = JSON.stringify(stripTimings(reportFromCapture(rawSpec, fixedCapture)));
  if (runReport !== baselineReport) allIdentical = false;
}
check('5 runs → identical verdicts + report', allIdentical);

// specHash is stable across runs
check('specHash stable across 5 runs', new Set(Array.from({ length: 5 }, () => specHash(rawSpec))).size === 1);

// The fixture exercises a real mix of statuses (not all trivially Pass)
const rep = reportFromCapture(rawSpec, fixedCapture);
const statuses = new Set(rep.checks.map((c) => c.status));
check('fixture yields a Fail somewhere (pre-consent granted hit)', rep.checks.find((c) => c.id === 'cm')?.status === 'Fail');
check('fixture yields at least one Pass', statuses.has('Pass'));

/** Report timings are informational; verdicts are what must be stable. */
function stripTimings(report: ReturnType<typeof reportFromCapture>): unknown {
  return {
    ...report,
    checks: report.checks.map((c) => ({ id: c.id, type: c.type, status: c.status, reason: c.reason ?? null })),
  };
}

done(4);
