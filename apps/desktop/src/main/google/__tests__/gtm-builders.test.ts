import assert from 'node:assert/strict';
import {
  buildGa4EventTag,
  buildGoogleTag,
  buildGoogleAdsConversionTag,
  buildCustomHtmlTag,
  buildTrigger,
  applyTriggerWaitDefaults,
  consentTypesFor,
  detectAdPixel,
  triggerBuiltInVars,
  builtInVarsForTemplates,
  buildVariable,
  auditContainer,
  sanitizeName,
  findGa4BaseTag,
  ga4VariablePlan,
} from '../gtm-builders';

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

const findParam = (params: Array<Record<string, unknown>>, key: string) => params.find((p) => p.key === key);

console.log('\nGTM builders:');

test('GA4 event tag: gaawe event params use eventSettingsTable (parameter/parameterValue), not eventParameters', () => {
  const t = buildGa4EventTag({
    name: 'GA4 - email',
    measurementId: 'G-ABC',
    eventName: 'email_click',
    eventParameters: [{ name: 'link_url', value: '{{Click URL}}' }],
    firingTriggerId: ['T1'],
  });
  assert.equal(t.type, 'gaawe');
  assert.equal(findParam(t.parameter, 'eventName')?.value, 'email_click');
  assert.equal(findParam(t.parameter, 'measurementIdOverride')?.value, 'G-ABC');
  // empty tagReference measurementId is required alongside the override
  assert.equal(findParam(t.parameter, 'measurementId')?.type, 'tagReference');
  // Corpus-correct: the OLD `eventParameters` key (0 of 8,148 real tags) is gone.
  assert.equal(findParam(t.parameter, 'eventParameters'), undefined, 'no eventParameters key');
  const est = findParam(t.parameter, 'eventSettingsTable') as { type: string; list: Array<{ type: string; map: Array<Record<string, unknown>> }> };
  assert.equal(est.type, 'list');
  assert.equal(est.list[0].type, 'map');
  // Inner maps are keyed parameter/parameterValue, not name/value.
  assert.equal(est.list[0].map.find((m) => m.key === 'parameter')?.value, 'link_url');
  assert.equal(est.list[0].map.find((m) => m.key === 'parameterValue')?.value, '{{Click URL}}');
  assert.equal(est.list[0].map.find((m) => m.key === 'name'), undefined);
  assert.deepEqual(t.firingTriggerId, ['T1']);
});

test('Google tag: googtag carries tagId, and config settings use configSettingsTable maps', () => {
  const t = buildGoogleTag({
    name: 'Google tag - GA4',
    tagId: 'G-XYZ',
    configSettings: [{ name: 'send_page_view', value: 'false' }],
    firingTriggerId: ['T1'],
  });
  assert.equal(t.type, 'googtag');
  assert.equal(findParam(t.parameter, 'tagId')?.value, 'G-XYZ');
  const cfg = findParam(t.parameter, 'configSettingsTable') as { type: string; list: Array<{ map: Array<Record<string, unknown>> }> };
  assert.equal(cfg.type, 'list');
  assert.equal(cfg.list[0].map.find((m) => m.key === 'parameter')?.value, 'send_page_view');
  assert.equal(cfg.list[0].map.find((m) => m.key === 'parameterValue')?.value, 'false');
  assert.deepEqual(t.firingTriggerId, ['T1']);
});

test('Google tag: no config settings → just the tagId param', () => {
  const t = buildGoogleTag({ name: 'GT', tagId: '{{Measurement ID}}' });
  assert.equal(t.type, 'googtag');
  assert.equal(t.parameter.length, 1);
  assert.equal(findParam(t.parameter, 'tagId')?.value, '{{Measurement ID}}');
});

test('Google Ads conversion tag: awct strips the AW- prefix (GTM wants the numeric id)', () => {
  const t = buildGoogleAdsConversionTag({ name: 'Ads', conversionId: 'AW-123456789', conversionLabel: 'L1' });
  assert.equal(t.type, 'awct');
  // GTM rejects "AW-123456789" — the conversionId must be the bare number.
  assert.equal(findParam(t.parameter, 'conversionId')?.value, '123456789');
  assert.equal(findParam(t.parameter, 'conversionLabel')?.value, 'L1');
  // A bare numeric id and a {{variable}} ref pass through unchanged.
  assert.equal(findParam(buildGoogleAdsConversionTag({ name: 'A', conversionId: '  987 ', conversionLabel: 'x' }).parameter, 'conversionId')?.value, '987');
  assert.equal(findParam(buildGoogleAdsConversionTag({ name: 'A', conversionId: '{{AW Conversion ID}}', conversionLabel: 'x' }).parameter, 'conversionId')?.value, '{{AW Conversion ID}}');
});

test('Custom HTML tag: html type + snippet', () => {
  const t = buildCustomHtmlTag({ name: 'FB', html: '<script>fbq()</script>' });
  assert.equal(t.type, 'html');
  assert.equal(findParam(t.parameter, 'html')?.value, '<script>fbq()</script>');
});

test('link_click trigger: linkClick + {{Click URL}} scope in filter (NOT autoEventFilter), needs clickUrl var', () => {
  const tr = buildTrigger({ name: 'Email link click', kind: 'link_click', clickUrlValue: 'mailto:' });
  assert.equal(tr.type, 'linkClick');
  assert.equal(tr.autoEventFilter, undefined, 'scope conditions go in filter, not autoEventFilter (corpus-verified)');
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'contains');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Click URL}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'mailto:');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'link_click', clickUrlValue: 'mailto:' }), ['clickUrl']);
});

test('names: GTM-invalid ":" is stripped from tag + trigger names (was failing creation)', () => {
  assert.equal(sanitizeName('All Clicks - CTA: Apply Now'), 'All Clicks - CTA Apply Now');
  assert.equal(sanitizeName('  weird   <name>:x  '), 'weird name x');
  assert.equal(sanitizeName(''), 'Unnamed');
  // Applied at the create boundary so a colon never reaches the GTM API.
  assert.equal(buildTrigger({ name: 'CTA: Apply Now', kind: 'all_clicks', clickTextValue: 'Apply Now' }).name, 'CTA Apply Now');
  assert.equal(buildGa4EventTag({ name: 'GA4 Event - Sale: 50% Tag', measurementId: '{{GA4 Measurement ID}}', eventName: 'e' }).name, 'GA4 Event - Sale 50% Tag');
});

test('all_clicks trigger: {{Click Text}} filter (CTA) + needs clickText var', () => {
  const tr = buildTrigger({ name: 'CTA click - Book a demo', kind: 'all_clicks', clickTextValue: 'Book a demo', clickTextOperator: 'contains' });
  assert.equal(tr.type, 'click');
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'contains');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Click Text}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'Book a demo');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'all_clicks', clickTextValue: 'Book a demo' }), ['clickText']);
});

test('click trigger: clickUrl AND clickText conditions are both emitted (AND-ed) in filter', () => {
  const tr = buildTrigger({ name: 'x', kind: 'all_clicks', clickUrlValue: '/buy', clickTextValue: 'Buy' });
  assert.equal((tr.filter ?? []).length, 2);
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'all_clicks', clickUrlValue: '/buy', clickTextValue: 'Buy' }), ['clickUrl', 'clickText']);
});

test('builtInVarsForTemplates: maps built-in var refs, ignores user variables', () => {
  const keys = builtInVarsForTemplates(['{{Click URL}}', '{{Click Text}}', '{{Form ID}}', '{{Form URL}}', '{{GA4 Measurement ID}}', 'static']);
  assert.deepEqual(new Set(keys), new Set(['clickUrl', 'clickText', 'formId', 'formUrl']));
  // {{GA4 Measurement ID}} is a USER variable, not a built-in → not enabled.
  assert.ok(!keys.includes('measurementId' as never) && !keys.some((k) => /measurement/i.test(k)));
  assert.deepEqual(builtInVarsForTemplates([undefined, '', 'no refs']), []);
});

test('custom_event trigger: customEvent + {{_event}} filter', () => {
  const tr = buildTrigger({ name: 'purchase', kind: 'custom_event', eventName: 'purchase' });
  assert.equal(tr.type, 'customEvent');
  const f = (tr.customEventFilter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{_event}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'purchase');
});

test('form_submit trigger: scoped to one form by {{Form ID}} in filter, needs formId var', () => {
  const tr = buildTrigger({ name: 'Contact Form Trigger', kind: 'form_submit', formIdValue: 'contact-form' });
  assert.equal(tr.type, 'formSubmission');
  assert.equal(tr.autoEventFilter, undefined, 'form scope goes in filter, not autoEventFilter');
  // Wait-for-Tags + Check-Validation are explicitly OFF — as DEDICATED top-level
  // fields (single Parameter, no key), not entries in a generic parameter[].
  assert.equal((tr as { waitForTags?: { type: string; value: string; key?: string } }).waitForTags?.value, 'false');
  assert.equal((tr as { waitForTags?: { key?: string } }).waitForTags?.key, undefined);
  assert.equal((tr as { checkValidation?: { value: string } }).checkValidation?.value, 'false');
  assert.equal((tr as { parameter?: unknown }).parameter, undefined);
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'equals');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Form ID}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'contact-form');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'form_submit', formIdValue: 'contact-form' }), ['formId']);
});

test('youtube_video trigger: youTubeVideo type, capture params in parameter[], enables Video built-ins', () => {
  const tr = buildTrigger({ name: 'YouTube Video Trigger', kind: 'youtube_video' });
  assert.equal(tr.type, 'youTubeVideo');
  const p = ((tr as { parameter?: Array<Record<string, unknown>> }).parameter ?? []);
  assert.equal(p.find((x) => x.key === 'captureStart')?.value, 'true');
  assert.equal(p.find((x) => x.key === 'captureComplete')?.value, 'true');
  assert.equal(p.find((x) => x.key === 'captureProgress')?.value, 'true');
  assert.equal(p.find((x) => x.key === 'capturePause')?.value, 'false', 'Pause off — not a GA4 recommended video event');
  assert.equal(p.find((x) => x.key === 'progressThresholdsPercent')?.value, '25,50,75,90');
  assert.equal(p.find((x) => x.key === 'radioButtonGroup1')?.value, 'PERCENTAGE');
  // No form fields here (those are a different trigger type).
  assert.equal((tr as { waitForTags?: unknown }).waitForTags, undefined);
  // The Video built-in variables are auto-enabled so the tag's {{Video …}} resolve.
  const vars = triggerBuiltInVars({ name: 'x', kind: 'youtube_video' });
  assert.ok(vars.includes('videoTitle') && vars.includes('videoStatus') && vars.includes('videoPercent') && vars.includes('videoProvider'));
});

test('builtInVarsForTemplates: maps {{Video …}} display names (incl. in an event name) to keys', () => {
  const keys = builtInVarsForTemplates(['{{Video Title}}', 'video_{{Video Status}}', '{{Video Percent}}', '{{Page Path}}']);
  assert.deepEqual(new Set(keys), new Set(['videoTitle', 'videoStatus', 'videoPercent', 'pagePath']));
});

test('form_submit trigger: no form filter → fires on ALL forms (no filter)', () => {
  const tr = buildTrigger({ name: 'All Forms Trigger', kind: 'form_submit' });
  assert.equal(tr.type, 'formSubmission');
  assert.equal(tr.filter, undefined);
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'form_submit' }), []);
});

test('form_submit trigger: {{Form Classes}} contains in filter when no id', () => {
  const tr = buildTrigger({ name: 't', kind: 'form_submit', formClassesValue: 'gform_1' });
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'contains');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Form Classes}}');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'form_submit', formClassesValue: 'gform_1' }), ['formClasses']);
});

test('variables: constant / data_layer / javascript types + keys', () => {
  assert.equal(buildVariable({ name: 'c', kind: 'constant', value: 'x' }).type, 'c');
  assert.equal(findParam(buildVariable({ name: 'c', kind: 'constant', value: 'x' }).parameter, 'value')?.value, 'x');
  const dlv = buildVariable({ name: 'd', kind: 'data_layer', dataLayerName: 'ecommerce' });
  assert.equal(dlv.type, 'v');
  assert.equal(findParam(dlv.parameter, 'name')?.value, 'ecommerce');
  const js = buildVariable({ name: 'j', kind: 'javascript', javascript: 'function(){return document.title;}' });
  assert.equal(js.type, 'jsm');
  assert.ok(String(findParam(js.parameter, 'javascript')?.value).includes('document.title'));
});

console.log('\nContainer audit:');

test('findGa4BaseTag: gaawc / G- / GT- / {{var→G-}} present; Ads ({{var→AW-}}) + unresolved + event + PAUSED are not', () => {
  const snap = (tags: Array<Record<string, unknown>>, variables: Array<Record<string, unknown>> = []) => ({ tags: tags as never, triggers: [], variables: variables as never });
  const g = (over: Record<string, unknown>) => ({ tagId: '1', name: 'x', type: 'googtag', firingTriggerId: [], paused: false, parameter: [], ...over });
  const cvar = (name: string, value: string) => ({ variableId: 'v', name, type: 'c', parameter: [{ key: 'value', value }] });
  assert.equal(findGa4BaseTag(snap([{ ...g({ type: 'gaawc', name: 'GA4 Config' }) }]))?.name, 'GA4 Config');
  assert.equal(findGa4BaseTag(snap([g({ name: 'G tag', parameter: [{ key: 'tagId', value: 'G-ABC123' }] })]))?.name, 'G tag');
  // GT- destination id is a real GA4 base tag (was a false-negative → duplicate).
  assert.equal(findGa4BaseTag(snap([g({ name: 'GT tag', parameter: [{ key: 'tagId', value: 'GT-P3NGJTCV' }] })]))?.name, 'GT tag');
  // {{variable}} tagId is resolved: a constant → G- counts; → AW- (Ads) does NOT.
  assert.equal(findGa4BaseTag(snap([g({ name: 'var GA4', parameter: [{ key: 'tagId', value: '{{GA4 - Variable}}' }] })], [cvar('GA4 - Variable', 'G-QHQL8N71DT')]))?.name, 'var GA4');
  assert.equal(findGa4BaseTag(snap([g({ name: 'var Ads', parameter: [{ key: 'tagId', value: '{{Conversion ID}}' }] })], [cvar('Conversion ID', 'AW-16543357089')])), null);
  // An unresolvable {{var}} (not a known constant) → not counted.
  assert.equal(findGa4BaseTag(snap([g({ name: 'var ?', parameter: [{ key: 'tagId', value: '{{Some Unknown}}' }] })])), null);
  assert.equal(findGa4BaseTag(snap([g({ name: 'Ads', parameter: [{ key: 'tagId', value: 'AW-999' }] })])), null);
  assert.equal(findGa4BaseTag(snap([g({ name: 'evt', type: 'gaawe', firingTriggerId: ['T1'] })])), null);
  // A PAUSED base tag fires nothing → treated as absent (so a working one gets created).
  assert.equal(findGa4BaseTag(snap([g({ name: 'paused', paused: true, parameter: [{ key: 'tagId', value: 'G-1' }] })])), null);
});

test('ga4VariablePlan: create when absent, reuse a Constant, conflict on a non-constant of the same name', () => {
  const snap = (vars: Array<Record<string, unknown>>) => ({ tags: [], triggers: [], variables: vars as never });
  assert.equal(ga4VariablePlan(snap([]), 'GA4 - Variable').action, 'create');
  assert.equal(ga4VariablePlan(snap([{ variableId: '1', name: 'GA4 - Variable', type: 'c' }]), 'GA4 - Variable').action, 'reuse');
  const conflict = ga4VariablePlan(snap([{ variableId: '1', name: 'GA4 - Variable', type: 'v' }]), 'GA4 - Variable');
  assert.equal(conflict.action, 'conflict');
  assert.equal(conflict.existingType, 'v');
});

test('buildGoogleTag: googtag with {{variable}} tagId fires on the built-in All Pages trigger', () => {
  const t = buildGoogleTag({ name: 'GA4 Configuration', tagId: '{{GA4 - Variable}}', firingTriggerId: ['2147479553'] });
  assert.equal(t.type, 'googtag');
  assert.equal(t.parameter.find((p) => (p as { key?: string }).key === 'tagId')?.value, '{{GA4 - Variable}}');
  assert.deepEqual(t.firingTriggerId, ['2147479553']);
});

test('audit flags no-trigger, paused, GA4-no-mid, unused trigger, custom HTML, dup names', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'No trigger', type: 'html', firingTriggerId: [], paused: false, parameter: [] },
      { tagId: '2', name: 'Paused', type: 'gaawe', firingTriggerId: ['T1'], paused: true, parameter: [{ key: 'measurementIdOverride', value: 'G-1' }] },
      { tagId: '3', name: 'NoMid', type: 'gaawe', firingTriggerId: ['T1'], paused: false, parameter: [] },
      { tagId: '4', name: 'Dup', type: 'html', firingTriggerId: ['T1'], paused: false, parameter: [] },
      { tagId: '5', name: 'Dup', type: 'html', firingTriggerId: ['T1'], paused: false, parameter: [] },
    ],
    triggers: [
      { triggerId: 'T1', name: 'Used', type: 'linkClick' },
      { triggerId: 'T2', name: 'Unused', type: 'pageview' },
    ],
    variables: [{ variableId: 'V1', name: 'v', type: 'c' }],
  });
  assert.equal(r.counts.tags, 5);
  const msgs = r.findings.map((f) => f.message).join(' | ');
  assert.ok(msgs.includes('No trigger') && msgs.includes('no firing trigger'));
  assert.ok(msgs.includes('"Paused" is paused'));
  assert.ok(msgs.includes('GA4 event tag "NoMid" has no measurement ID'));
  assert.ok(msgs.includes('"Unused" isn\'t used'));
  assert.ok(msgs.includes('Custom HTML'));
  assert.ok(msgs.includes('Duplicate tag name "Dup"'));
});

test('audit: structured findings carry resource + recommendation + machine fix', () => {
  const r = auditContainer({
    tags: [
      {
        tagId: '2', name: 'Paused', type: 'gaawe', firingTriggerId: ['T1'], paused: true,
        // references {{Referenced}} so that variable is NOT flagged unused
        parameter: [
          { key: 'measurementIdOverride', value: 'G-1' },
          { key: 'eventName', value: 'purchase' },
          { type: 'template', key: 'x', value: '{{Referenced}}' },
        ],
        consentSettings: { consentStatus: 'needed' },
      },
    ],
    triggers: [
      { triggerId: 'T1', name: 'Used', type: 'pageview' },
      { triggerId: 'T2', name: 'Unused', type: 'pageview' },
    ],
    variables: [
      { variableId: 'V1', name: 'Referenced', type: 'c' },
      { variableId: 'V2', name: 'Lonely', type: 'c' },
    ],
  });

  // counts gained a findings tally; severity summary is present.
  assert.equal(r.counts.findings, r.findings.length);
  assert.equal(r.summary.critical + r.summary.high + r.summary.medium + r.summary.low + r.summary.info, r.findings.length);

  const paused = r.findings.find((f) => f.category === 'paused');
  assert.equal(paused?.severity, 'low'); // a paused GA4 EVENT tag (not a config/conversion) is Low (D1)
  assert.equal(paused?.resource?.id, '2');
  assert.ok(paused?.recommendation.length, 'recommendation present');
  assert.equal(paused?.autoFixable, true);
  assert.equal(paused?.fix?.tool, 'set_gtm_tag_paused');
  assert.deepEqual(paused?.fix?.args, { tagId: '2', paused: false, name: 'Paused' });

  const unusedTrigger = r.findings.find((f) => f.category === 'unused' && f.resource?.kind === 'trigger');
  assert.equal(unusedTrigger?.fix?.tool, 'delete_gtm_trigger');
  assert.deepEqual(unusedTrigger?.fix?.args, { triggerId: 'T2', name: 'Unused' });

  // Variable reference scan: "Lonely" is unused; "Referenced" (used by the tag) is not.
  const unusedVars = r.findings.filter((f) => f.category === 'unused' && f.resource?.kind === 'variable');
  assert.deepEqual(unusedVars.map((f) => f.resource?.name), ['Lonely']);
  // Unused-variable is ADVISORY ONLY — no destructive auto-fix (the workspace
  // snapshot can't see published versions or every variable-bearing field).
  assert.equal(unusedVars[0]?.autoFixable, false);
  assert.equal(unusedVars[0]?.fix, undefined);

  // Healthy GA4 tag (mid + eventName + consent needed) raises no ga4/consent finding.
  assert.equal(r.findings.some((f) => f.category === 'ga4' || f.category === 'consent'), false);
});

test('audit: Consent Mode v2 + missing event name flagged on bare GA4/Ads tags', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Bare GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: false, parameter: [{ key: 'measurementIdOverride', value: 'G-9' }] },
      { tagId: '2', name: 'Ads', type: 'awct', firingTriggerId: ['T1'], paused: false, parameter: [] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const cats = r.findings.map((f) => f.category);
  assert.ok(cats.includes('consent'), 'consent finding for tags without consentSettings');
  assert.ok(r.findings.some((f) => f.message.includes('has no event name')), 'GA4 missing event name flagged');
  // Both consent-relevant tags should be flagged for consent.
  assert.equal(r.findings.filter((f) => f.category === 'consent').length, 2);
  // Brain: consent is High (not Medium), confidence 'likely', and now AUTO-FIXABLE.
  const ga4Consent = r.findings.find((f) => f.category === 'consent' && f.resource?.id === '1');
  assert.equal(ga4Consent?.severity, 'high', 'consent finding is High');
  assert.equal(ga4Consent?.confidence, 'likely', 'consent finding is [Likely]');
  assert.equal(ga4Consent?.autoFixable, true, 'consent finding is auto-fixable');
  assert.equal(ga4Consent?.fix?.tool, 'set_gtm_tag_consent');
  assert.deepEqual(ga4Consent?.fix?.args.consentTypes, ['analytics_storage'], 'GA4 → analytics_storage');
  const adsConsent = r.findings.find((f) => f.category === 'consent' && f.resource?.id === '2');
  assert.deepEqual(adsConsent?.fix?.args.consentTypes, ['ad_storage', 'ad_user_data', 'ad_personalization'], 'Ads → ad signals');
});

test('consentTypesFor maps destination type → required consent signals', () => {
  assert.deepEqual(consentTypesFor('gaawe'), ['analytics_storage']);
  assert.deepEqual(consentTypesFor('googtag'), ['analytics_storage', 'ad_storage']);
  assert.deepEqual(consentTypesFor('awct'), ['ad_storage', 'ad_user_data', 'ad_personalization']);
});

test('detectAdPixel recognises the major ad networks, ignores plain HTML', () => {
  assert.equal(detectAdPixel('<script>fbq("init","123");</script>'), 'Meta/Facebook');
  assert.equal(detectAdPixel('https://analytics.tiktok.com/i18n/pixel'), 'TikTok');
  assert.equal(detectAdPixel('var _linkedin_partner_id = "9";'), 'LinkedIn');
  assert.equal(detectAdPixel('<div>hello world</div>'), null);
});

test('audit B6: ungated ad pixel in Custom HTML → Critical [Certain], auto-fixable', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Meta Pixel', type: 'html', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'html', value: '<script>!function(){fbq("init","555")}();</script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const b6 = r.findings.find((f) => f.category === 'consent' && f.severity === 'critical');
  assert.ok(b6, 'a Critical consent finding for the ungated Meta pixel');
  assert.equal(b6?.confidence, 'certain', 'B6 is [Certain] — Custom HTML has no built-in consent');
  assert.equal(b6?.autoFixable, true);
  assert.equal(b6?.fix?.tool, 'set_gtm_tag_consent');
  assert.deepEqual(b6?.fix?.args.consentTypes, ['ad_storage', 'ad_user_data', 'ad_personalization']);
  assert.equal(r.summary.critical, 1, 'counted as Critical');
});

test('audit B6: an ad pixel WITH a consent gate is NOT flagged (denied-pass guard)', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Meta Pixel', type: 'html', firingTriggerId: ['T1'], paused: false,
        consentSettings: { consentStatus: 'needed', consentType: null },
        parameter: [{ key: 'html', value: '<script>fbq("init","555")</script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  assert.equal(r.findings.some((f) => f.category === 'consent' && f.severity === 'critical'), false, 'gated pixel → no B6');
});

test('audit A8: Ads conversion tag with no Conversion ID → High', () => {
  const r = auditContainer({
    tags: [{ tagId: '1', name: 'Ads Conv', type: 'awct', firingTriggerId: ['T1'], paused: false, parameter: [] }],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  assert.ok(r.findings.some((f) => f.severity === 'high' && /no Conversion ID/i.test(f.message)), 'A8 conversion-id finding');
});

test('audit D1: a paused CONFIG tag is High; a paused plain tag is Low', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'GA4 Config', type: 'googtag', firingTriggerId: ['T1'], paused: true, parameter: [{ key: 'tagId', value: 'G-1' }] },
      { tagId: '2', name: 'Some HTML', type: 'html', firingTriggerId: ['T1'], paused: true, parameter: [{ key: 'html', value: '<div>x</div>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const pausedCfg = r.findings.find((f) => f.category === 'paused' && f.resource?.id === '1');
  const pausedHtml = r.findings.find((f) => f.category === 'paused' && f.resource?.id === '2');
  assert.equal(pausedCfg?.severity, 'high', 'paused config tag escalated to High');
  assert.equal(pausedHtml?.severity, 'low', 'paused plain tag stays Low');
});

test('audit: AuditReport carries the boundary statement + runtime-required list', () => {
  const r = auditContainer({ tags: [], triggers: [], variables: [] });
  assert.ok(r.boundary.includes('Container-only'), 'boundary statement present');
  assert.ok(r.runtimeRequired.length >= 4 && r.runtimeRequired.some((x) => /consent timing/i.test(x)), 'runtime-required list present');
  assert.equal(r.summary.critical, 0, 'summary has a critical bucket');
});

test('audit: consent flags only notSet — needed and notNeeded are valid, NOT flagged', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Needed', type: 'awct', firingTriggerId: ['T1'], paused: false, parameter: [], consentSettings: { consentStatus: 'needed' } },
      { tagId: '2', name: 'NotNeeded', type: 'awct', firingTriggerId: ['T1'], paused: false, parameter: [], consentSettings: { consentStatus: 'notNeeded' } },
      { tagId: '3', name: 'NotSet', type: 'awct', firingTriggerId: ['T1'], paused: false, parameter: [], consentSettings: { consentStatus: 'notSet' } },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const consent = r.findings.filter((f) => f.category === 'consent');
  // Only the explicitly-unset tag is flagged; "needed" and "notNeeded" are deliberate, valid choices.
  assert.deepEqual(consent.map((f) => f.resource?.name), ['NotSet']);
});

test('audit: consentStatus is normalized — EXPORT casing (NOT_SET/NOT_NEEDED) matches API casing', () => {
  const r = auditContainer({
    tags: [
      // Container-export JSON uses UPPER_SNAKE; the audit must treat it like the API's camelCase.
      { tagId: '1', name: 'ExportNotSet', type: 'gaawe', firingTriggerId: ['T1'], paused: false, parameter: [{ key: 'measurementId', value: 'G-1' }, { key: 'eventName', value: 'x' }], consentSettings: { consentStatus: 'NOT_SET' } },
      { tagId: '2', name: 'ExportNotNeeded', type: 'gaawe', firingTriggerId: ['T1'], paused: false, parameter: [{ key: 'measurementId', value: 'G-1' }, { key: 'eventName', value: 'x' }], consentSettings: { consentStatus: 'NOT_NEEDED' } },
      { tagId: '3', name: 'ExportNeeded', type: 'gaawe', firingTriggerId: ['T1'], paused: false, parameter: [{ key: 'measurementId', value: 'G-1' }, { key: 'eventName', value: 'x' }], consentSettings: { consentStatus: 'NEEDED' } },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  // Only NOT_SET (≡ notSet) is flagged; NOT_NEEDED / NEEDED are deliberate choices.
  assert.deepEqual(r.findings.filter((f) => f.category === 'consent').map((f) => f.resource?.name), ['ExportNotSet']);
});

test('audit: googtag (Google tag) is consent-relevant, and a missing tag ID is flagged', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'No ID', type: 'googtag', firingTriggerId: ['T1'], paused: false, parameter: [], consentSettings: { consentStatus: 'needed' } },
      { tagId: '2', name: 'Has ID NotSet', type: 'googtag', firingTriggerId: ['T1'], paused: false, parameter: [{ key: 'tagId', value: 'G-XYZ' }], consentSettings: { consentStatus: 'notSet' } },
    ],
    triggers: [{ triggerId: 'T1', name: 'Init', type: 'pageview' }],
    variables: [],
  });
  assert.ok(r.findings.some((f) => f.category === 'ga4' && /no tag ID/.test(f.message) && f.resource?.name === 'No ID'), 'missing tag ID flagged');
  assert.ok(!r.findings.some((f) => f.category === 'ga4' && f.resource?.name === 'Has ID NotSet'), 'tag with an ID not flagged for ga4');
  // googtag is now consent-relevant → the notSet one is flagged for consent.
  assert.ok(r.findings.some((f) => f.category === 'consent' && f.resource?.name === 'Has ID NotSet'));
});

test('audit: Universal Analytics tags are flagged as deprecated; Microsoft Ads (baut) is consent-relevant', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Old UA', type: 'ua', firingTriggerId: ['T1'], paused: false, parameter: [] },
      { tagId: '2', name: 'Bing UET', type: 'baut', firingTriggerId: ['T1'], paused: false, parameter: [], consentSettings: { consentStatus: 'NOT_SET' } },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const ua = r.findings.find((f) => f.category === 'deprecated');
  assert.ok(ua && /Universal Analytics/.test(ua.message) && ua.severity === 'medium', 'UA flagged deprecated');
  assert.ok(r.findings.some((f) => f.category === 'consent' && f.resource?.name === 'Bing UET'), 'baut flagged for consent');
});

test('audit: a trigger used only as a BLOCKING trigger is not reported unused', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Tag', type: 'html', firingTriggerId: ['T1'], blockingTriggerId: ['T2'], paused: false, parameter: [] },
    ],
    triggers: [
      { triggerId: 'T1', name: 'Fires', type: 'pageview' },
      { triggerId: 'T2', name: 'Blocks', type: 'pageview' },
    ],
    variables: [],
  });
  const unusedTriggers = r.findings.filter((f) => f.category === 'unused' && f.resource?.kind === 'trigger');
  assert.equal(unusedTriggers.length, 0, 'blocking trigger T2 counts as used');
});

test('audit: variable referenced only via consentType / trigger parameter is NOT flagged unused', () => {
  const r = auditContainer({
    tags: [
      {
        tagId: '1', name: 'GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'x' }],
        consentSettings: { consentStatus: 'needed', consentType: { type: 'list', list: [{ type: 'template', value: '{{Consent Var}}' }] } },
      },
    ],
    triggers: [
      { triggerId: 'T1', name: 'CE', type: 'customEvent', parameter: [{ type: 'template', key: 'eventName', value: '{{Trigger Var}}' }] },
    ],
    variables: [
      { variableId: 'V1', name: 'Consent Var', type: 'c' },
      { variableId: 'V2', name: 'Trigger Var', type: 'c' },
    ],
  });
  const unusedVars = r.findings.filter((f) => f.category === 'unused' && f.resource?.kind === 'variable');
  assert.equal(unusedVars.length, 0, 'references inside consentType and trigger parameter are detected');
});

test('applyTriggerWaitDefaults: linkClick gets Wait-for-Tags + Check-Validation OFF', () => {
  const out = applyTriggerWaitDefaults({ name: 'Click - Email Link', type: 'linkClick', filter: [] });
  assert.deepEqual(out.waitForTags, { type: 'boolean', value: 'false' });
  assert.deepEqual(out.checkValidation, { type: 'boolean', value: 'false' });
});

test('applyTriggerWaitDefaults: formSubmission gets both OFF', () => {
  const out = applyTriggerWaitDefaults({ name: 'f', type: 'formSubmission' });
  assert.equal((out.waitForTags as { value: string }).value, 'false');
  assert.equal((out.checkValidation as { value: string }).value, 'false');
});

test('applyTriggerWaitDefaults: an EXPLICIT waitForTags is respected (user asked to enable)', () => {
  const out = applyTriggerWaitDefaults({ type: 'linkClick', waitForTags: { type: 'boolean', value: 'true' } });
  assert.equal((out.waitForTags as { value: string }).value, 'true', 'explicit true kept');
  assert.equal((out.checkValidation as { value: string }).value, 'false', 'the unset one still defaults off');
});

test('applyTriggerWaitDefaults: other trigger types are untouched (no wait fields added)', () => {
  for (const type of ['click', 'pageview', 'customEvent', 'scrollDepth']) {
    const out = applyTriggerWaitDefaults({ type });
    assert.equal('waitForTags' in out, false, `${type} should not get waitForTags`);
    assert.equal('checkValidation' in out, false, `${type} should not get checkValidation`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
