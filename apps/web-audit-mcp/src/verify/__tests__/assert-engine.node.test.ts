/**
 * Assertion-engine suite — positive + negative for all 7 checks, entirely
 * offline (hand-built CaptureResult objects). This is the mandatory correctness
 * proof; no browser required.
 * Run: tsx apps/web-audit-mcp/src/verify/__tests__/assert-engine.node.test.ts
 */

import { runCheck } from '../assert/engine.js';
import type { CheckSpec, Status, VerifySpec } from '../types.js';
import { harness, capture, hit, tracker, action, consentEvent } from './_helpers.js';

const { check, done } = harness('assert-engine');

function statusOf(cap: ReturnType<typeof capture>, spec: VerifySpec, chk: CheckSpec): Status {
  return runCheck(cap, spec, chk).status;
}
const spec = (checks: CheckSpec[], extra: Partial<VerifySpec> = {}): VerifySpec => ({ url: 'https://example.test/', checks, ...extra });

// ── global: page not loaded → Not Verified ─────────────────────────────────────
{
  const chk: CheckSpec = { id: 'a', type: 'event_fired', event: 'page_view' };
  check('not-loaded → Not Verified', statusOf(capture({ loaded: false }), spec([chk]), chk) === 'Not Verified');
}

// ── event_fired ────────────────────────────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'pv', type: 'event_fired', event: 'page_view' };
  const s = spec([chk], { measurementIds: ['G-1'] });
  check('event_fired Pass', statusOf(capture({ ga4Hits: [hit({ en: 'page_view', tid: 'G-1' })] }), s, chk) === 'Pass');
  check('event_fired Fail (no hit, gtm present)', statusOf(capture({ ga4Hits: [] }), s, chk) === 'Fail');
  check('event_fired Not Verified (no hit, no gtm)', statusOf(capture({ ga4Hits: [], gtmPresent: false }), s, chk) === 'Not Verified');
  check('event_fired Fail (tid mismatch)', statusOf(capture({ ga4Hits: [hit({ en: 'page_view', tid: 'G-2' })] }), s, chk) === 'Fail');
  check('event_fired Pass (no tid constraint)', statusOf(capture({ ga4Hits: [hit({ en: 'page_view', tid: 'G-2' })] }), spec([chk]), chk) === 'Pass');
}
{
  const chk: CheckSpec = { id: 'pv', type: 'event_fired', event: 'page_view', params: { 'ep.page_type': 'home' } };
  const s = spec([chk]);
  check('event_fired+params Pass', statusOf(capture({ ga4Hits: [hit({ en: 'page_view', params: { 'ep.page_type': 'home' } })] }), s, chk) === 'Pass');
  check('event_fired+params Partial (wrong value)', statusOf(capture({ ga4Hits: [hit({ en: 'page_view', params: { 'ep.page_type': 'blog' } })] }), s, chk) === 'Partial');
  check('event_fired+params Partial (missing)', statusOf(capture({ ga4Hits: [hit({ en: 'page_view', params: {} })] }), s, chk) === 'Partial');
}

// ── param_validation (incl. numeric epn) ────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'pval', type: 'param_validation', event: 'purchase', params: { 'epn.value': 9.99, 'ep.currency': 'USD' } };
  const s = spec([chk]);
  check('param_validation Pass (numeric match)', statusOf(capture({ ga4Hits: [hit({ en: 'purchase', params: { 'epn.value': '9.99', 'ep.currency': 'USD' } })] }), s, chk) === 'Pass');
  check('param_validation Partial (numeric mismatch)', statusOf(capture({ ga4Hits: [hit({ en: 'purchase', params: { 'epn.value': '9.98', 'ep.currency': 'USD' } })] }), s, chk) === 'Partial');
  check('param_validation Fail (event never fired)', statusOf(capture({ ga4Hits: [] }), s, chk) === 'Fail');
}
{
  const chk: CheckSpec = { id: 'pres', type: 'param_validation', event: 'sign_up', params: { 'ep.method': true } };
  check('param_validation present Pass', statusOf(capture({ ga4Hits: [hit({ en: 'sign_up', params: { 'ep.method': 'google' } })] }), spec([chk]), chk) === 'Pass');
  check('param_validation present Partial (absent)', statusOf(capture({ ga4Hits: [hit({ en: 'sign_up', params: {} })] }), spec([chk]), chk) === 'Partial');
}

// ── event_on_interaction ─────────────────────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'cta', type: 'event_on_interaction', event: 'cta_click', action: { click: '#hero' } };
  const s = spec([chk]);
  const acted = capture({ actions: [action({ checkId: 'cta', atTMs: 500 })], ga4Hits: [hit({ en: 'cta_click', tRelativeMs: 600 })] });
  check('event_on_interaction Pass', statusOf(acted, s, chk) === 'Pass');
  check('event_on_interaction Fail (selector not found)', statusOf(capture({ actions: [action({ checkId: 'cta', selectorFound: false, performed: false })] }), s, chk) === 'Fail');
  check('event_on_interaction Fail (hit before action)', statusOf(capture({ actions: [action({ checkId: 'cta', atTMs: 500 })], ga4Hits: [hit({ en: 'cta_click', tRelativeMs: 100 })] }), s, chk) === 'Fail');
  check('event_on_interaction Not Verified (step not run)', statusOf(capture({ actions: [] }), s, chk) === 'Not Verified');
}

// ── consent_mode ───────────────────────────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'cm', type: 'consent_mode' };
  const s = spec([chk], { consent: { acceptSelector: '#ok', checkPreConsent: true } });
  // pre-consent hit with analytics granted → Fail (sub-check a)
  const bad = capture({ consentActionTMs: 1000, consentAction: { action: 'accept', clicked: true, atTMs: 1000 }, ga4Hits: [hit({ en: 'page_view', gcs: 'G111', tRelativeMs: 500 })] });
  check('consent_mode Fail (pre-consent firing granted)', statusOf(bad, s, chk) === 'Fail');
  // pre-consent hit but cookieless (denied) + no tracking cookies → Pass
  const okPre = capture({ consentActionTMs: 1000, consentAction: { action: 'accept', clicked: true, atTMs: 1000 }, ga4Hits: [hit({ en: 'page_view', gcs: 'G100', tRelativeMs: 500 })] });
  check('consent_mode Pass (pre-consent cookieless)', statusOf(okPre, s, chk) === 'Pass');
  // tracking cookie set pre-consent → Fail (sub-check b)
  const cookieBad = capture({ consentActionTMs: 1000, consentAction: { action: 'accept', clicked: true, atTMs: 1000 }, cookiesPreConsent: ['_ga', 'sessionid'] });
  check('consent_mode Fail (pre-consent cookie)', statusOf(cookieBad, s, chk) === 'Fail');
  // consent flow configured but click failed → Not Verified
  const noClick = capture({ consentActionTMs: null, consentAction: { action: 'accept', clicked: false, atTMs: null } });
  check('consent_mode Not Verified (click failed)', statusOf(noClick, s, chk) === 'Not Verified');
}
{
  // default-state assertion
  const chk: CheckSpec = { id: 'cmd', type: 'consent_mode', expectedDefault: { analytics_storage: 'denied', ad_storage: 'denied' } };
  const okDefault = capture({ consentEvents: [consentEvent({ kind: 'default', fields: { analytics_storage: 'denied', ad_storage: 'denied' } })] });
  check('consent_mode default Pass', statusOf(okDefault, spec([chk]), chk) === 'Pass');
  const badDefault = capture({ consentEvents: [consentEvent({ kind: 'default', fields: { analytics_storage: 'granted', ad_storage: 'denied' } })] });
  check('consent_mode default Fail (mismatch)', statusOf(badDefault, spec([chk]), chk) === 'Fail');
  const noDefault = capture({ consentEvents: [] });
  check('consent_mode default Fail (no default event)', statusOf(noDefault, spec([chk]), chk) === 'Fail');
}

// ── duplicate_event ──────────────────────────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'dup', type: 'duplicate_event', event: 'purchase' };
  check('duplicate Fail (>1)', statusOf(capture({ ga4Hits: [hit({ en: 'purchase' }), hit({ en: 'purchase' })] }), spec([chk]), chk) === 'Fail');
  check('duplicate Pass (1)', statusOf(capture({ ga4Hits: [hit({ en: 'purchase' })] }), spec([chk]), chk) === 'Pass');
  check('duplicate Pass (0 — never fired)', statusOf(capture({ ga4Hits: [] }), spec([chk]), chk) === 'Pass');
}
{
  const chk: CheckSpec = { id: 'dup2', type: 'duplicate_event', event: 'purchase', allowedCount: 2 };
  check('duplicate Pass (allowedCount 2)', statusOf(capture({ ga4Hits: [hit({ en: 'purchase' }), hit({ en: 'purchase' })] }), spec([chk]), chk) === 'Pass');
}
{
  const chk: CheckSpec = { id: 'dup3', type: 'duplicate_event', event: 'purchase', keyParams: ['ep.transaction_id'] };
  const distinct = capture({ ga4Hits: [hit({ en: 'purchase', params: { 'ep.transaction_id': 'A' } }), hit({ en: 'purchase', params: { 'ep.transaction_id': 'B' } })] });
  check('duplicate Pass (distinct keyParams)', statusOf(distinct, spec([chk]), chk) === 'Pass');
  const same = capture({ ga4Hits: [hit({ en: 'purchase', params: { 'ep.transaction_id': 'A' } }), hit({ en: 'purchase', params: { 'ep.transaction_id': 'A' } })] });
  check('duplicate Fail (same keyParams twice)', statusOf(same, spec([chk]), chk) === 'Fail');
}

// ── tracker_present ──────────────────────────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'clr', type: 'tracker_present', tracker: 'clarity' };
  check('tracker_present Pass', statusOf(capture({ trackers: [tracker({ vendor: 'clarity', domain: 'www.clarity.ms' })] }), spec([chk]), chk) === 'Pass');
  check('tracker_present Fail (missing)', statusOf(capture({ trackers: [tracker({ vendor: 'ga4' })] }), spec([chk]), chk) === 'Fail');
}
{
  const chk: CheckSpec = { id: 'fb', type: 'tracker_present', tracker: 'facebook' };
  check('tracker_present alias Pass (facebook→meta_pixel)', statusOf(capture({ trackers: [tracker({ vendor: 'meta_pixel', domain: 'www.facebook.com' })] }), spec([chk]), chk) === 'Pass');
}
{
  const chk: CheckSpec = { id: 'g4', type: 'tracker_present', tracker: 'ga4' };
  check('tracker_present ga4 via hits', statusOf(capture({ trackers: [], ga4Hits: [hit({})] }), spec([chk]), chk) === 'Pass');
}

// ── cross_domain_linker ──────────────────────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'ln', type: 'cross_domain_linker', expectedDomains: ['shop.example.com'] };
  const s = spec([chk]);
  check('linker Pass', statusOf(capture({ actions: [action({ checkId: 'ln', kind: 'linker', linkerParamPresent: true, linkerDestUrl: 'https://shop.example.com/?_gl=1*abc' })] }), s, chk) === 'Pass');
  check('linker Fail (_gl absent)', statusOf(capture({ actions: [action({ checkId: 'ln', kind: 'linker', linkerParamPresent: false, linkerDestUrl: 'https://shop.example.com/' })] }), s, chk) === 'Fail');
  check('linker Not Verified (no link found)', statusOf(capture({ actions: [action({ checkId: 'ln', kind: 'linker', selectorFound: false, performed: false })] }), s, chk) === 'Not Verified');
}

// ── evidence + reason contract ───────────────────────────────────────────────────
{
  const chk: CheckSpec = { id: 'pv', type: 'event_fired', event: 'page_view' };
  const r = runCheck(capture({ ga4Hits: [hit({ en: 'page_view', tid: 'G-1' })] }), spec([chk]), chk);
  check('Pass carries hit evidence', Boolean(r.evidence?.hits && r.evidence.hits.length === 1));
  const rf = runCheck(capture({ ga4Hits: [] }), spec([chk]), chk);
  check('Fail carries a reason', typeof rf.reason === 'string' && rf.reason.length > 0);
}

done(35);
