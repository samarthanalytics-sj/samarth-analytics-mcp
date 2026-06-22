/**
 * Web Audit MCP — pure-logic test suite (no browser required).
 * Run: tsx apps/web-audit-mcp/src/__tests__/web-audit.node.test.ts
 *
 * Covers the SSRF guard, CMP registry shape + text heuristics, form PII
 * analysis, the banner compliance rules over fixture captures, the RuntimeInput
 * bridge into the shared Consent Mode v2 engine, and the GTM container bridge
 * (parseGtmContainer + reconciled-coverage escalation in runConsentEngine).
 */

import { urlAllowed } from '../utils/urlGuard.js';
import { classifyUrl, parseQuery, MEASUREMENT_GROUPS } from '../agent/browser.js';
import { CMP_VENDORS, ACCEPT_TEXT_RE, REJECT_TEXT_RE } from '../agent/cmp.js';
import { analyzeForms, classifyFieldPii, type RawForm, type RawFormField } from '../agent/forms.js';
import { sameSite, normalizeUrl, urlPriority } from '../agent/crawler.js';
import { extractConsentEvents, extractEventNames, type ScenarioCapture } from '../agent/capture.js';
import {
  evaluateBannerRules,
  evaluateFormFindings,
  buildRuntimeInput,
  runConsentEngine,
  scoreFindings,
  sortFindings,
  isFiringHit,
  gcsIndicatesDenied,
} from '../agent/compliance.js';
import { parseGtmContainer, GtmContainerError } from '../agent/gtmConfig.js';
import {
  extractConfiguredDestinations,
  extractObservedDestinations,
  reconcile,
} from '../agent/reconcile.js';
import { isAuthorized, buildHealthBody } from '../http.js';
import { loadConfig } from '../utils/config.js';
import { runConsentRuntimeRules } from '../../../portal/shared/consent-audit.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── urlGuard ────────────────────────────────────────────────────────────────

check('guard: public https ok', urlAllowed('https://example.com/x').ok);
check('guard: plain http ok', urlAllowed('http://example.com').ok);
check('guard: ftp blocked', !urlAllowed('ftp://example.com').ok);
check('guard: file blocked', !urlAllowed('file:///etc/passwd').ok);
check('guard: localhost blocked', !urlAllowed('http://localhost:3000').ok);
check('guard: .localhost blocked', !urlAllowed('http://foo.localhost').ok);
check('guard: 127.0.0.1 blocked', !urlAllowed('http://127.0.0.1').ok);
check('guard: 10.x blocked', !urlAllowed('http://10.1.2.3').ok);
check('guard: 192.168 blocked', !urlAllowed('http://192.168.1.1').ok);
check('guard: 172.16 blocked', !urlAllowed('http://172.16.0.1').ok);
check('guard: 172.32 allowed', urlAllowed('http://172.32.0.1').ok);
check('guard: metadata blocked', !urlAllowed('http://169.254.169.254/latest/meta-data/').ok);
check('guard: CGNAT blocked', !urlAllowed('http://100.64.0.1').ok);
check('guard: decimal ip blocked', !urlAllowed('http://2130706433/').ok);
check('guard: hex ip blocked', !urlAllowed('http://0x7f000001/').ok);
check('guard: octal ip blocked', !urlAllowed('http://0177.0.0.1/').ok);
check('guard: ipv6 loopback blocked', !urlAllowed('http://[::1]/').ok);
check('guard: ipv6 mapped loopback blocked', !urlAllowed('http://[::ffff:127.0.0.1]/').ok);
check('guard: ipv6 mapped hex metadata blocked', !urlAllowed('http://[::ffff:a9fe:a9fe]/').ok);
check('guard: ULA blocked', !urlAllowed('http://[fc00::1]/').ok);
check('guard: allowlist match', urlAllowed('https://shop.example.com', ['example.com']).ok);
check('guard: allowlist exact', urlAllowed('https://example.com', ['example.com']).ok);
check('guard: allowlist miss', !urlAllowed('https://notexample.com', ['example.com']).ok);
check('guard: allowlist no suffix-confusion', !urlAllowed('https://evilexample.com', ['example.com']).ok);

// ── tracker classification ─────────────────────────────────────────────────

const ga4 = classifyUrl('https://region1.google-analytics.com/g/collect?v=2&tid=G-123&gcs=G111&en=page_view');
check('classify: ga4 collect', ga4.ids.includes('ga4_collect') && ga4.groups.includes('ga4'));
const meta = classifyUrl('https://www.facebook.com/tr?id=123&ev=PageView');
check('classify: meta pixel', meta.groups.includes('meta'));
const gtm = classifyUrl('https://www.googletagmanager.com/gtm.js?id=GTM-XXX');
check('classify: gtm loader', gtm.groups.includes('gtm'));
check('classify: gtm not a measurement group', !MEASUREMENT_GROUPS.has('gtm'));
const q = parseQuery('https://x.test/g/collect?gcs=G100&en=page_view&dl=https%3A%2F%2Fa.b');
check('parseQuery decodes', q.gcs === 'G100' && q.dl === 'https://a.b');

// ── CMP registry ────────────────────────────────────────────────────────────

const vendorIds = new Set(CMP_VENDORS.map((v) => v.id));
check('cmp: vendor ids unique', vendorIds.size === CMP_VENDORS.length);
check('cmp: every vendor has presence + accept', CMP_VENDORS.every((v) => v.presence.length > 0 && v.accept.length > 0));
check('cmp: covers major vendors', ['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'quantcast', 'trustarc'].every((id) => vendorIds.has(id)));
check('cmp: accept text en', ACCEPT_TEXT_RE.test('Accept all cookies'));
check('cmp: accept text de', ACCEPT_TEXT_RE.test('Alle akzeptieren'));
check('cmp: accept text fr', ACCEPT_TEXT_RE.test("J'accepte"));
check('cmp: accept text es', ACCEPT_TEXT_RE.test('Aceptar todo'));
check('cmp: reject text en', REJECT_TEXT_RE.test('Reject all'));
check('cmp: reject text only-necessary', REJECT_TEXT_RE.test('Only necessary cookies'));
check('cmp: reject text de', REJECT_TEXT_RE.test('Nur notwendige Cookies'));
check('cmp: reject text fr', REJECT_TEXT_RE.test('Continuer sans accepter'));
check('cmp: accept not matching reject', !REJECT_TEXT_RE.test('Accept all cookies'));
check('cmp: reject not matching accept', !ACCEPT_TEXT_RE.test('Reject all'));
check('cmp: privacy-policy link is neither', !ACCEPT_TEXT_RE.test('Privacy policy') && !REJECT_TEXT_RE.test('Privacy policy'));

// ── crawler helpers ─────────────────────────────────────────────────────────

check('crawl: same host', sameSite('https://example.com/a', 'https://example.com'));
check('crawl: www variant', sameSite('https://www.example.com/a', 'https://example.com'));
check('crawl: subdomain ok', sameSite('https://shop.example.com', 'https://example.com'));
check('crawl: other host rejected', !sameSite('https://other.com', 'https://example.com'));
check('crawl: asset skipped', normalizeUrl('/logo.png', 'https://example.com') === null);
check('crawl: mailto skipped', normalizeUrl('mailto:x@y.z', 'https://example.com') === null);
check('crawl: hash stripped', normalizeUrl('https://example.com/a#frag', 'https://example.com') === 'https://example.com/a');
check('crawl: contact prioritised', urlPriority('https://x.com/contact-us') > urlPriority('https://x.com/blog/post'));

// ── form analysis ───────────────────────────────────────────────────────────

function field(over: Partial<RawFormField>): RawFormField {
  return { tag: 'input', type: 'text', name: '', id: '', label: '', placeholder: '', autocomplete: '', required: false, ...over };
}
function form(over: Partial<RawForm>): RawForm {
  const fields = over.fields ?? [];
  return { index: 0, action: 'https://example.com/submit', method: 'post', formId: '', formName: '', formClasses: '', title: '', fieldCount: fields.length, fields, hasPrivacyLink: false, text: '', ...over };
}

check('pii: email by type', classifyFieldPii(field({ type: 'email' })) === 'email');
check('pii: phone by name', classifyFieldPii(field({ name: 'phone_number' })) === 'phone');
check('pii: name by label', classifyFieldPii(field({ label: 'First name' })) === 'name');
check('pii: dob by label', classifyFieldPii(field({ label: 'Date of birth' })) === 'date_of_birth');
check('pii: payment by autocomplete', classifyFieldPii(field({ autocomplete: 'cc-number' })) === 'payment');
check('pii: plain text not pii', classifyFieldPii(field({ name: 'company_size' })) === null);

const contactForm = form({
  index: 0,
  fields: [
    field({ type: 'email', name: 'email' }),
    field({ name: 'full_name', label: 'Full name' }),
    field({ tag: 'textarea', type: 'textarea', name: 'message' }),
  ],
});
const contactAnalysis = analyzeForms([contactForm], 'https://example.com/contact')[0];
check('forms: contact purpose', contactAnalysis.purpose === 'contact');
check('forms: pii without notice flagged', contactAnalysis.issues.some((i) => i.id.includes('pii_no_notice')));

const noticedForm = form({ index: 1, fields: contactForm.fields, hasPrivacyLink: true });
check(
  'forms: privacy link suppresses notice issue',
  analyzeForms([noticedForm], 'https://example.com')[0].issues.every((i) => !i.id.includes('pii_no_notice')),
);

const newsletterForm = form({
  index: 2,
  fields: [
    field({ type: 'email', name: 'email' }),
    field({ type: 'checkbox', name: 'newsletter_optin', label: 'Subscribe to our newsletter', checked: true }),
  ],
  text: 'subscribe to our newsletter for updates',
  hasPrivacyLink: true,
});
const newsletterAnalysis = analyzeForms([newsletterForm], 'https://example.com')[0];
check('forms: prechecked marketing flagged high', newsletterAnalysis.issues.some((i) => i.id.includes('prechecked_marketing') && i.severity === 'high'));
check('forms: marketing checkbox captured', newsletterAnalysis.marketingCheckboxes.length === 1 && newsletterAnalysis.marketingCheckboxes[0].prechecked);

const loginForm = form({
  index: 3,
  fields: [field({ type: 'email', name: 'email' }), field({ type: 'password', name: 'password' })],
});
const loginAnalysis = analyzeForms([loginForm], 'https://example.com/login')[0];
check('forms: login purpose', loginAnalysis.purpose === 'login');
check('forms: login exempt from notice rule', loginAnalysis.issues.every((i) => !i.id.includes('pii_no_notice')));

const thirdPartyForm = form({ index: 4, action: 'https://lists.mailvendor.io/subscribe', fields: [field({ type: 'email', name: 'email' })], hasPrivacyLink: true });
check('forms: third-party action flagged', analyzeForms([thirdPartyForm], 'https://example.com')[0].issues.some((i) => i.id.includes('third_party_action')));

const insecureForm = form({ index: 5, action: 'http://example.com/submit', fields: [field({ type: 'email', name: 'email' })], hasPrivacyLink: true });
check('forms: insecure action flagged', analyzeForms([insecureForm], 'https://example.com')[0].issues.some((i) => i.id.includes('insecure_action') && i.severity === 'high'));

// ── consent event extraction ────────────────────────────────────────────────

const dlLog = [
  { t: 12, entry: ['consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }] },
  { t: 300, entry: { event: 'gtm.js' } },
  { t: 4200, entry: ['consent', 'update', { ad_storage: 'granted', analytics_storage: 'granted' }] },
  { t: 4300, entry: ['event', 'page_view', {}] },
];
const consentEvents = extractConsentEvents(dlLog);
check('dl: consent default extracted', consentEvents[0]?.kind === 'default' && consentEvents[0]?.fields.ad_storage === 'denied' && consentEvents[0]?.tMs === 12);
check('dl: consent update extracted', consentEvents[1]?.kind === 'update' && consentEvents[1]?.fields.analytics_storage === 'granted');
check('dl: event names', extractEventNames(dlLog).join(',') === 'gtm.js,page_view');

// ── banner rules over fixture captures ─────────────────────────────────────

function hit(over: Partial<ScenarioCapture['trackerHits'][number]>): ScenarioCapture['trackerHits'][number] {
  return { url: 'https://region1.google-analytics.com/g/collect?v=2', method: 'POST', ids: ['ga4_collect'], groups: ['ga4'], tMs: 1000, resourceType: 'fetch', ...over };
}
function capture(over: Partial<ScenarioCapture>): ScenarioCapture {
  return {
    scenario: 'ignore',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    httpStatus: 200,
    cmp: { detected: true, vendorName: 'OneTrust', vendorId: 'onetrust', accept: { selector: '#onetrust-accept-btn-handler' }, rejectOnFirstLayer: false, method: 'vendor' },
    interaction: null,
    interactionTMs: null,
    trackerHits: [],
    networkRequestCount: 10,
    consentEvents: [],
    dataLayerEvents: [],
    dataLayerKeys: [],
    cookiesPreInteraction: [],
    cookiesFinal: [],
    consoleErrors: [],
    pageErrors: [],
    forms: null,
    notes: [],
    ...over,
  };
}

check('rules: firing hit detection', isFiringHit(hit({})));
check('rules: gtm.js not firing', !isFiringHit(hit({ url: 'https://www.googletagmanager.com/gtm.js', ids: ['gtm_loader'], groups: ['gtm'] })));
check('rules: fbevents.js not firing', !isFiringHit(hit({ url: 'https://connect.facebook.net/en_US/fbevents.js', ids: ['meta_pixel'], groups: ['meta'] })));
check('rules: fb /tr firing', isFiringHit(hit({ url: 'https://www.facebook.com/tr?id=1', ids: ['meta_pixel'], groups: ['meta'] })));
check('rules: gcs G100 denied', gcsIndicatesDenied(hit({ query: { gcs: 'G100' } })));
check('rules: gcs G111 not denied', !gcsIndicatesDenied(hit({ query: { gcs: 'G111' } })));

// Pre-consent fire (no gcs) → critical.
const preConsent = evaluateBannerRules([capture({ trackerHits: [hit({})] })]);
check('rules: preconsent fire critical', preConsent.some((f) => f.id.startsWith('banner_preconsent_fire') && f.severity === 'critical'));
check('rules: no reject first layer flagged', preConsent.some((f) => f.id === 'banner_no_reject_first_layer'));

// Pre-consent cookieless ping (gcs=G100) → info, not critical.
const advanced = evaluateBannerRules([capture({ trackerHits: [hit({ query: { gcs: 'G100' } })] })]);
check('rules: advanced pings are info', advanced.some((f) => f.id.startsWith('banner_advanced_pings') && f.severity === 'info'));
check('rules: advanced pings not critical', !advanced.some((f) => f.severity === 'critical'));

// Fires after reject → critical; cookies after reject → high; no update → medium.
const rejectCapture = capture({
  scenario: 'reject',
  cmp: { detected: true, vendorName: 'OneTrust', rejectOnFirstLayer: true, accept: { selector: '#a' }, reject: { selector: '#r' }, method: 'vendor' },
  interaction: { action: 'reject', clicked: true, selector: '#onetrust-reject-all-handler', tMs: 5000 },
  interactionTMs: 5000,
  trackerHits: [hit({ tMs: 6500 })],
  cookiesFinal: ['_ga', '_fbp', 'session_id'],
});
const rejectFindings = evaluateBannerRules([rejectCapture]);
check('rules: fires after reject critical', rejectFindings.some((f) => f.id.startsWith('banner_fires_after_reject') && f.severity === 'critical'));
check('rules: cookies after reject high', rejectFindings.some((f) => f.id.startsWith('banner_cookies_after_reject') && f.severity === 'high'));
check('rules: reject without update flagged', rejectFindings.some((f) => f.id.startsWith('banner_reject_no_update')));
check('rules: session cookie not flagged as tracking', !rejectFindings.some((f) => f.finding.includes('session_id')));

// Compliant site: banner, no pre-consent firing, update on reject, no cookies.
const compliantReject = capture({
  scenario: 'reject',
  cmp: { detected: true, vendorName: 'Cookiebot (Usercentrics)', rejectOnFirstLayer: true, accept: { selector: '#a' }, reject: { selector: '#r' }, method: 'vendor' },
  interaction: { action: 'reject', clicked: true, selector: '#r', tMs: 5000 },
  interactionTMs: 5000,
  consentEvents: [
    { kind: 'default', tMs: 10, fields: { ad_storage: 'denied', analytics_storage: 'denied' } },
    { kind: 'update', tMs: 5100, fields: { ad_storage: 'denied', analytics_storage: 'denied' } },
  ],
  trackerHits: [hit({ url: 'https://www.googletagmanager.com/gtm.js', ids: ['gtm_loader'], groups: ['gtm'] })],
});
const compliantFindings = evaluateBannerRules([
  capture({
    cmp: compliantReject.cmp,
    consentEvents: [{ kind: 'default', tMs: 10, fields: { ad_storage: 'denied', analytics_storage: 'denied' } }],
    trackerHits: [hit({ url: 'https://www.googletagmanager.com/gtm.js', ids: ['gtm_loader'], groups: ['gtm'] })],
  }),
  compliantReject,
]);
check('rules: compliant site has no critical/high', compliantFindings.every((f) => f.severity !== 'critical' && f.severity !== 'high'), JSON.stringify(compliantFindings.map((f) => f.id)));

// No CMP but trackers fire → high.
const noCmp = evaluateBannerRules([capture({ cmp: { detected: false, rejectOnFirstLayer: false }, trackerHits: [hit({})] })]);
check('rules: missing cmp flagged', noCmp.some((f) => f.id === 'banner_missing_cmp' && f.severity === 'high'));

// Form findings flow through.
const formCapture = capture({
  forms: analyzeForms([newsletterForm], 'https://example.com'),
});
check('rules: form findings mapped', evaluateFormFindings([formCapture]).some((f) => f.domain === 'forms' && f.severity === 'high'));

// ── scoring ────────────────────────────────────────────────────────────────

check('score: clean = 100', scoreFindings([]).score === 100 && scoreFindings([]).verdict === 'compliant_looking');
const scored = scoreFindings(sortFindings(preConsent));
check('score: violations reduce score', scored.score < 100);
const sorted = sortFindings([...noCmp, ...advanced]);
check('sort: severity order', sorted[0].severity === 'high' && sorted[sorted.length - 1].severity === 'info');

// ── engine bridge ───────────────────────────────────────────────────────────

const runtime = buildRuntimeInput([capture({ trackerHits: [hit({})] }), rejectCapture]);
check('bridge: states mapped', runtime.states.includes('unknown') && runtime.states.includes('default_denied'));
check('bridge: pages mapped', runtime.pages.length === 2 && runtime.pages[0].trackerHits?.length === 1);
check('bridge: firstMeasurementTMs', runtime.pages[0].firstMeasurementTMs === 1000);
check('bridge: ok flag', runtime.ok === true);

const engineFindings = runConsentRuntimeRules(runtime);
check('bridge: engine accepts runtime input', Array.isArray(engineFindings));
check('bridge: engine emits consent findings', engineFindings.every((f) => f.domain === 'consent'));

// ── GTM container bridge (reconciled coverage) ──────────────────────────────

// A "full" export_container payload: raw GTM API objects with parameters and
// per-tag consentSettings present.
const fullContainer = {
  exportedAt: '2026-06-15T00:00:00Z',
  workspace: { name: 'Default Workspace' },
  tags: [
    {
      tagId: '1',
      name: 'GA4 Configuration',
      type: 'gaawc',
      parameter: [{ key: 'measurementId', value: 'G-ABC123' }],
      consentSettings: { consentStatus: 'NEEDED' },
      firingTriggerId: ['2147479553'],
    },
    {
      tagId: '2',
      name: 'Meta Pixel Base',
      type: 'html',
      parameter: [{ key: 'html', value: '<script>fbq("init","123")</script>' }],
      consentSettings: { consentStatus: 'NOT_SET' },
    },
  ],
  triggers: [{ triggerId: '2147479553', name: 'Consent Initialization All Pages', type: 'consentInit' }],
  variables: [
    { variableId: '1', name: 'Consent — ad_storage', type: 'k', parameter: [{ key: 'name', value: 'ad_storage' }] },
  ],
};

const parsed = parseGtmContainer(fullContainer);
check('gtm: tags parsed', parsed.tags.length === 2);
check('gtm: triggers parsed', parsed.triggers.length === 1);
check('gtm: variables parsed', parsed.variables.length === 1);
check('gtm: textBlob lowercased + includes tag name', parsed.textBlob.includes('ga4 configuration'));
check('gtm: textBlob includes param value', parsed.textBlob.includes('g-abc123'));
check('gtm: textBlob includes variable param', parsed.textBlob.includes('ad_storage'));
check('gtm: textBlob excludes trigger names', !parsed.textBlob.includes('consent initialization all pages'));
check('gtm: usageContexts default empty', parsed.usageContexts.length === 0);

// Nested under a `container` key, with usageContext.
const nested = parseGtmContainer({ container: { usageContext: ['SERVER'], tags: fullContainer.tags, triggers: [], variables: [] } });
check('gtm: nested container tags', nested.tags.length === 2);
check('gtm: usageContexts lowercased', nested.usageContexts.join(',') === 'server');

// Defensive rejections.
let summaryRejected = false;
try {
  parseGtmContainer({ tags: [{ tagId: '1', name: 'GA4', type: 'gaawc', paramCount: 3 }], triggers: [], variables: [] });
} catch (e) {
  summaryRejected = e instanceof GtmContainerError;
}
check('gtm: summary export rejected', summaryRejected);

let emptyRejected = false;
try {
  parseGtmContainer({});
} catch (e) {
  emptyRejected = e instanceof GtmContainerError;
}
check('gtm: empty object rejected', emptyRejected);

let nullRejected = false;
try {
  parseGtmContainer(null);
} catch (e) {
  nullRejected = e instanceof GtmContainerError;
}
check('gtm: null rejected', nullRejected);

// runConsentEngine: coverage escalation.
const baseCaptures = [capture({ trackerHits: [hit({})] }), rejectCapture];

const engNone = await runConsentEngine(baseCaptures, undefined);
check('engine: no container → runtime_only', engNone.coverage === 'runtime_only');
check('engine: runtime-only findings are consent', engNone.findings.every((f) => f.domain === 'consent'));

const engRecon = await runConsentEngine(baseCaptures, fullContainer);
check('engine: full container → reconciled', engRecon.coverage === 'reconciled', engRecon.coverage);
check('engine: reconciled has no note', engRecon.note === undefined);

const engBad = await runConsentEngine(baseCaptures, { tags: [{ name: 'x', paramCount: 2 }], triggers: [], variables: [] });
check('engine: bad container → runtime_only + note', engBad.coverage === 'runtime_only' && typeof engBad.note === 'string');
check('engine: bad-container note mentions full', /full/i.test(engBad.note ?? ''));

// ── HTTP transport helpers ──────────────────────────────────────────────────

check('http: no token → open', isAuthorized(undefined, ''));
check('http: no token ignores header', isAuthorized('Bearer whatever', ''));
check('http: correct bearer accepted', isAuthorized('Bearer s3cret', 's3cret'));
check('http: wrong bearer rejected', !isAuthorized('Bearer nope', 's3cret'));
check('http: missing header with token rejected', !isAuthorized(undefined, 's3cret'));
check('http: bare token without scheme rejected', !isAuthorized('s3cret', 's3cret'));
check('http: length-mismatch rejected', !isAuthorized('Bearer s3cre', 's3cret'));

const health = buildHealthBody({
  activeSessions: 2,
  playwrightAvailable: true,
  authRequired: true,
  config: loadConfig(),
});
check('http: health status ok', health.status === 'ok' && health.transport === 'http');
check('http: health reports sessions', health.activeSessions === 2);
check('http: health reports playwright + auth', health.playwrightAvailable === true && health.authRequired === true);
check('http: health surfaces config', typeof health.config.interactionEnabled === 'boolean' && Array.isArray(health.config.allowlist));

// ── tag-presence reconciliation (configured vs fired) ───────────────────────

const reconContainer = {
  tags: [
    { name: 'GA4 Config', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-ABC123' }] },
    { name: 'Ads Conversion', type: 'awct', parameter: [{ key: 'conversionId', value: 'AW-123456789/AbCdEf' }] },
    { name: 'Paused Meta', type: 'html', paused: true, parameter: [{ key: 'html', value: "<script>fbq('init','111222333')</script>" }] },
  ],
  triggers: [],
  variables: [],
};

const cfgDests = extractConfiguredDestinations(reconContainer);
check('reconcile: extracts GA4 measurement id', cfgDests.some((d) => d.vendor === 'ga4' && d.id === 'G-ABC123'));
check('reconcile: normalizes Ads id (drops /label)', cfgDests.some((d) => d.vendor === 'google_ads' && d.id === 'AW-123456789'));
check('reconcile: skips a paused tag', !cfgDests.some((d) => d.vendor === 'meta'));

// Real capture shapes: GA4 carries query.tid; the Meta pixel id is ONLY in the
// /tr url (the pipeline keeps query for GA4 hits only); the gtm.js loader is not
// a firing destination.
const reconCaptures = [
  capture({
    trackerHits: [
      hit({ url: 'https://region1.google-analytics.com/g/collect?v=2&tid=G-XYZ999', query: { tid: 'G-XYZ999' } }),
      hit({ url: 'https://www.facebook.com/tr?id=111222333&ev=PageView', ids: ['meta_pixel'], groups: ['meta'] }),
      hit({ url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX', ids: ['gtm_loader'], groups: ['gtm'] }),
    ],
  }),
];
const obsDests = extractObservedDestinations(reconCaptures);
check('reconcile: observes GA4 tid', obsDests.some((d) => d.vendor === 'ga4' && d.id === 'G-XYZ999'));
check('reconcile: observes Meta pixel id from the /tr url', obsDests.some((d) => d.vendor === 'meta' && d.id === '111222333'));
check('reconcile: gtm.js loader is not an observed destination', !obsDests.some((d) => d.source.includes('gtm.js')));

// Consent was granted (an accept capture ran) → configured-but-never-fired is meaningful.
const rec = reconcile(reconContainer, reconCaptures, { consentGranted: true });
const reconIds = rec.findings.map((f) => f.id);
check('reconcile: GA4 measurement id mismatch flagged', reconIds.includes('ga4_measurement_id_mismatch'));
check('reconcile: Ads configured-but-not-fired flagged', reconIds.includes('configured_not_fired_google_ads'));
check('reconcile: Meta fired-but-not-configured flagged', reconIds.includes('fired_not_configured_meta'));
check('reconcile: configured_not_fired is low severity', rec.findings.find((f) => f.id === 'configured_not_fired_google_ads')?.severity === 'low');
check('reconcile: per-vendor summary records GA4 configured+fired', rec.byVendor.some((v) => v.vendor === 'ga4' && v.configured && v.fired));

// Without a consent-granted capture, a non-firing configured vendor is NOT flagged (it may be consent-gated).
const recNoConsent = reconcile(reconContainer, reconCaptures, { consentGranted: false });
check('reconcile: configured_not_fired suppressed without a consent grant', !recNoConsent.findings.some((f) => f.id.startsWith('configured_not_fired')));

// A googtag carrying an AW- id is Google Ads, not GA4.
const googtagDests = extractConfiguredDestinations({ tags: [{ name: 'GTag', type: 'googtag', parameter: [{ key: 'tagId', value: 'AW-555' }] }], triggers: [], variables: [] });
check('reconcile: googtag with AW- id is google_ads', googtagDests.some((d) => d.vendor === 'google_ads' && d.id === 'AW-555'));
check('reconcile: googtag with AW- id is not GA4', !googtagDests.some((d) => d.vendor === 'ga4'));

// GA4 id is matched only in a real gtag context, not arbitrary "G-FORCE" text.
const noiseHtml = extractConfiguredDestinations({ tags: [{ name: 'Promo', type: 'html', parameter: [{ key: 'html', value: '<div class="G-FORCE">G-WAGON sale</div>' }] }], triggers: [], variables: [] });
check('reconcile: arbitrary G-XXXX text in HTML is not a GA4 destination', !noiseHtml.some((d) => d.vendor === 'ga4'));
const realHtml = extractConfiguredDestinations({ tags: [{ name: 'gtag', type: 'html', parameter: [{ key: 'html', value: "gtag('config','G-REALID1234')" }] }], triggers: [], variables: [] });
check('reconcile: gtag config G- id in HTML is detected', realHtml.some((d) => d.vendor === 'ga4' && d.id === 'G-REALID1234'));

// A GA4 Google-signals / remarketing ping (no conversion id) is not an Ads destination.
const signalsObs = extractObservedDestinations([
  capture({ trackerHits: [hit({ url: 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123/?', ids: ['google_ads'], groups: ['google_ads'] })] }),
]);
check('reconcile: google-signals remarketing ping is not an Ads destination', !signalsObs.some((d) => d.vendor === 'google_ads'));

// Malformed captures don't throw (matches the module's tolerant posture).
check('reconcile: tolerates malformed captures', extractObservedDestinations([{}, { trackerHits: null }] as unknown as ScenarioCapture[]).length === 0);

// A matched container (same GA4 id fired, nothing else) produces no reconcile findings.
const cleanRec = reconcile(
  { tags: [{ name: 'GA4', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-ABC123' }] }], triggers: [], variables: [] },
  [capture({ trackerHits: [hit({ url: 'https://r.google-analytics.com/g/collect?tid=G-ABC123', query: { tid: 'G-ABC123' } })] })],
);
check('reconcile: matched GA4 yields no reconcile findings', cleanRec.findings.length === 0);

// ── report ──────────────────────────────────────────────────────────────────

console.log(`web-audit tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
if (passed < 60) {
  console.error(`expected at least 60 checks to run, got ${passed}`);
  process.exit(1);
}
