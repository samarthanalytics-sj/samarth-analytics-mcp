/**
 * Measurement install-plan engine — pure-logic tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/install-plan.node.test.ts
 */
import assert from 'node:assert';
import { buildFormInstallPlan, formListenerHtml, type InstallRequirement } from '../install-plan.js';
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

console.log(`\nInstall-plan: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
