/**
 * Measurement install-plan engine — pure-logic tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/install-plan.node.test.ts
 */
import assert from 'node:assert';
import { buildFormInstallPlan, buildTriggerInstallPlan, formListenerHtml, type InstallRequirement } from '../install-plan.js';
import { buildSuggestions } from '../suggest.js';
import type { DetectedForm } from '../types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Narrowing helpers so the assertions read cleanly.
const only = (rs: InstallRequirement[], kind: InstallRequirement['kind']): InstallRequirement[] =>
  rs.filter((r) => r.kind === kind);
const listener = (rs: InstallRequirement[]) =>
  rs.find((r): r is Extract<InstallRequirement, { kind: 'listener-tag' }> => r.kind === 'listener-tag');
const siteCode = (rs: InstallRequirement[]) =>
  rs.find((r): r is Extract<InstallRequirement, { kind: 'site-code' }> => r.kind === 'site-code');

// ── native form ───────────────────────────────────────────────────────────────
{
  const plan = buildFormInstallPlan({ provider: 'unknown', mechanism: 'native', dlEvent: null, formHasNativeForm: true });
  check('native: single native requirement', only(plan.requires, 'native').length === 1);
  check('native: no listener tag', !listener(plan.requires));
  check('native: no html-attribute when nothing is missing? (id absent → recommend one)',
    only(plan.requires, 'html-attribute').length === 1);
  check('native: summary says nothing to install', /nothing to install/i.test(plan.summary));
}
{
  // Native WITH a stable id → no html-attribute recommendation.
  const plan = buildFormInstallPlan({ provider: 'unknown', mechanism: 'native', dlEvent: null, formId: 'contact-42', formHasNativeForm: true });
  check('native+id: no html-attribute requirement', only(plan.requires, 'html-attribute').length === 0);
  check('native+id: still native', only(plan.requires, 'native').length === 1);
}

// ── HubSpot (embed) → listener-tag ─────────────────────────────────────────────
{
  const plan = buildFormInstallPlan({ provider: 'hubspot', mechanism: 'embed', dlEvent: 'hubspot-form-success', formHasNativeForm: false });
  const l = listener(plan.requires);
  check('hubspot: emits a listener-tag', !!l);
  check('hubspot: listener event === dlEvent', l?.event === 'hubspot-form-success');
  check('hubspot: html contains hsFormCallback', !!l && l.tag.html.includes('hsFormCallback'));
  check('hubspot: html contains the dlEvent', !!l && l.tag.html.includes('hubspot-form-success'));
  check('hubspot: no site-code', !siteCode(plan.requires));
  check('hubspot: summary mentions auto-create', /auto-create/i.test(plan.summary));
}

// ── Contact Form 7 (ajax) → wpcf7mailsent listener ─────────────────────────────
{
  const plan = buildFormInstallPlan({ provider: 'contactform7', mechanism: 'ajax', dlEvent: 'cf7submission', formHasNativeForm: true });
  const l = listener(plan.requires);
  check('cf7: emits a listener-tag', !!l);
  check('cf7: html contains wpcf7mailsent', !!l && l.tag.html.includes('wpcf7mailsent'));
  check('cf7: html contains the dlEvent', !!l && l.tag.html.includes('cf7submission'));
}

// ── generic JS form WITH a real <form> → delegated capture-phase submit listener ─
{
  const plan = buildFormInstallPlan({
    provider: 'unknown', mechanism: 'js', dlEvent: 'form_submit', formId: 'quote', selector: '#quote', formHasNativeForm: true,
  });
  const l = listener(plan.requires);
  check('generic-js: emits a listener-tag', !!l);
  check('generic-js: uses a delegated submit listener', !!l && /addEventListener\("submit"/.test(l.tag.html));
  check('generic-js: is a capture-phase delegate (3rd arg true)', !!l && /\},\s*true\);/.test(l.tag.html));
  check('generic-js: references the selector', !!l && l.tag.html.includes('#quote'));
  check('generic-js: matches on f.matches', !!l && /f\.matches/.test(l.tag.html));
}

// ── unknown vendor with no recipe (embed) → site-code, NOT a wrong listener ─────
{
  const plan = buildFormInstallPlan({ provider: 'paperform', mechanism: 'embed', dlEvent: 'form_submit', formHasNativeForm: false });
  check('unknown-vendor: emits site-code', !!siteCode(plan.requires));
  check('unknown-vendor: NO listener-tag (would be a wrong guess)', !listener(plan.requires));
  check('unknown-vendor: snippet carries a TODO', !!siteCode(plan.requires) && /TODO/.test(siteCode(plan.requires)!.snippet));
  check('unknown-vendor: snippet guards window.dataLayer', !!siteCode(plan.requires) && /window\.dataLayer/.test(siteCode(plan.requires)!.snippet));
}

// ── every listener-tag html is a <script> and pushes to dataLayer ──────────────
{
  const providers: Array<{ p: string; m: 'embed' | 'ajax'; e: string }> = [
    { p: 'hubspot', m: 'embed', e: 'hubspot-form-success' },
    { p: 'marketo', m: 'embed', e: 'form_submit' },
    { p: 'contactform7', m: 'ajax', e: 'cf7submission' },
    { p: 'gravityforms', m: 'ajax', e: 'gravityFormSubmission' },
    { p: 'ninjaforms', m: 'ajax', e: 'ninjaFormSubmission' },
    { p: 'wpforms', m: 'ajax', e: 'wpformsSubmission' },
    { p: 'elementor', m: 'ajax', e: 'elementorFormSubmission' },
    { p: 'typeform', m: 'embed', e: 'form_submit' },
    { p: 'calendly', m: 'embed', e: 'form_submit' },
  ];
  let allOk = true;
  for (const { p, m, e } of providers) {
    const plan = buildFormInstallPlan({ provider: p, mechanism: m, dlEvent: e, formHasNativeForm: m === 'ajax' });
    const l = listener(plan.requires);
    if (!l) { allOk = false; failures.push(`✗ listener-all: ${p} emitted no listener`); continue; }
    const html = l.tag.html;
    if (!/^<script>/.test(html) || !/<\/script>$/.test(html)) { allOk = false; failures.push(`✗ listener-all: ${p} not wrapped in <script>`); }
    if (!html.includes('dataLayer')) { allOk = false; failures.push(`✗ listener-all: ${p} missing dataLayer`); }
    if (!html.includes(e)) { allOk = false; failures.push(`✗ listener-all: ${p} missing event ${e}`); }
    if (l.tag.fires !== 'all_pages') { allOk = false; failures.push(`✗ listener-all: ${p} not all_pages`); }
  }
  check('listener-all: every provider listener is a <script> that pushes dataLayer with its event on All Pages', allOk);
}

// jQuery-based recipes must guard for jQuery presence.
{
  for (const p of ['gravityforms', 'ninjaforms', 'elementor']) {
    const html = formListenerHtml(p, 'x') ?? '';
    check(`jquery-guard: ${p} guards window.jQuery`, /if\(!window\.jQuery\)return/.test(html));
    check(`jquery-guard: ${p} uses jQuery(document).on`, /jQuery\(document\)\.on/.test(html));
  }
}

// formListenerHtml returns null for a vendor with no recipe.
{
  check('formListenerHtml: null for an unmodelled vendor', formListenerHtml('jotform', 'x') === null);
  check('formListenerHtml: generic-submit routes', (formListenerHtml('generic-submit', 'x', 'form') ?? '').includes('addEventListener("submit"'));
  check('formListenerHtml: generic-click routes', (formListenerHtml('generic-click', 'x', 'button') ?? '').includes('addEventListener("click"'));
}

// A couple of node:assert sanity checks (the harness `check` above covers the rest).
assert.ok(buildFormInstallPlan({ provider: 'hubspot', mechanism: 'embed', dlEvent: 'e', formHasNativeForm: false }).requires.length >= 1);
assert.strictEqual(
  buildFormInstallPlan({ provider: 'unknown', mechanism: 'native', dlEvent: null, formId: 'x', formHasNativeForm: true }).requires[0].kind,
  'native',
);

// ── END-TO-END: a HubSpot form SuggestedTag now carries install.requires ───────
{
  const hubForm: DetectedForm = {
    page: '/contact', purpose: 'contact', action: 'https://js.hsforms.net/x',
    provider: { vendor: 'hubspot', confidence: 'high', evidence: 'script js.hsforms.net' }, method: 'js',
  };
  const out = buildSuggestions({ siteHost: 'acme.com', forms: [hubForm], elements: [] });
  const tag = out[0];
  check('e2e: suggestion carries an install plan', !!tag.install && Array.isArray(tag.install.requires));
  const l = tag.install && listener(tag.install.requires);
  check('e2e: install has a listener-tag', !!l);
  check('e2e: listener event === the tag custom_event trigger eventName',
    !!l && l.event === tag.trigger.eventName && tag.trigger.kind === 'custom_event',
    `listener=${l?.event} trigger=${tag.trigger.eventName}`);
  check('e2e: existing human note is preserved alongside install', !!tag.note && /custom event/i.test(tag.note));
}

// ── buildTriggerInstallPlan: NATIVE trigger kinds → a "nothing to install" native plan ──────────────
{
  for (const kind of ['link_click', 'all_clicks', 'pageview', 'timer', 'youtube_video', 'form_submit']) {
    const plan = buildTriggerInstallPlan({ kind });
    check(`trigger-native: ${kind} → single native requirement`, only(plan.requires, 'native').length === 1 && plan.requires.length === 1);
    check(`trigger-native: ${kind} → no site-code`, !siteCode(plan.requires));
    check(`trigger-native: ${kind} → summary says nothing to install`, /nothing to install/i.test(plan.summary));
  }
  // link_click / youtube_video carry a specific, recognisable native detail.
  check('trigger-native: link_click detail names Just Links', /Just Links/.test((buildTriggerInstallPlan({ kind: 'link_click' }).requires[0] as { detail: string }).detail));
  check('trigger-native: youtube_video detail names the YouTube Video trigger', /YouTube Video/.test((buildTriggerInstallPlan({ kind: 'youtube_video' }).requires[0] as { detail: string }).detail));
}

// ── buildTriggerInstallPlan: a NON-ecommerce custom_event → site-code with the bare dataLayer push ───
{
  const plan = buildTriggerInstallPlan({ kind: 'custom_event', eventName: 'newsletter_signup' });
  const sc = siteCode(plan.requires);
  check('trigger-custom: emits site-code', !!sc);
  check('trigger-custom: NO native requirement', only(plan.requires, 'native').length === 0);
  check('trigger-custom: snippet pushes the event', !!sc && sc.snippet.includes('newsletter_signup') && /dataLayer\.push/.test(sc.snippet));
  check('trigger-custom: snippet is NOT ecommerce-shaped', !!sc && !/ecommerce/.test(sc.snippet));
  check('trigger-custom: snippet guards window.dataLayer', !!sc && /window\.dataLayer=window\.dataLayer\|\|\[\]/.test(sc.snippet));
  check('trigger-custom: summary says the site must push the event', /must push the "newsletter_signup" dataLayer event/i.test(plan.summary));
  check('trigger-custom: detail says GA4 does not auto-collect it', !!sc && /does not auto-collect/i.test(sc.detail));
}

// ── buildTriggerInstallPlan: an ECOMMERCE custom_event (add_to_cart) → ecommerce-shaped snippet ──────
{
  const plan = buildTriggerInstallPlan({ kind: 'custom_event', eventName: 'add_to_cart' });
  const sc = siteCode(plan.requires);
  check('trigger-ecommerce: emits site-code', !!sc);
  check('trigger-ecommerce: snippet contains the event name', !!sc && sc.snippet.includes('add_to_cart'));
  check('trigger-ecommerce: snippet carries the ecommerce object', !!sc && /ecommerce/.test(sc.snippet) && /items/.test(sc.snippet));
  check('trigger-ecommerce: detail requires the GA4 ecommerce object', !!sc && /GA4 ecommerce object/i.test(sc.detail));
  // purchase additionally requires transaction_id.
  const purchase = siteCode(buildTriggerInstallPlan({ kind: 'custom_event', eventName: 'purchase' }).requires);
  check('trigger-ecommerce: purchase snippet + detail require transaction_id', !!purchase && /transaction_id/.test(purchase.snippet) && /transaction_id/.test(purchase.detail));
}

// ── END-TO-END via buildSuggestions: every NON-form suggestion now carries an install plan ──────────
{
  const out = buildSuggestions({
    siteHost: 'acme.com',
    forms: [],
    elements: [
      { page: '/', kind: 'email', text: 'Email us' },        // → link_click (native)
      { page: '/', kind: 'phone', text: 'Call us' },          // → link_click (native)
    ],
    videoEmbeds: [{ page: '/', provider: 'youtube' }],        // → youtube_video (native)
    websiteType: 'ecommerce',                                 // → add_to_cart etc. (custom_event, ecommerce)
  }, { full: true });
  check('e2e: EVERY suggestion carries an install plan', out.every((s) => !!s.install && Array.isArray(s.install.requires) && s.install.requires.length >= 1));
  // A mailto/link_click element → native.
  const mailto = out.find((s) => s.trigger.kind === 'link_click' && s.eventName === 'email_click');
  check('e2e: mailto (link_click) → install.requires[0].kind === "native"', !!mailto && mailto.install!.requires[0].kind === 'native');
  // The YouTube video suggestion → native.
  const yt = out.find((s) => s.trigger.kind === 'youtube_video');
  check('e2e: youtube_video → install.requires[0].kind === "native"', !!yt && yt.install!.requires[0].kind === 'native');
  // An ecommerce add_to_cart custom_event → site-code with a snippet naming add_to_cart + ecommerce.
  const atc = out.find((s) => s.eventName === 'add_to_cart' && s.trigger.kind === 'custom_event');
  const atcCode = atc && siteCode(atc.install!.requires);
  check('e2e: add_to_cart (custom_event) → install.requires[0].kind === "site-code"', !!atc && atc.install!.requires[0].kind === 'site-code');
  check('e2e: add_to_cart site-code snippet contains "add_to_cart" and "ecommerce"', !!atcCode && atcCode.snippet.includes('add_to_cart') && atcCode.snippet.includes('ecommerce'));
  // The base google_tag (GA4 Configuration) → a non-empty NATIVE install plan (no confusing empty panel).
  const cfg = out.find((s) => s.platform === 'google_tag');
  check('e2e: base google_tag carries a non-empty install plan', !!cfg && !!cfg.install && cfg.install.requires.length >= 1);
  check('e2e: base google_tag install is native (loads on All Pages)', !!cfg && cfg.install!.requires[0].kind === 'native');
}

// ── Derived platform copies (Meta) inherit the install plan from their GA4 source ───────────────────
{
  const out = buildSuggestions({
    siteHost: 'acme.com',
    forms: [],
    elements: [{ page: '/', kind: 'email', text: 'Email us' }],
    websiteType: 'ecommerce',
  }, { full: true, platforms: ['ga4', 'meta'] });
  const meta = out.filter((s) => s.platform === 'meta_pixel');
  check('derivers: Meta counterparts are emitted', meta.length >= 1);
  check('derivers: every Meta copy carries the inherited install plan', meta.every((s) => !!s.install && s.install.requires.length >= 1));
}

// ── Forms are UNCHANGED — still use buildFormInstallPlan (listener/site plan, not the generic one) ───
{
  const out = buildSuggestions({
    siteHost: 'acme.com',
    forms: [{ page: '/contact', purpose: 'contact', action: 'https://js.hsforms.net/x', provider: { vendor: 'hubspot', confidence: 'high', evidence: 'js.hsforms.net' }, method: 'js', formId: 'hsForm_1' }],
    elements: [],
  }, { full: true });
  const form = out.find((s) => s.platform === 'ga4_event' && s.trigger.kind === 'custom_event' && /hubspot/i.test(s.evidence));
  check('forms-unchanged: HubSpot form still carries a listener-tag install (buildFormInstallPlan), not a generic site-code', !!form && !!listener(form.install!.requires));
}

console.log(`\nInstall-plan: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
