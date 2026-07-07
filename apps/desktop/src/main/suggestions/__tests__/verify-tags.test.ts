// Pure tests for the "Verify tag firing" evaluator (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-tags.test.ts

import { evaluateVerify, type PerTagCapture } from '../verify-tags';
import type { VerifyTagInput, CapturedHitView, DetectedElementView } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const ga4Hit = (en: string, tid = 'G-1'): CapturedHitView => ({ url: `https://www.google-analytics.com/g/collect?v=2&tid=${tid}&en=${en}`, body: null, collector: 'ga4' });
const serverHit = (en: string, tid = 'G-1'): CapturedHitView => ({ url: `https://gtm.example.com/g/collect?v=2&tid=${tid}&en=${en}`, body: null, collector: 'server' });
const metaHit = (): CapturedHitView => ({ url: 'https://www.facebook.com/tr?id=1&ev=Lead', body: null, collector: 'meta' });

const tag = (over: Partial<VerifyTagInput> = {}): VerifyTagInput => ({
  id: 't1', tagName: 'CTA Tag', eventName: 'cta_click', platform: 'ga4_event',
  trigger: { name: 'CTA', kind: 'link_click', clickTextValue: 'Get a Free Audit', clickTextOperator: 'equals' },
  ...over,
});
const cap = (over: Partial<PerTagCapture> = {}): PerTagCapture => ({
  tagId: 't1', kind: 'click', targetFound: true, performed: true, hits: [], ...over,
});
const els: DetectedElementView[] = [{ page: '/', kind: 'cta', text: 'Get a Free Audit' }];

// ── fired: GA4 event matches ───────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [cap({ hits: [ga4Hit('cta_click')] })], els);
  check('GA4 fired → fired true', v[0].fired === true && v[0].event === 'cta_click');
  check('GA4 fired carries evidence', Boolean(v[0].evidence));
}

// ── not fired: no hit at all ─────────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [cap({ hits: [] })], els);
  check('GA4 no-hit → fired false', v[0].fired === false);
  check('GA4 no-hit → reason present', typeof v[0].reason === 'string' && v[0].reason!.length > 0);
}

// ── wrong event fired ────────────────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [cap({ hits: [ga4Hit('page_view')] })], els);
  check('wrong-event → fired false', v[0].fired === false);
  check('wrong-event → reason names the seen event', /page_view/.test(v[0].reason ?? ''));
}

// ── target not found → repair proposed ──────────────────────────────────────────
{
  const t = tag({ trigger: { name: 'CTA', kind: 'link_click', clickTextValue: 'Free Audit', clickTextOperator: 'equals' } });
  const v = evaluateVerify([t], [cap({ targetFound: false, performed: false, hits: [] })], els);
  check('no-match → fired false', v[0].fired === false);
  check('no-match → suggestedTrigger proposed', Boolean(v[0].suggestedTrigger));
  check('no-match → repaired to real control text', v[0].suggestedTrigger?.clickTextValue === 'Get a Free Audit');
  check('no-match → fixNote present', typeof v[0].fixNote === 'string' && v[0].fixNote!.length > 0);
}

// ── target not found, no candidate → loosen operator ────────────────────────────
{
  const t = tag({ trigger: { name: 'X', kind: 'link_click', clickTextValue: 'Nonexistent CTA', clickTextOperator: 'equals' } });
  const v = evaluateVerify([t], [cap({ targetFound: false, performed: false, hits: [] })], [{ page: '/', kind: 'cta', text: 'Buy now' }]);
  check('no-candidate → loosen to contains (or note only)', v[0].suggestedTrigger?.clickTextOperator === 'contains' || v[0].suggestedTrigger === undefined);
  check('no-candidate → fixNote present', Boolean(v[0].fixNote));
}

// ── identical text present on ANOTHER page → no no-op fix, points at the page ───
{
  const t = tag({ trigger: { name: 'X', kind: 'link_click', clickTextValue: 'Book a Strategy Call', clickTextOperator: 'equals' } });
  const contactEls: DetectedElementView[] = [{ page: '/contact', kind: 'cta', text: 'Book a Strategy Call' }];
  const v = evaluateVerify([t], [cap({ targetFound: false, performed: false, hits: [] })], contactEls);
  check('identical-text → no no-op suggestedTrigger', v[0].suggestedTrigger === undefined);
  check('identical-text → fixNote points at the page', /\/contact/.test(v[0].fixNote ?? ''));
}

// ── non-GA4 (meta) fired via collector ──────────────────────────────────────────
{
  const t = tag({ id: 'm1', platform: 'meta_pixel', eventName: 'Lead' });
  const v = evaluateVerify([t], [cap({ tagId: 'm1', hits: [metaHit()] })], els);
  check('meta hit → fired true', v[0].fired === true);
}

// ── sGTM: first-party /g/collect (collector 'server') counts as GA4 firing ──────
{
  const v = evaluateVerify([tag()], [cap({ hits: [serverHit('cta_click')] })], els);
  check('sGTM server hit → fired true', v[0].fired === true && v[0].event === 'cta_click');
}

// ── tid attribution: literal Measurement ID requires tid match ──────────────────
{
  const t = tag({ measurementId: 'G-1' });
  check('tid match → fired', evaluateVerify([t], [cap({ hits: [ga4Hit('cta_click', 'G-1')] })], els)[0].fired === true);
  check('tid mismatch → not fired', evaluateVerify([t], [cap({ hits: [ga4Hit('cta_click', 'G-2')] })], els)[0].fired === false);
}
{
  // A {{variable}} measurementId can't be matched → event-name only (any tid).
  const t = tag({ measurementId: '{{GA4 Measurement ID}}' });
  check('variable measurementId → any tid fires', evaluateVerify([t], [cap({ hits: [ga4Hit('cta_click', 'G-999')] })], els)[0].fired === true);
}

// ── custom_event: driver pushed the dataLayer event → GA4 hit → fired ───────────
{
  const t = tag({ id: 'ce', eventName: 'newsletter_signup', trigger: { name: 'NL', kind: 'custom_event', eventName: 'newsletter_signup' } });
  const v = evaluateVerify([t], [cap({ tagId: 'ce', kind: 'custom_event', hits: [ga4Hit('newsletter_signup')] })], els);
  check('custom_event fired via dataLayer → fired true', v[0].fired === true);
}

// ── not exercised ────────────────────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [], els);
  check('no capture → fired false + interaction none', v[0].fired === false && v[0].interaction?.kind === 'none');
}

// ── Phase A: precise per-platform attribution + observed beacons ─────────────────
const linkedinHit = (): CapturedHitView => ({ url: 'https://px.ads.linkedin.com/collect?pid=1', body: null, collector: 'ad' });
const redditHit = (): CapturedHitView => ({ url: 'https://alb.reddit.com/rp.gif?id=1', body: null, collector: 'ad' });
{
  const li = tag({ id: 'li', platform: 'linkedin_insight', eventName: 'Lead' });
  // Fires on its OWN platform's beacon…
  check('linkedin tag fires on a LinkedIn beacon', evaluateVerify([li], [cap({ tagId: 'li', hits: [linkedinHit()] })], els)[0].fired === true);
  // …but NOT on a different ad platform's beacon (no cross-attribution — the old 'ad'-lumping bug).
  const wrong = evaluateVerify([li], [cap({ tagId: 'li', hits: [redditHit()] })], els)[0];
  check('linkedin tag does NOT fire on a Reddit-only beacon', wrong.fired === false);
  check('not-fired verdict lists the beacon it DID see', (wrong.observedBeacons ?? []).includes('alb.reddit.com'));
}
{
  // A fired verdict surfaces the beacon host + names the platform in `event`.
  const li = tag({ id: 'li2', platform: 'linkedin_insight', eventName: 'Lead' });
  const v = evaluateVerify([li], [cap({ tagId: 'li2', hits: [linkedinHit()] })], els)[0];
  check('fired verdict surfaces observedBeacons host', (v.observedBeacons ?? []).includes('px.ads.linkedin.com'));
  check('fired verdict names the platform (linkedin)', v.event === 'linkedin');
}
{
  // Unknown platform type ('custom_html' etc.) → any recognised ad/pixel beacon counts as fired.
  const unknown = tag({ id: 'u1', platform: 'meta_pixel', eventName: 'x' }); // meta_pixel maps to 'meta' specifically
  check('meta tag does NOT fire on a linkedin beacon (specific match)', evaluateVerify([unknown], [cap({ tagId: 'u1', hits: [linkedinHit()] })], els)[0].fired === false);
}

// ── inconclusive vs genuine: the "results are false" fix ─────────────────────────
// A CTA whose control lives on ANOTHER page can't be exercised from the one page we drove.
// That must be reported as "couldn't auto-test here" (inconclusive), NOT "not firing".
{
  const t = tag({ trigger: { name: 'X', kind: 'link_click', clickTextValue: 'View Open Positions', clickTextOperator: 'equals' } });
  const careersEls: DetectedElementView[] = [{ page: '/careers', kind: 'cta', text: 'View Open Positions' }];
  const v = evaluateVerify([t], [cap({ targetFound: false, performed: false, hits: [] })], careersEls)[0];
  check('CTA on another page → inconclusive (not a failure)', v.inconclusive === true && v.fired === false);
  check('CTA on another page → no scary suggestedTrigger', v.suggestedTrigger === undefined);
}
// A CONFIDENT on-page repair (closest control) stays ACTIONABLE, not inconclusive.
{
  const t = tag({ trigger: { name: 'CTA', kind: 'link_click', clickTextValue: 'Free Audit', clickTextOperator: 'equals' } });
  const v = evaluateVerify([t], [cap({ targetFound: false, performed: false, hits: [] })], els)[0];
  check('confident on-page repair → NOT inconclusive', !v.inconclusive && Boolean(v.suggestedTrigger));
}
// A shared custom event pushed synthetically can't carry form-specific data → inconclusive,
// and the reason must tell the user to verify with a REAL submit (not "loosen the operator").
{
  const t = tag({ id: 'ce2', eventName: 'lead_form', trigger: { name: 'F', kind: 'custom_event', eventName: 'form_submission' } });
  const v = evaluateVerify([t], [cap({ tagId: 'ce2', kind: 'custom_event', targetFound: true, performed: true, hits: [] })], els)[0];
  check('custom_event bare-push no-hit → inconclusive', v.inconclusive === true && v.fired === false);
  check('custom_event no-hit → reason points at a real submit', /real submit|form-specific/i.test(v.reason ?? ''));
  check('custom_event no-hit → reason names the pushed event', /form_submission/.test(v.reason ?? ''));
}
// GENUINE failure is preserved: element FOUND + clicked, but no hit fired → NOT inconclusive.
{
  const v = evaluateVerify([tag()], [cap({ targetFound: true, performed: true, kind: 'click', hits: [] })], els)[0];
  check('found + clicked + no-hit → genuine not-firing (not inconclusive)', v.fired === false && !v.inconclusive);
}
// A custom_event that DID fire is never inconclusive.
{
  const t = tag({ id: 'ce3', eventName: 'newsletter_signup', trigger: { name: 'NL', kind: 'custom_event', eventName: 'newsletter_signup' } });
  const v = evaluateVerify([t], [cap({ tagId: 'ce3', kind: 'custom_event', hits: [ga4Hit('newsletter_signup')] })], els)[0];
  check('custom_event fired → not inconclusive', v.fired === true && !v.inconclusive);
}

// ── pixel/ad tags: a SPECIFIC vendor no-beacon is a real failure; a generic 'ad' no-beacon is not ──
{
  // A named Meta tag whose element was clicked but produced no facebook beacon → genuine not-fired.
  const meta = tag({ id: 'me', platform: 'meta_pixel', eventName: '' });
  const v = evaluateVerify([meta], [cap({ tagId: 'me', hits: [] })], els)[0];
  check('specific pixel (meta) clicked, no beacon → genuine not-firing', v.fired === false && !v.inconclusive);
}
// ── server-side pixel: no browser beacon but a first-party sGTM relay fired → NOT "not firing" ──
// The real-world false negative on a server-side (CAPI) setup: a Meta tag whose event relays to the
// site's own sGTM (/g/collect on a first-party host) sends no facebook.com/tr beacon — that's the
// expected shape of server-side, not a break. Must be inconclusive + serverRelay, never a red failure.
{
  const meta = tag({ id: 'mss', platform: 'meta_pixel', eventName: '' });
  const v = evaluateVerify([meta], [cap({ tagId: 'mss', hits: [serverHit('email_click')] })], els)[0];
  check('meta pixel + server relay, no fb beacon → serverRelay inconclusive (not a failure)', v.fired === false && v.inconclusive === true && v.serverRelay === true);
  check('meta pixel + server relay → NOT counted as genuine not-firing', !(v.fired === false && !v.inconclusive));
}
{
  // Guard: a real facebook beacon still wins (fired), even alongside a server relay.
  const meta = tag({ id: 'mok', platform: 'meta_pixel', eventName: '' });
  const v = evaluateVerify([meta], [cap({ tagId: 'mok', hits: [serverHit('email_click'), metaHit()] })], els)[0];
  check('meta pixel + real fb beacon (with relay) → fired, not serverRelay', v.fired === true && !v.serverRelay);
}
{
  // Guard: no beacon AND no server relay stays a genuine not-firing (nothing fired at all).
  const meta = tag({ id: 'mno', platform: 'meta_pixel', eventName: '' });
  const v = evaluateVerify([meta], [cap({ tagId: 'mno', hits: [] })], els)[0];
  check('meta pixel, no beacon + no relay → genuine not-firing (no serverRelay excuse)', v.fired === false && !v.inconclusive && !v.serverRelay);
}
{
  // A generic 'ad' tag (an undecodable Custom Template we mapped by fallback) with no recognised
  // beacon is NOT provably broken → inconclusive, not a red failure.
  const adTag = tag({ id: 'ad', platform: 'ad', eventName: '' });
  const v = evaluateVerify([adTag], [cap({ tagId: 'ad', hits: [] })], els)[0];
  check('generic ad tag clicked, no beacon → inconclusive', v.fired === false && v.inconclusive === true);
}
{
  // A generic 'ad' tag DOES fire on any recognised pixel/ad beacon.
  const adTag = tag({ id: 'ad2', platform: 'ad', eventName: '' });
  const v = evaluateVerify([adTag], [cap({ tagId: 'ad2', hits: [linkedinHit()] })], els)[0];
  check('generic ad tag fires on any recognised pixel beacon', v.fired === true);
}

// ── synthetic vs real firing: a custom_event fire is CONFIG-only (we pushed the event, no real submit) ─
{
  const t = tag({ id: 'sy', eventName: 'form_submission', trigger: { name: 'F', kind: 'custom_event', eventName: 'form_submission' } });
  const v = evaluateVerify([t], [cap({ tagId: 'sy', kind: 'custom_event', hits: [ga4Hit('form_submission')] })], els)[0];
  check('custom_event fire → fired + synthetic flagged (config-only)', v.fired === true && v.synthetic === true);
}
{
  // A REAL click fire (we clicked the actual element) is NOT synthetic.
  const v = evaluateVerify([tag()], [cap({ hits: [ga4Hit('cta_click')] })], els)[0];
  check('real click fire → fired, not synthetic', v.fired === true && !v.synthetic);
}
{
  // A non-GA4 pixel fired via a real click is also not synthetic.
  const li = tag({ id: 'lisyn', platform: 'linkedin_insight', eventName: 'Lead' });
  const v = evaluateVerify([li], [cap({ tagId: 'lisyn', hits: [linkedinHit()] })], els)[0];
  check('real pixel-beacon fire → not synthetic', v.fired === true && !v.synthetic);
}

// ── screenshot (visual proof) threads from the capture onto the verdict ───────────
{
  const shot = 'data:image/jpeg;base64,AAAA';
  const withShot = evaluateVerify([tag()], [cap({ hits: [ga4Hit('cta_click')], screenshot: shot })], els)[0];
  check('screenshot on the capture → attached to the verdict', withShot.screenshot === shot);
  const noShot = evaluateVerify([tag()], [cap({ hits: [ga4Hit('cta_click')] })], els)[0];
  check('no screenshot on the capture → none on the verdict', noShot.screenshot === undefined);
  // A NOT-fired tag still carries its screenshot (proof the CTA/page was reached).
  const missShot = evaluateVerify([tag()], [cap({ targetFound: true, performed: true, kind: 'click', hits: [], screenshot: shot })], els)[0];
  check('not-fired verdict still carries the screenshot', missShot.fired === false && missShot.screenshot === shot);
}

console.log(`\nverify-tags: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 24) { console.error(`expected >= 24 checks, got ${passed}`); process.exit(1); }
