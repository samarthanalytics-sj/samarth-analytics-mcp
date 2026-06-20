import assert from 'node:assert/strict';
import {
  buildGa4EventTag,
  buildGoogleTag,
  buildGoogleAdsConversionTag,
  buildCustomHtmlTag,
  buildTrigger,
  triggerBuiltInVars,
  buildVariable,
  auditContainer,
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

test('Google Ads conversion tag: awct + conversionId/Label', () => {
  const t = buildGoogleAdsConversionTag({ name: 'Ads', conversionId: 'AW-1', conversionLabel: 'L1' });
  assert.equal(t.type, 'awct');
  assert.equal(findParam(t.parameter, 'conversionId')?.value, 'AW-1');
  assert.equal(findParam(t.parameter, 'conversionLabel')?.value, 'L1');
});

test('Custom HTML tag: html type + snippet', () => {
  const t = buildCustomHtmlTag({ name: 'FB', html: '<script>fbq()</script>' });
  assert.equal(t.type, 'html');
  assert.equal(findParam(t.parameter, 'html')?.value, '<script>fbq()</script>');
});

test('link_click trigger: linkClick + {{Click URL}} autoEventFilter, needs clickUrl var', () => {
  const tr = buildTrigger({ name: 'Email link click', kind: 'link_click', clickUrlValue: 'mailto:' });
  assert.equal(tr.type, 'linkClick');
  assert.equal(tr.filter, undefined, 'click conditions go in autoEventFilter, not filter');
  const f = (tr.autoEventFilter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'contains');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Click URL}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'mailto:');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'link_click', clickUrlValue: 'mailto:' }), ['clickUrl']);
});

test('custom_event trigger: customEvent + {{_event}} filter', () => {
  const tr = buildTrigger({ name: 'purchase', kind: 'custom_event', eventName: 'purchase' });
  assert.equal(tr.type, 'customEvent');
  const f = (tr.customEventFilter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{_event}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'purchase');
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
  assert.equal(r.summary.high + r.summary.medium + r.summary.low + r.summary.info, r.findings.length);

  const paused = r.findings.find((f) => f.category === 'paused');
  assert.equal(paused?.severity, 'medium');
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
