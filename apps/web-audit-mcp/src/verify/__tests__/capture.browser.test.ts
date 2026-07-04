/**
 * End-to-end capture + assertion against offline HTML fixtures, in real
 * Chromium. Proves POST-batched GA4 capture, the settle window, two-phase
 * consent, journey interaction, and the linker probe. SELF-SKIPS when Playwright
 * is not installed, so the offline `npm test` stays green.
 *
 * Run (after `npx playwright install chromium`):
 *   tsx apps/web-audit-mcp/src/verify/__tests__/capture.browser.test.ts
 */

import { loadPlaywright } from '../../agent/browser.js';
import { runCapture } from '../capture/capture.js';
import { runAssertions } from '../assert/engine.js';
import { fixtureProvider, fixtureUrl } from '../fixtures/pages.js';
import type { CheckResult, VerifySpec } from '../types.js';
import { harness } from './_helpers.js';

const { check, done } = harness('capture.browser');

const pw = await loadPlaywright();
if (!pw) {
  // eslint-disable-next-line no-console
  console.log('capture.browser: SKIPPED — playwright/chromium not installed (offline suites cover the logic)');
  process.exit(0);
}

const provider = fixtureProvider();
const baseOpts = {
  headless: true,
  navTimeoutMs: 15_000,
  settle: { quietMs: 200, maxMs: 2500 },
  allowlist: [] as string[],
  fixtures: provider,
};

const browser = await pw.chromium.launch({ headless: true });
const statusById = (results: CheckResult[], id: string): string | undefined => results.find((r) => r.id === id)?.status;

try {
  // ── clean: everything Pass (incl. POST-batched events + linker) ──────────────
  const cleanSpec: VerifySpec = {
    url: fixtureUrl('/clean'),
    measurementIds: ['G-CLEAN'],
    expectedTrackers: ['ga4', 'clarity'],
    checks: [
      { id: 'pv', type: 'event_fired', event: 'page_view', params: { 'ep.page_type': 'home' } },
      { id: 'vi', type: 'event_fired', event: 'view_item' },
      { id: 'atc', type: 'event_fired', event: 'add_to_cart' },
      { id: 'cta', type: 'event_on_interaction', event: 'cta_click', action: { click: '#hero' } },
      { id: 'clr', type: 'tracker_present', tracker: 'clarity' },
      { id: 'g4', type: 'tracker_present', tracker: 'ga4' },
      { id: 'ln', type: 'cross_domain_linker', expectedDomains: ['shop.example.com'] },
    ],
  };
  const clean = runAssertions(await runCapture(browser, cleanSpec, baseOpts), cleanSpec);
  check('clean: page_view Pass', statusById(clean, 'pv') === 'Pass', statusById(clean, 'pv'));
  check('clean: view_item Pass (POST batched)', statusById(clean, 'vi') === 'Pass', statusById(clean, 'vi'));
  check('clean: add_to_cart Pass (POST batched)', statusById(clean, 'atc') === 'Pass', statusById(clean, 'atc'));
  check('clean: cta_click Pass (interaction)', statusById(clean, 'cta') === 'Pass', statusById(clean, 'cta'));
  check('clean: clarity present Pass', statusById(clean, 'clr') === 'Pass', statusById(clean, 'clr'));
  check('clean: ga4 present Pass', statusById(clean, 'g4') === 'Pass', statusById(clean, 'g4'));
  check('clean: linker Pass', statusById(clean, 'ln') === 'Pass', statusById(clean, 'ln'));

  // ── missing tracker ──────────────────────────────────────────────────────────
  const mtSpec: VerifySpec = {
    url: fixtureUrl('/missing-tracker'),
    measurementIds: ['G-MT'],
    checks: [
      { id: 'clr', type: 'tracker_present', tracker: 'clarity' },
      { id: 'pv', type: 'event_fired', event: 'page_view' },
    ],
  };
  const mt = runAssertions(await runCapture(browser, mtSpec, baseOpts), mtSpec);
  check('missing-tracker: clarity Fail', statusById(mt, 'clr') === 'Fail', statusById(mt, 'clr'));
  check('missing-tracker: page_view still Pass', statusById(mt, 'pv') === 'Pass', statusById(mt, 'pv'));

  // ── wrong param → Partial ──────────────────────────────────────────────────────
  const wpSpec: VerifySpec = {
    url: fixtureUrl('/wrong-param'),
    measurementIds: ['G-WP'],
    checks: [{ id: 'pv', type: 'param_validation', event: 'page_view', params: { 'ep.page_type': 'home' } }],
  };
  const wp = runAssertions(await runCapture(browser, wpSpec, baseOpts), wpSpec);
  check('wrong-param: Partial', statusById(wp, 'pv') === 'Partial', statusById(wp, 'pv'));

  // ── duplicate → Fail ────────────────────────────────────────────────────────────
  const dupSpec: VerifySpec = {
    url: fixtureUrl('/duplicate'),
    measurementIds: ['G-DUP'],
    checks: [{ id: 'd', type: 'duplicate_event', event: 'purchase' }],
  };
  const dup = runAssertions(await runCapture(browser, dupSpec, baseOpts), dupSpec);
  check('duplicate: Fail', statusById(dup, 'd') === 'Fail', statusById(dup, 'd'));

  // ── pre-consent firing → consent_mode Fail ──────────────────────────────────────
  const pcSpec: VerifySpec = {
    url: fixtureUrl('/pre-consent'),
    measurementIds: ['G-PC'],
    consent: { acceptSelector: '#cmp-accept', checkPreConsent: true },
    checks: [{ id: 'cm', type: 'consent_mode' }],
  };
  const pc = runAssertions(await runCapture(browser, pcSpec, baseOpts), pcSpec);
  check('pre-consent: consent_mode Fail', statusById(pc, 'cm') === 'Fail', statusById(pc, 'cm'));

  // ── missing _gl → linker Fail ────────────────────────────────────────────────────
  const mgSpec: VerifySpec = {
    url: fixtureUrl('/missing-gl'),
    checks: [{ id: 'ln', type: 'cross_domain_linker', expectedDomains: ['shop.example.com'] }],
  };
  const mg = runAssertions(await runCapture(browser, mgSpec, baseOpts), mgSpec);
  check('missing-gl: linker Fail', statusById(mg, 'ln') === 'Fail', statusById(mg, 'ln'));
} finally {
  await browser.close();
}

done(13);
