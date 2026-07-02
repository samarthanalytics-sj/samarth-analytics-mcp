import assert from 'node:assert/strict';
import {
  buildGa4EventTag,
  buildGoogleTag,
  buildGoogleAdsConversionTag,
  buildCustomHtmlTag,
  buildClickTextLookupVariable,
  buildLookupTableVariable,
  buildRegexTableVariable,
  buildFloodlightCounterTag,
  buildGoogleAdsCallConversionTag,
  buildGoogleAdsRemarketingTag,
  buildConversionLinkerTag,
  buildCustomImageTag,
  buildTrigger,
  applyTriggerWaitDefaults,
  normalizeTimerTrigger,
  customEventNameOf,
  findExistingTrigger,
  buildEnvironmentSnippet,
  buildGa4Client,
  buildGa4ServerTag,
  buildServerAllEventsTrigger,
  buildMetaEmqVariables,
  buildMetaPixelTag,
  buildMetaCapiServerTag,
  metaStandardEvent,
  buildTikTokCapiServerTag,
  tikTokStandardEvent,
  TIKTOK_EVENT_PROPERTIES,
  META_EVENT_OBJECT_PROPERTIES,
  normalizeCustomEventName,
  normalizeCustomEventTrigger,
  setCustomEventName,
  findUnusedTriggers,
  collectUsedTriggerIds,
  triggerUsageBreakdown,
  findUnusedVariables,
  collectReferencedVariableNames,
  detectMetaTags,
  customTemplateType,
  buildAdsConversionServerTag,
  buildAdsConversionLinkerServerTag,
  buildAdsRemarketingServerTag,
  buildAllowParamsTransformation,
  auditServerContainer,
  upsertGoogleTagConfig,
  consentTypesFor,
  evaluateConsentGate,
  triggerBuiltInVars,
  builtInVarsForTemplates,
  buildVariable,
  buildUrlQueryVariable,
  auditContainer,
  sanitizeName,
  findGa4BaseTag,
  ga4VariablePlan,
} from '../gtm-builders';
import { classifyPixel } from '../pixel-signatures';

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

test('Floodlight Counter tag: flc + core params (ordinalType STANDARD default) + conversion linker', () => {
  const t = buildFloodlightCounterTag({ name: 'FL', advertiserId: '6278210', groupTag: 'confi0', activityTag: 'email0' });
  assert.equal(t.type, 'flc');
  assert.equal(findParam(t.parameter, 'advertiserId')?.value, '6278210');
  assert.equal(findParam(t.parameter, 'groupTag')?.value, 'confi0');
  assert.equal(findParam(t.parameter, 'activityTag')?.value, 'email0');
  assert.equal(findParam(t.parameter, 'ordinalType')?.value, 'STANDARD');
  assert.equal(findParam(t.parameter, 'useImageTag')?.value, 'false');
  // Conversion Linker pair on by default (matches the 48/62 corpus majority).
  assert.equal(findParam(t.parameter, 'enableConversionLinker')?.value, 'true');
  assert.equal(findParam(t.parameter, 'conversionCookiePrefix')?.value, '_gcl');
  // countingMethod 'unique' -> UNIQUE; opting out of the linker drops both linker params.
  const u = buildFloodlightCounterTag({ name: 'FL2', advertiserId: '1', groupTag: 'g', activityTag: 'a', countingMethod: 'unique', enableConversionLinker: false });
  assert.equal(findParam(u.parameter, 'ordinalType')?.value, 'UNIQUE');
  assert.equal(findParam(u.parameter, 'enableConversionLinker'), undefined);
});

test('Google Ads Call Conversion tag: awcc + exactly the 3 corpus params, conversionId stripped of AW-', () => {
  const t = buildGoogleAdsCallConversionTag({ name: 'Call', phoneNumber: '(877) 635-4246', conversionId: 'AW-10966070237', conversionLabel: '8J53CLK87pEBEIqL88YD' });
  assert.equal(t.type, 'awcc');
  assert.equal(findParam(t.parameter, 'phoneConversionNumber')?.value, '(877) 635-4246');
  assert.equal(findParam(t.parameter, 'conversionId')?.value, '10966070237');
  assert.equal(findParam(t.parameter, 'conversionLabel')?.value, '8J53CLK87pEBEIqL88YD');
  // The legacy gtag call-conversion extras are NOT part of the native awcc tag.
  assert.equal(findParam(t.parameter, 'phoneConversionCountryCode'), undefined);
});

test('Google Ads Remarketing tag: sp + all-pages audience (customParamsFormat NONE), conversionId passes through', () => {
  const t = buildGoogleAdsRemarketingTag({ name: 'RMKT', conversionId: 'AW-605994778' });
  assert.equal(t.type, 'sp');
  // Unlike awct/awcc, sp stores conversionId as-is (the corpus has both AW- and bare forms).
  assert.equal(findParam(t.parameter, 'conversionId')?.value, 'AW-605994778');
  assert.equal(findParam(t.parameter, 'customParamsFormat')?.value, 'NONE');
  assert.equal(findParam(t.parameter, 'enableDynamicRemarketing')?.value, 'false');
  assert.equal(findParam(t.parameter, 'rdp')?.value, 'false');
  assert.equal(findParam(t.parameter, 'enableConversionLinker')?.value, 'true');
});

test('Conversion Linker tag: gclidw + always enableCookieOverrides=false; cross-domain adds the extra params', () => {
  const base = buildConversionLinkerTag({ name: 'CL' });
  assert.equal(base.type, 'gclidw');
  assert.equal(findParam(base.parameter, 'enableCrossDomain')?.value, 'false');
  assert.equal(findParam(base.parameter, 'enableCookieOverrides')?.value, 'false');
  assert.equal(findParam(base.parameter, 'linkerDomains'), undefined);
  // Passing linkerDomains implies cross-domain and emits the extra set (urlPosition is literal "query").
  const cd = buildConversionLinkerTag({ name: 'CL2', linkerDomains: 'a.com, b.com' });
  assert.equal(findParam(cd.parameter, 'enableCrossDomain')?.value, 'true');
  assert.equal(findParam(cd.parameter, 'linkerDomains')?.value, 'a.com, b.com');
  assert.equal(findParam(cd.parameter, 'urlPosition')?.value, 'query');
  assert.equal(findParam(cd.parameter, 'formDecoration')?.value, 'false');
});

test('Custom Image tag: img + url; cache buster on by default (gtmcb), off drops the query-param key', () => {
  const t = buildCustomImageTag({ name: 'Pixel', url: '//pixel.example.com/p.gif' });
  assert.equal(t.type, 'img');
  assert.equal(findParam(t.parameter, 'url')?.value, '//pixel.example.com/p.gif');
  assert.equal(findParam(t.parameter, 'useCacheBuster')?.value, 'true');
  assert.equal(findParam(t.parameter, 'cacheBusterQueryParam')?.value, 'gtmcb');
  const off = buildCustomImageTag({ name: 'Pixel2', url: '//x/y.gif', useCacheBuster: false });
  assert.equal(findParam(off.parameter, 'useCacheBuster')?.value, 'false');
  assert.equal(findParam(off.parameter, 'cacheBusterQueryParam'), undefined);
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

test('all_clicks trigger: matchRegex + clickTextIgnoreCase emits the condition-level ignore_case parameter (no inline (?i))', () => {
  const tr = buildTrigger({ name: 'Learn More Variants Click Trigger', kind: 'all_clicks', clickTextValue: '^Learn More$', clickTextOperator: 'matchRegex', clickTextIgnoreCase: true });
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'matchRegex');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, '^Learn More$');
  // GTM's "matches RegEx (ignore case)" — gtm.js cannot parse an inline (?i), so the flag must ride
  // on the condition's ignore_case boolean parameter.
  const ic = f.parameter.find((p) => p.key === 'ignore_case');
  assert.equal(ic?.type, 'boolean');
  assert.equal(ic?.value, 'true');
  // Without the flag, no ignore_case parameter is emitted (existing conditions unchanged).
  const plain = buildTrigger({ name: 'x', kind: 'all_clicks', clickTextValue: 'Buy', clickTextOperator: 'equals' });
  const pf = (plain.filter ?? [])[0] as { parameter: Array<Record<string, unknown>> };
  assert.equal(pf.parameter.find((p) => p.key === 'ignore_case'), undefined);
});

test('Lookup Table variable: corpus smm shape (setDefaultValue false, input {{Click Text}}, one row per exact text)', () => {
  const v = buildClickTextLookupVariable('Lookup - Learn More Variants', ['Learn More', 'LEARN MORE']);
  assert.equal(v.type, 'smm');
  assert.equal(findParam(v.parameter ?? [], 'setDefaultValue')?.value, 'false');
  assert.equal(findParam(v.parameter ?? [], 'input')?.value, '{{Click Text}}');
  const map = findParam(v.parameter ?? [], 'map') as { type: string; list: Array<{ map: Array<Record<string, unknown>> }> };
  assert.equal(map?.type, 'list');
  assert.equal(map.list.length, 2);
  assert.equal(map.list[0].map.find((m) => m.key === 'key')?.value, 'Learn More');
  assert.equal(map.list[0].map.find((m) => m.key === 'value')?.value, 'true');
  assert.equal(map.list[1].map.find((m) => m.key === 'key')?.value, 'LEARN MORE');
});

test('Lookup Table variable (generalized): arbitrary input + per-row values + optional default (Page Path → form_name)', () => {
  const v = buildLookupTableVariable(
    'Lookup - Form Name - Contact Form',
    '{{Page Path}}',
    [{ key: '/', value: 'Contact Form - Home' }, { key: '/services/ga4-consulting', value: 'Contact Form - Ga4 Consulting' }],
    'Contact Form',
  );
  assert.equal(v.type, 'smm');
  assert.equal(findParam(v.parameter ?? [], 'setDefaultValue')?.value, 'true'); // a default → setDefaultValue true
  assert.equal(findParam(v.parameter ?? [], 'defaultValue')?.value, 'Contact Form');
  assert.equal(findParam(v.parameter ?? [], 'input')?.value, '{{Page Path}}');
  const map = findParam(v.parameter ?? [], 'map') as { list: Array<{ map: Array<Record<string, unknown>> }> };
  assert.equal(map.list.length, 2);
  assert.equal(map.list[0].map.find((m) => m.key === 'key')?.value, '/');
  assert.equal(map.list[0].map.find((m) => m.key === 'value')?.value, 'Contact Form - Home');
  // No default → setDefaultValue false, no defaultValue param.
  const noDef = buildLookupTableVariable('L', '{{Page Path}}', [{ key: '/', value: 'x' }]);
  assert.equal(findParam(noDef.parameter ?? [], 'setDefaultValue')?.value, 'false');
  assert.equal(findParam(noDef.parameter ?? [], 'defaultValue'), undefined);
});

test('RegEx Table variable: corpus remm shape (setDefaultValue, input, fullMatch, replaceAfterMatch, ignoreCase, map)', () => {
  const v = buildRegexTableVariable('RegEx - Section', '{{Page Path}}', [{ key: '^/services/', value: 'Services' }], 'Other');
  assert.equal(v.type, 'remm');
  assert.equal(findParam(v.parameter ?? [], 'setDefaultValue')?.value, 'true');
  assert.equal(findParam(v.parameter ?? [], 'defaultValue')?.value, 'Other');
  assert.equal(findParam(v.parameter ?? [], 'input')?.value, '{{Page Path}}');
  assert.equal(findParam(v.parameter ?? [], 'fullMatch')?.value, 'false');
  assert.equal(findParam(v.parameter ?? [], 'replaceAfterMatch')?.value, 'false');
  assert.equal(findParam(v.parameter ?? [], 'ignoreCase')?.value, 'true'); // corpus norm
  const map = findParam(v.parameter ?? [], 'map') as { list: Array<{ map: Array<Record<string, unknown>> }> };
  assert.equal(map.list[0].map.find((m) => m.key === 'key')?.value, '^/services/');
  assert.equal(map.list[0].map.find((m) => m.key === 'value')?.value, 'Services');
});

test('all_clicks trigger: lookupTable → single {{<Lookup>}} equals "true" condition + enables clickText var', () => {
  const tr = buildTrigger({ name: 'Learn More Variants Click Trigger', kind: 'all_clicks', lookupTable: { name: 'Lookup - Learn More Variants', texts: ['Learn More', 'LEARN MORE'] } });
  assert.equal(tr.type, 'click');
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'equals');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Lookup - Learn More Variants}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'true');
  // The lookup reads {{Click Text}}, so the Click Text built-in must be enabled.
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'all_clicks', lookupTable: { name: 'L', texts: ['A'] } }), ['clickText']);
});

test('link_click trigger: matchRegex + clickUrlIgnoreCase emits ignore_case on the {{Click URL}} condition (download fallback)', () => {
  const tr = buildTrigger({ name: 'File Download Click Trigger', kind: 'link_click', clickUrlValue: '\\.(pdf|zip)(\\?|#|$)', clickUrlOperator: 'matchRegex', clickUrlIgnoreCase: true });
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'matchRegex');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Click URL}}');
  const ic = f.parameter.find((p) => p.key === 'ignore_case');
  assert.equal(ic?.value, 'true');
});

test('all_clicks trigger: {{Page Path}} is a second ANDed condition on a page-scoped click (FAQ pattern) + needs pagePath var', () => {
  const tr = buildTrigger({ name: 'FAQ Click Trigger', kind: 'all_clicks', clickTextValue: '?', clickTextOperator: 'endsWith', pagePathValue: '/faq', pagePathOperator: 'contains' });
  const filters = (tr.filter ?? []) as Array<{ type: string; parameter: Array<Record<string, unknown>> }>;
  assert.equal(filters.length, 2); // Click Text ends with "?" AND Page Path contains /faq — one trigger
  assert.equal(filters[0].type, 'endsWith');
  assert.equal(filters[0].parameter.find((p) => p.key === 'arg0')?.value, '{{Click Text}}');
  assert.equal(filters[1].type, 'contains');
  assert.equal(filters[1].parameter.find((p) => p.key === 'arg0')?.value, '{{Page Path}}');
  assert.equal(filters[1].parameter.find((p) => p.key === 'arg1')?.value, '/faq');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'all_clicks', clickTextValue: '?', pagePathValue: '/faq' }), ['clickText', 'pagePath']);
});

test('all_clicks trigger: {{Click Element}} cssSelector filter (FAQ accordion — fires on text/row/arrow) + needs clickElement var', () => {
  const tr = buildTrigger({ name: 'FAQ Click Trigger', kind: 'all_clicks', clickElementValue: '.faq-q, .faq-q *', clickElementOperator: 'cssSelector' });
  assert.equal(tr.type, 'click');
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'cssSelector');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Click Element}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, '.faq-q, .faq-q *');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'all_clicks', clickElementValue: '.faq-q, .faq-q *' }), ['clickElement']);
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
  assert.equal(tr.filter, undefined, 'no secondary conditions unless asked');
});

test('custom_event trigger: secondary ANDed scope conditions in filter (event AND Form ID AND Page Path) + built-ins', () => {
  // The corpus-standard data-layer form pattern: "event EQUALS form_submit AND {{Form ID}} EQUALS x
  // AND {{Page Path}} CONTAINS /contact" — secondary conditions live in filter, beside customEventFilter.
  const tr = buildTrigger({ name: 'Contact Form Trigger', kind: 'custom_event', eventName: 'form_submit', formIdValue: 'gform_2', pagePathValue: '/contact', pagePathOperator: 'contains' });
  assert.equal(tr.type, 'customEvent');
  const ce = (tr.customEventFilter ?? [])[0] as { parameter: Array<Record<string, unknown>> };
  assert.equal(ce.parameter.find((p) => p.key === 'arg1')?.value, 'form_submit');
  const filters = (tr.filter ?? []) as Array<{ type: string; parameter: Array<Record<string, unknown>> }>;
  assert.equal(filters.length, 2);
  assert.equal(filters[0].parameter.find((p) => p.key === 'arg0')?.value, '{{Form ID}}');
  assert.equal(filters[0].type, 'equals');
  assert.equal(filters[1].parameter.find((p) => p.key === 'arg0')?.value, '{{Page Path}}');
  assert.equal(filters[1].type, 'contains');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'custom_event', eventName: 'form_submit', formIdValue: 'gform_2', pagePathValue: '/contact' }), ['formId', 'pagePath']);
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

test('form_submit trigger: no id/class → scope to the page via {{Page Path}}, needs pagePath var', () => {
  const tr = buildTrigger({ name: 'Contact Form Trigger', kind: 'form_submit', pagePathValue: '/contact' });
  assert.equal(tr.type, 'formSubmission');
  const f = (tr.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'equals');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Page Path}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, '/contact');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'form_submit', pagePathValue: '/contact' }), ['pagePath']);
  // An id/class scope takes precedence — the page filter is only the no-id/class fallback.
  const scoped = buildTrigger({ name: 'x', kind: 'form_submit', formIdValue: 'c', pagePathValue: '/contact' });
  assert.equal((scoped.filter ?? []).length, 1);
  assert.equal(((scoped.filter ?? [])[0] as { parameter: Array<Record<string, unknown>> }).parameter.find((p) => p.key === 'arg0')?.value, '{{Form ID}}');
});

test('pageview trigger: pageUrlValue → fires on Some pages via {{Page URL}} contains, enables pageUrl', () => {
  const plain = buildTrigger({ name: 'All Pages', kind: 'pageview' });
  assert.equal(plain.type, 'pageview');
  assert.equal(plain.filter, undefined); // no condition → All Pages
  const search = buildTrigger({ name: 'Site Search Trigger', kind: 'pageview', pageUrlValue: 'q=', pageUrlOperator: 'contains' });
  assert.equal(search.type, 'pageview');
  const f = (search.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(f.type, 'contains');
  assert.equal(f.parameter.find((p) => p.key === 'arg0')?.value, '{{Page URL}}');
  assert.equal(f.parameter.find((p) => p.key === 'arg1')?.value, 'q=');
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'pageview', pageUrlValue: 'q=' }), ['pageUrl']);
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'pageview' }), []); // plain pageview enables nothing
});

test('buildUrlQueryVariable: URL variable reading ?<key>= (component QUERY + queryKey), name verbatim', () => {
  const v = buildUrlQueryVariable('URL - search', 'search');
  assert.equal(v.name, 'URL - search'); // verbatim so a {{URL - search}} reference resolves to it
  assert.equal(v.type, 'u');
  const p = v.parameter as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'component')?.value, 'QUERY');
  assert.equal(p.find((x) => x.key === 'queryKey')?.value, 'search');
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
  // Unused-variable now carries a delete fix (advisory still — the recommendation warns it's a hint,
  // not proof, and that GTM lets you delete a referenced variable).
  assert.equal(unusedVars[0]?.autoFixable, true);
  assert.equal(unusedVars[0]?.fix?.tool, 'delete_gtm_variable');
  assert.deepEqual(unusedVars[0]?.fix?.args, { variableId: 'V2', name: 'Lonely' });

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

test('classifyPixel: strong signal → advertising_pixel; domain-only → possible; plain → not', () => {
  assert.equal(classifyPixel('<script>fbq("init","123");</script>').classification, 'advertising_pixel');
  assert.equal(classifyPixel('<script>fbq("init","123");</script>').network, 'Meta / Facebook');
  assert.equal(classifyPixel('<script>ttq.load("ABC")</script>').classification, 'advertising_pixel');
  assert.equal(classifyPixel('var _linkedin_partner_id = "9";').classification, 'advertising_pixel');
  // a domain reference with no init is "possible, review", NOT a confirmed pixel
  assert.equal(classifyPixel('https://analytics.tiktok.com/i18n/pixel').classification, 'possible_pixel_review');
  assert.equal(classifyPixel('connect.facebook.net/en_US/fbevents.js').classification, 'possible_pixel_review');
  assert.equal(classifyPixel('<div>hello world</div>').classification, 'not_a_pixel');
});

test('classifyPixel: short tokens (twq(/rdt(/uetq) need their domain to co-occur', () => {
  // strong token alone is NOT enough for the ambiguous networks
  assert.equal(classifyPixel('twq("track");').classification, 'not_a_pixel');
  assert.equal(classifyPixel('uetq.push("event");').classification, 'not_a_pixel');
  // strong + weak domain co-occurring → pixel
  assert.equal(classifyPixel('twq("track"); static.ads-twitter.com').classification, 'advertising_pixel');
  assert.equal(classifyPixel('var uetq=[]; bat.bing.com/bat.js').classification, 'advertising_pixel');
});

test('classifyPixel: an unreadable external <script src> with no signal → opaque_review', () => {
  assert.equal(classifyPixel('<script src="https://cdn.example.com/x.js"></script>').classification, 'opaque_review');
});

test('evaluateConsentGate: gated / partial / wrong_types / ungated / declared_no_consent', () => {
  const need = ['ad_storage', 'ad_user_data', 'ad_personalization'];
  const list = (...vals: string[]) => ({ consentType: { type: 'list', list: vals.map((v) => ({ type: 'template', value: v })) } });
  assert.equal(evaluateConsentGate({ consentStatus: 'needed', ...list(...need) }, need), 'gated');
  assert.equal(evaluateConsentGate({ consentStatus: 'needed', ...list('ad_storage') }, need), 'partial');
  assert.equal(evaluateConsentGate({ consentStatus: 'needed', ...list('analytics_storage') }, need), 'wrong_types');
  assert.equal(evaluateConsentGate({ consentStatus: 'notSet' }, need), 'ungated');
  assert.equal(evaluateConsentGate(null, need), 'ungated');
  assert.equal(evaluateConsentGate({ consentStatus: 'notNeeded' }, need), 'declared_no_consent');
  // UPPER_SNAKE from export JSON normalizes identically
  assert.equal(evaluateConsentGate({ consentStatus: 'NOT_SET' }, need), 'ungated');
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

const consentList = (...vals: string[]) => ({ type: 'list', list: vals.map((v) => ({ type: 'template', value: v })) });

test('audit B6: a correctly gated ad pixel is NOT flagged (denied-pass guard)', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Meta Pixel', type: 'html', firingTriggerId: ['T1'], paused: false,
        consentSettings: { consentStatus: 'needed', consentType: consentList('ad_storage', 'ad_user_data', 'ad_personalization') },
        parameter: [{ key: 'html', value: '<script>fbq("init","555")</script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  assert.equal(r.findings.some((f) => f.checkId === 'B6-ad-pixel-consent'), false, 'fully gated pixel → no B6 finding');
});

test('audit B6 §8 case 1: TikTok ttq.load() with consentStatus notSet → Critical (UK/EU), with fix', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'TikTok – Social Click', type: 'html', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'html', value: '<script>ttq.load("ABC");ttq.page();</script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const b6 = r.findings.find((f) => f.checkId === 'B6-ad-pixel-consent');
  assert.ok(b6, 'TikTok ungated pixel flagged');
  assert.equal(b6?.severity, 'critical', 'Critical on a UK/EU site (default region)');
  assert.equal(b6?.confidence, 'certain');
  assert.ok(/TikTok/.test(b6!.message) && /without a consent gate/i.test(b6!.message));
  assert.equal(b6?.fix?.tool, 'set_gtm_tag_consent');
  assert.deepEqual(b6?.fix?.args.consentTypes, ['ad_storage', 'ad_user_data', 'ad_personalization']);
});

test('audit B6 §8: region drives severity — non-risk region → High, not Critical', () => {
  const snap = {
    tags: [
      { tagId: '1', name: 'TikTok', type: 'html', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'html', value: '<script>ttq.load("ABC")</script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  };
  assert.equal(auditContainer(snap, { clientRegion: ['US'] }).findings.find((f) => f.checkId === 'B6-ad-pixel-consent')?.severity, 'high');
  assert.equal(auditContainer(snap, { clientRegion: ['AU'] }).findings.find((f) => f.checkId === 'B6-ad-pixel-consent')?.severity, 'critical');
});

test('audit B6 §8 case 3: gated on ad_storage only → Medium (partial), names the missing types', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Meta', type: 'html', firingTriggerId: ['T1'], paused: false,
        consentSettings: { consentStatus: 'needed', consentType: consentList('ad_storage') },
        parameter: [{ key: 'html', value: '<script>fbq("init","9")</script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const b6 = r.findings.find((f) => f.checkId === 'B6-ad-pixel-consent');
  assert.equal(b6?.severity, 'medium', 'partial gate → Medium');
  assert.ok(/ad_user_data/.test(b6!.message) && /ad_personalization/.test(b6!.message), 'names missing types');
});

test('audit B6 §8 case 4: LinkedIn declared notNeeded → Critical (declared_no_consent)', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'LinkedIn', type: 'html', firingTriggerId: ['T1'], paused: false,
        consentSettings: { consentStatus: 'notNeeded' },
        parameter: [{ key: 'html', value: 'var _linkedin_partner_id="9";' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const b6 = r.findings.find((f) => f.checkId === 'B6-ad-pixel-consent');
  assert.equal(b6?.severity, 'critical');
  assert.ok(/NO consent/i.test(b6!.message), 'declared-no-consent wording');
});

test('audit B6 §8 case 5/6: domain-only and opaque script → Info [Guessing] review notes', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'FB domain only', type: 'html', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'html', value: 'connect.facebook.net/en_US/fbevents.js' }] },
      { tagId: '2', name: 'Opaque loader', type: 'html', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'html', value: '<script src="https://cdn.example.com/x.js"></script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'All Pages', type: 'pageview' }],
    variables: [],
  });
  const reviews = r.findings.filter((f) => f.checkId === 'B6-ad-pixel-review');
  assert.equal(reviews.length, 2, 'one review note per ambiguous tag');
  assert.ok(reviews.every((f) => f.severity === 'info' && f.confidence === 'guessing'), 'Info [Guessing], not scored');
  // the two ambiguous outcomes must read differently (possible = domain seen; opaque = unreadable script)
  const possible = reviews.find((f) => f.resource?.id === '1');
  const opaque = reviews.find((f) => f.resource?.id === '2');
  assert.ok(/domain/i.test(possible!.message), 'case 5 (possible) cites the network domain');
  assert.ok(/external script/i.test(opaque!.message) && /can't read/i.test(opaque!.message), 'case 6 (opaque) cites the unreadable external script');
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

test('audit A8: a {{variable}} Measurement ID with no matching Google tag is HIGH [Likely]', () => {
  const r = auditContainer({
    tags: [{ tagId: '1', name: 'GA4 - Email Click', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
      parameter: [{ key: 'measurementIdOverride', value: '{{GA4 Variable}}' }, { key: 'eventName', value: 'email_click' }] }],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'customEvent' }],
    variables: [],
  });
  const f = r.findings.find((x) => x.category === 'ga4' && /variable Measurement ID/i.test(x.message));
  assert.ok(f, 'the variable-id case is flagged (not silently passed)');
  assert.equal(f?.severity, 'high', 'High — events may not be collected');
  assert.equal(f?.confidence, 'likely', '[Likely] — strong inference, one runtime check confirms');
  assert.equal(r.findings.some((x) => /has no measurement ID/i.test(x.message)), false, 'NOT flagged as missing');
});

test('audit A8: a variable Measurement ID is NOT flagged when a Google tag IS present (GTM resolves it)', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'GA4 - File Download', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'measurementIdOverride', value: '{{GA4 Measurement ID}}' }, { key: 'eventName', value: 'email_click' }] },
      { tagId: '2', name: 'GA4 Config', type: 'googtag', firingTriggerId: ['T2'], paused: false,
        parameter: [{ key: 'tagId', value: '{{GA4 Measurement ID}}' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'linkClick' }, { triggerId: 'T2', name: 'AP', type: 'pageview' }],
    variables: [],
  });
  assert.equal(r.findings.some((x) => /variable Measurement ID/i.test(x.message)), false, 'suppressed — "Google tag found in this container"');
  assert.equal(r.findings.some((x) => /variable Tag ID/i.test(x.message)), false, 'the Google tag itself is never flagged for a variable id');
});

test('audit A8: per-ID match — a variable the config does NOT declare is still flagged', () => {
  const r = auditContainer({
    tags: [
      // Email Click uses {{GA4 Variable}} — the config tag uses a DIFFERENT variable → "Cannot detect".
      { tagId: '1', name: 'GA4 - Email Click', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'measurementIdOverride', value: '{{GA4 Variable}}' }, { key: 'eventName', value: 'email_click' }] },
      // File Download uses the SAME variable the config declares → "Google tag found".
      { tagId: '2', name: 'GA4 - File Download', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'measurementIdOverride', value: '{{GA4 Measurement ID}}' }, { key: 'eventName', value: 'email_click' }] },
      { tagId: '3', name: 'GA4 - Configuration', type: 'googtag', firingTriggerId: ['T2'], paused: false,
        parameter: [{ key: 'tagId', value: '{{GA4 Measurement ID}}' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'customEvent' }, { triggerId: 'T2', name: 'AP', type: 'pageview' }],
    variables: [],
  });
  assert.ok(r.findings.some((x) => x.resource?.id === '1' && /Cannot detect/i.test(x.message)), 'Email Click ({{GA4 Variable}}) IS flagged — config declares a different id');
  assert.equal(r.findings.some((x) => x.resource?.id === '2' && /Cannot detect/i.test(x.message)), false, 'File Download ({{GA4 Measurement ID}}) NOT flagged — config declares it');
});

test('audit A11: a manual tag for an Enhanced-Measurement event is flagged [Likely] Medium', () => {
  const r = auditContainer({
    tags: [{ tagId: '1', name: 'GA4 - File Download', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
      parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'file_download' }] }],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'linkClick' }],
    variables: [],
  });
  const f = r.findings.find((x) => /Enhanced Measurement also auto-tracks/i.test(x.message));
  assert.ok(f && f.severity === 'medium' && f.confidence === 'likely', 'EM-overlap finding is Medium [Likely]');
});

test('audit C5: a USED Custom JavaScript variable (jsm) is flagged for review', () => {
  const r = auditContainer({
    tags: [{ tagId: '1', name: 'GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
      parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'x' }, { key: 'p', value: '{{CJS - scrape}}' }] }],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'customEvent' }],
    variables: [{ variableId: 'V1', name: 'CJS - scrape', type: 'jsm', parameter: [{ key: 'javascript', value: 'function(){return document.cookie}' }] }],
  });
  assert.ok(r.findings.some((x) => x.checkId === 'C5-custom-js-variable'), 'used jsm variable flagged');
});

test('audit §7 precedence: an UNUSED jsm variable gets only the unused finding, not C5', () => {
  const r = auditContainer({
    tags: [],
    triggers: [],
    variables: [{ variableId: 'V1', name: 'CJS - scrape', type: 'jsm', parameter: [{ key: 'javascript', value: 'function(){return document.cookie}' }] }],
  });
  const forVar = r.findings.filter((f) => f.resource?.id === 'V1');
  assert.equal(forVar.some((f) => f.checkId === 'C5-custom-js-variable'), false, 'no runtime-risk finding on an unused item');
  assert.equal(forVar.some((f) => f.checkId === 'unused-variable'), true, 'unused-cleanup finding wins');
});

test('audit §7 dedup: the same check never emits twice for one resource', () => {
  // Two distinct jsm variables that differ only by their id are two findings (not merged);
  // but the dedup guarantees no single (check, resource) pair appears more than once.
  const r = auditContainer({
    tags: [{ tagId: '1', name: 'GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
      parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'x' }, { key: 'a', value: '{{JS A}}' }, { key: 'b', value: '{{JS B}}' }] }],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'customEvent' }],
    variables: [
      { variableId: 'VA', name: 'JS A', type: 'jsm', parameter: [] },
      { variableId: 'VB', name: 'JS B', type: 'jsm', parameter: [] },
    ],
  });
  const c5 = r.findings.filter((f) => f.checkId === 'C5-custom-js-variable');
  assert.equal(c5.length, 2, 'two distinct variables → two findings');
  const keys = new Set(c5.map((f) => `${f.checkId}::${f.resource?.id}`));
  assert.equal(keys.size, 2, 'each (check, resource) pair is unique — no duplicate rows');
});

test('audit: an unrecognised tag type is flagged for manual review, not skipped', () => {
  const r = auditContainer({
    tags: [{ tagId: '1', name: 'Mystery', type: 'someNewVendorXyz', firingTriggerId: ['T1'], paused: false, parameter: [] }],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'pageview' }],
    variables: [],
  });
  assert.ok(r.findings.some((x) => /unrecognised type/i.test(x.message)), 'unknown type flagged');
});

test('audit: findings carry the resource GTM type (drives the tag-type filter)', () => {
  const r = auditContainer({
    tags: [
      { tagId: '1', name: 'Paused GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: true,
        parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'x' }] },
      { tagId: '2', name: 'TikTok', type: 'html', firingTriggerId: ['T1'], paused: false,
        parameter: [{ key: 'html', value: '<script>ttq.load("A")</script>' }] },
    ],
    triggers: [{ triggerId: 'T1', name: 'T', type: 'customEvent' }],
    variables: [{ variableId: 'V1', name: 'Orphan CJS', type: 'jsm', parameter: [] }],
  });
  assert.equal(r.findings.find((x) => x.resource?.id === '1')?.resource?.type, 'gaawe', 'GA4 event tag finding tagged gaawe');
  assert.equal(r.findings.find((x) => x.resource?.id === '2')?.resource?.type, 'html', 'Custom HTML tag finding tagged html');
  // non-tag resources are enriched too (variable → jsm), though the UI filter lists tag types
  assert.equal(r.findings.find((x) => x.resource?.id === 'V1')?.resource?.type, 'jsm', 'variable finding carries its type');
});

test('buildEnvironmentSnippet embeds gtm_auth + gtm_preview=env-<id> + the public id', () => {
  const { head, body } = buildEnvironmentSnippet('GTM-ABC123', 'AUTH_TOKEN_XYZ', '7');
  assert.ok(head.includes("'GTM-ABC123'"), 'container public id in the script');
  assert.ok(head.includes('&gtm_auth=AUTH_TOKEN_XYZ'), 'gtm_auth token');
  assert.ok(head.includes('&gtm_preview=env-7'), 'gtm_preview is env-<environmentId>');
  assert.ok(head.includes('&gtm_cookies_win=x'), 'gtm_cookies_win');
  assert.ok(body.includes('ns.html?id=GTM-ABC123') && body.includes('&gtm_auth=AUTH_TOKEN_XYZ'), 'noscript iframe carries the same params');
});

type TimerParam = { type?: string; key?: string; value?: string };

test('buildTrigger timer: interval + eventName are TOP-LEVEL fields (no key), not parameter[]', () => {
  const t = buildTrigger({ name: 'Timer - 30s', kind: 'timer', intervalMs: 30000 });
  assert.equal(t.type, 'timer');
  assert.equal((t.eventName as TimerParam)?.value, 'gtm.timer');
  assert.equal((t.interval as TimerParam)?.value, '30000');
  assert.equal((t.interval as TimerParam)?.key, undefined, 'interval is a dedicated field with NO key');
  assert.equal(t.parameter, undefined, 'timer settings do not go in parameter[]');
});

test('normalizeTimerTrigger: a top-level RAW string interval/limit becomes top-level Parameter objects (the blank-field bug)', () => {
  // The model put interval/limit as raw strings → GTM showed blank fields. Wrap them.
  const fixed = normalizeTimerTrigger({ name: 'T', type: 'timer', interval: '30000', limit: '5' }) as Record<string, TimerParam>;
  assert.equal(fixed.interval?.value, '30000', 'interval is a top-level template Parameter');
  assert.equal(fixed.interval?.type, 'template');
  assert.equal(fixed.interval?.key, undefined, 'no key on the dedicated field');
  assert.equal(fixed.limit?.value, '5');
  assert.equal(fixed.eventName?.value, 'gtm.timer', 'eventName defaulted');
});

test('normalizeTimerTrigger: interval wrongly placed in parameter[] is moved to the top-level field', () => {
  const fixed = normalizeTimerTrigger({
    name: 'T',
    type: 'timer',
    parameter: [{ type: 'template', key: 'interval', value: '15000' }, { type: 'template', key: 'limit', value: '3' }],
  }) as { interval?: TimerParam; limit?: TimerParam; parameter?: unknown[] };
  assert.equal(fixed.interval?.value, '15000', 'interval pulled from parameter[] to the top level');
  assert.equal(fixed.limit?.value, '3');
  assert.equal(fixed.parameter, undefined, 'timer keys stripped from parameter[]');
});

test('normalizeTimerTrigger: no limit → unlimited (no limit field); non-timer untouched', () => {
  const noLimit = normalizeTimerTrigger({ name: 'T', type: 'timer', interval: '5000' }) as { limit?: unknown };
  assert.equal(noLimit.limit, undefined, 'unlimited → no limit field');
  const other = { name: 'X', type: 'customEvent', customEventFilter: [] };
  assert.deepEqual(normalizeTimerTrigger(other), other, 'non-timer triggers pass through unchanged');
});

test('customEventNameOf extracts the dataLayer event from a customEvent trigger', () => {
  const tr = buildTrigger({ name: 'CE - Product View', kind: 'custom_event', eventName: 'product_view' });
  assert.equal(customEventNameOf(tr as unknown as Record<string, unknown>), 'product_view');
  assert.equal(customEventNameOf({ type: 'pageview' }), '', 'non-custom-event → empty');
});

test('findExistingTrigger: matches by name (ci) OR by same custom-event, else undefined', () => {
  const existing = [
    { triggerId: '10', name: 'All Pages', type: 'pageview' },
    { triggerId: '11', name: 'CE - Product View', type: 'customEvent', customEventName: 'product_view' },
  ];
  // by name (case-insensitive)
  assert.equal(findExistingTrigger(existing, { name: 'ce - product view' })?.triggerId, '11');
  // by same custom event under a DIFFERENT name
  assert.equal(findExistingTrigger(existing, { name: 'Product View CE', type: 'customEvent', customEventName: 'product_view' })?.triggerId, '11');
  // a genuinely new event → no match
  assert.equal(findExistingTrigger(existing, { name: 'CE - Add To Cart', type: 'customEvent', customEventName: 'add_to_cart' }), undefined);
  // surrounding whitespace is trimmed on the name match
  assert.equal(findExistingTrigger(existing, { name: '  All Pages  ' })?.triggerId, '10');
  // an empty proposed name does NOT spuriously match an existing trigger
  assert.equal(findExistingTrigger(existing, { name: '', type: 'pageview' }), undefined);
});

test('buildGa4Client builds a gaaw_client that claims the default GA4 paths', () => {
  const c = buildGa4Client('GA4');
  assert.equal(c.type, 'gaaw_client');
  const p = (c.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'activateDefaultPaths')?.value, 'true');
});

test('buildGa4ServerTag builds an sgtmgaaw tag relaying to the Measurement ID', () => {
  const t = buildGa4ServerTag('GA4 - Server', 'G-ABC123');
  assert.equal(t.type, 'sgtmgaaw');
  const p = (t.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'measurementId')?.value, 'G-ABC123');
  // No eventName param when blank → GTM inherits the incoming event_name (per Google/Stape docs).
  assert.equal(p.find((x) => x.key === 'eventName'), undefined, 'omits eventName so it inherits the incoming event');
  assert.equal(p.find((x) => x.key === 'epToIncludeDropdown')?.value, 'all');
  // a per-event tag uses a literal event name
  const purchase = buildGa4ServerTag('GA4 - Purchase', 'G-ABC123', 'purchase');
  assert.equal(((purchase.parameter ?? []) as Array<{ key: string; value: string }>).find((x) => x.key === 'eventName')?.value, 'purchase');
});

test('buildServerAllEventsTrigger → CUSTOM_EVENT firing on every event ({{_event}} matches .*)', () => {
  const tr = buildServerAllEventsTrigger('All Events');
  assert.equal(tr.type, 'customEvent');
  const cef = (tr.customEventFilter ?? []) as Array<{ type: string; parameter: Array<{ key: string; value: string }> }>;
  assert.equal(cef.length, 1);
  assert.equal(cef[0].type, 'matchRegex');
  assert.equal(cef[0].parameter.find((x) => x.key === 'arg0')?.value, '{{_event}}');
  assert.equal(cef[0].parameter.find((x) => x.key === 'arg1')?.value, '.*');
  assert.equal(tr.filter, undefined, 'no client filter when clientName is omitted');
});

test('buildServerAllEventsTrigger scoped to a client → {{Client Name}} equals <client> filter', () => {
  const tr = buildServerAllEventsTrigger('All Events', 'GA4');
  const f = (tr.filter ?? []) as Array<{ type: string; parameter: Array<{ key: string; value: string }> }>;
  assert.equal(f.length, 1, 'has a Client Name filter');
  assert.equal(f[0].type, 'equals');
  assert.equal(f[0].parameter.find((x) => x.key === 'arg0')?.value, '{{Client Name}}');
  assert.equal(f[0].parameter.find((x) => x.key === 'arg1')?.value, 'GA4');
});

test('upsertGoogleTagConfig adds server_container_url, preserves other settings, updates in place', () => {
  // existing googtag with one config setting (send_page_view)
  const tag = {
    type: 'googtag',
    parameter: [
      { type: 'template', key: 'tagId', value: 'G-1' },
      { type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [{ type: 'template', key: 'parameter', value: 'send_page_view' }, { type: 'template', key: 'parameterValue', value: 'true' }] }] },
    ],
  };
  const params = upsertGoogleTagConfig(tag, 'server_container_url', 'https://sgtm.example.com');
  const table = params.find((p) => (p as { key?: string }).key === 'configSettingsTable') as { list: Array<{ map: Array<{ key: string; value: string }> }> };
  const settings = Object.fromEntries(table.list.map((m) => [m.map.find((x) => x.key === 'parameter')!.value, m.map.find((x) => x.key === 'parameterValue')!.value]));
  assert.equal(settings.server_container_url, 'https://sgtm.example.com', 'server URL added');
  assert.equal(settings.send_page_view, 'true', 'existing setting preserved');
  assert.ok(params.some((p) => (p as { key?: string }).key === 'tagId'), 'tagId preserved');

  // updating in place (no duplicate)
  const again = upsertGoogleTagConfig({ type: 'googtag', parameter: params }, 'server_container_url', 'https://new.example.com');
  const t2 = again.find((p) => (p as { key?: string }).key === 'configSettingsTable') as { list: unknown[] };
  assert.equal(t2.list.length, 2, 'updated in place — still 2 settings, no duplicate');

  // no configSettingsTable yet → creates it
  const fresh = upsertGoogleTagConfig({ type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-2' }] }, 'server_container_url', 'https://x.example.com');
  assert.ok(fresh.some((p) => (p as { key?: string }).key === 'configSettingsTable'), 'creates the table when absent');
});

test('Ads server tag builders emit the corpus-validated sgtm types + key fields', () => {
  const conv = buildAdsConversionServerTag('Ads - Purchase', 'AW-123', 'abcLABEL');
  assert.equal(conv.type, 'sgtmadsct');
  const cp = (conv.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(cp.find((x) => x.key === 'conversionId')?.value, 'AW-123');
  assert.equal(cp.find((x) => x.key === 'conversionLabel')?.value, 'abcLABEL');
  assert.equal(cp.find((x) => x.key === 'enableConversionLinker')?.value, 'true');

  const linker = buildAdsConversionLinkerServerTag('Ads - Linker');
  assert.equal(linker.type, 'sgtmadscl');

  const rmkt = buildAdsRemarketingServerTag('Ads - Remarketing', 'AW-123');
  assert.equal(rmkt.type, 'sgtmadsremarket');
  const rp = (rmkt.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(rp.find((x) => x.key === 'conversionId')?.value, 'AW-123');
  assert.equal(rp.find((x) => x.key === 'enableDynamicRemarketing')?.value, 'true');
  assert.equal(rp.find((x) => x.key === 'remarketingEventDataSource')?.value, 'EVENT_DATA');
});

test('buildVariable event_data → server Event Data variable (ed) reading keyPath', () => {
  const v = buildVariable({ name: 'ed - items', kind: 'event_data', keyPath: 'items' });
  assert.equal(v.type, 'ed');
  const p = (v.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'keyPath')?.value, 'items');
  assert.equal(p.find((x) => x.key === 'setDefaultValue')?.value, 'false', 'no default → false');
  // with a default value
  const wd = buildVariable({ name: 'ed - currency', kind: 'event_data', keyPath: 'currency', defaultValue: 'USD' });
  const wp = (wd.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(wp.find((x) => x.key === 'setDefaultValue')?.value, 'true');
  assert.equal(wp.find((x) => x.key === 'defaultValue')?.value, 'USD');
});

test('buildAllowParamsTransformation → tf_allow_params keeping only the listed params', () => {
  const t = buildAllowParamsTransformation('Keep ecommerce', ['transaction_id', 'currency', 'value']) as {
    type: string;
    parameter: Array<{ key: string; list?: Array<{ map: Array<{ key: string; value: string }> }> }>;
  };
  assert.equal(t.type, 'tf_allow_params');
  const table = t.parameter.find((x) => x.key === 'allowedParamsTable');
  const kept = (table?.list ?? []).map((m) => m.map.find((x) => x.key === 'allowedParams')!.value);
  assert.deepEqual(kept, ['transaction_id', 'currency', 'value']);
});

test('auditServerContainer flags missing client, blank ids, no trigger, paused, no tagging URL', () => {
  const rep = auditServerContainer({
    taggingServerUrls: [],
    clients: [],
    transformations: [],
    tags: [
      // GA4 server tag with NO measurementId and NO firing trigger
      { tagId: '1', name: 'GA4 - Server', type: 'sgtmgaaw', firingTriggerId: [], blockingTriggerId: [], paused: false, parameter: [], consentSettings: null },
      // Ads conversion missing conversionLabel, and PAUSED
      { tagId: '2', name: 'Ads - Purchase', type: 'sgtmadsct', firingTriggerId: ['9'], blockingTriggerId: [], paused: true, parameter: [{ type: 'template', key: 'conversionId', value: 'AW-1' }], consentSettings: null },
    ],
  });
  const msgs = rep.findings.map((f) => f.message).join(' | ');
  assert.ok(rep.summary.critical >= 1, 'no client → a critical');
  assert.ok(/no client/i.test(msgs), 'names the missing-client problem');
  assert.ok(/no tagging server URL/i.test(msgs), 'flags missing tagging URL');
  assert.ok(/no Measurement ID/i.test(msgs), 'flags GA4 tag with blank measurement id');
  assert.ok(/never fires/i.test(msgs), 'flags the tag with no firing trigger');
  assert.ok(/Conversion ID and\/or Label/i.test(msgs), 'flags incomplete Ads conversion');
  assert.ok(/PAUSED/i.test(msgs), 'flags the paused server tag');
  // boundary makes the config-vs-runtime line explicit
  assert.ok(/NOT that the tagging server is deployed/i.test(rep.boundary));
});

test('auditServerContainer catches an Ads-only container with a non-GA4 client (no gaaw_client)', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'Some other client', type: 'measurement_protocol' }], // not gaaw_client
    transformations: [],
    tags: [{ tagId: '2', name: 'Ads - Purchase', type: 'sgtmadsct', firingTriggerId: ['9'], blockingTriggerId: [], paused: false, parameter: [{ type: 'template', key: 'conversionId', value: 'AW-1' }, { type: 'template', key: 'conversionLabel', value: 'L' }], consentSettings: null }],
  });
  const msgs = rep.findings.map((f) => f.message).join(' | ');
  assert.ok(/no GA4 client \(gaaw_client\)/i.test(msgs), 'flags missing gaaw_client even when only Ads server tags exist');
});

test('auditServerContainer is quiet on a healthy server container', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4 Client', type: 'gaaw_client' }],
    transformations: [],
    tags: [{ tagId: '1', name: 'GA4 - Server', type: 'sgtmgaaw', firingTriggerId: ['10'], blockingTriggerId: [], paused: false, parameter: [{ type: 'template', key: 'measurementId', value: 'G-1' }], consentSettings: null }],
  });
  assert.equal(rep.summary.critical, 0);
  assert.equal(rep.summary.high, 0);
  assert.equal(rep.hasGa4Config, true, 'GA4 client present');
});

test('buildMetaEmqVariables → ed variables with keyPath === key (corpus shape)', () => {
  const vars = buildMetaEmqVariables();
  const byName = new Map(vars.map((v) => [v.name, v]));
  for (const key of ['fbp', 'fbc', 'event_id', 'value', 'currency', 'transaction_id', 'email_address']) {
    const v = byName.get(`ed - ${key}`);
    assert.ok(v, `has ed - ${key}`);
    assert.equal(v!.type, 'ed');
    const kp = (v!.parameter ?? []).find((p) => (p as { key?: string }).key === 'keyPath') as { value?: string };
    assert.equal(kp?.value, key, `ed - ${key} reads keyPath "${key}"`);
  }
});

test('detectMetaTags flags an fbq Purchase tag, ignores GA4', () => {
  const snapshot = {
    tags: [
      { tagId: '1', name: 'FB Pixel', type: 'html', firingTriggerId: [], paused: false, parameter: [{ key: 'html', value: "fbq('track','Purchase',{value:9,currency:'USD'})" }] },
      { tagId: '2', name: 'GA4 Config', type: 'gaawc', firingTriggerId: [], paused: false, parameter: [{ key: 'measurementId', value: 'G-1' }] },
    ],
    triggers: [],
    variables: [],
  } as never;
  const r = detectMetaTags(snapshot);
  assert.equal(r.hasMetaPixel, true);
  assert.equal(r.hasEcommerce, true);
  assert.deepEqual(r.metaTags.map((t) => t.id), ['1']);
  assert.deepEqual(r.metaTags[0].ecommerceEvents, ['Purchase']);
});

test('customTemplateType: gallery template uses cvt_<galleryTemplateId>, local uses cvt_<containerId>_<templateId>', () => {
  // Gallery-imported (Meta Pixel) — must be cvt_<galleryTemplateId>, NOT cvt_<containerId>_<templateId>.
  assert.equal(
    customTemplateType({ containerId: '256064206', templateId: '261', galleryReference: { galleryTemplateId: '5RM3Q' } }, '256064206'),
    'cvt_5RM3Q',
  );
  // Locally-authored (no gallery reference) — cvt_<containerId>_<templateId>.
  assert.equal(customTemplateType({ containerId: '60340825', templateId: '34', galleryReference: null }, '60340825'), 'cvt_60340825_34');
  assert.equal(customTemplateType({ templateId: '34' }, '60340825'), 'cvt_60340825_34', 'falls back to the passed container id');
});

test('buildMetaPixelTag: standard event → eventName=standard + standardEventName; free text resolves', () => {
  const vc = buildMetaPixelTag('cvt_5RM3Q', 'Meta - ViewContent', '123', 'ViewContent', ['9']);
  assert.equal(vc.type, 'cvt_5RM3Q');
  const p = (vc.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'eventName')?.value, 'standard');
  assert.equal(p.find((x) => x.key === 'standardEventName')?.value, 'ViewContent');
  assert.equal(p.find((x) => x.key === 'customEventName'), undefined, 'no custom field for a standard event');
  assert.deepEqual(vc.firingTriggerId, ['9']);
  // free text + canonicalization
  assert.equal(metaStandardEvent('add to cart'), 'AddToCart');
  assert.equal(metaStandardEvent('donate'), 'Donate');
  const atc = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'add to cart');
  assert.equal(((atc.parameter ?? []) as Array<{ key: string; value: string }>).find((x) => x.key === 'standardEventName')?.value, 'AddToCart');
});

test('META_EVENT_OBJECT_PROPERTIES carries the full per-event property set', () => {
  assert.deepEqual(META_EVENT_OBJECT_PROPERTIES.Purchase, ['content_ids', 'contents', 'content_type', 'value', 'currency', 'num_items', 'order_id', 'event_id']);
  assert.deepEqual(META_EVENT_OBJECT_PROPERTIES.ViewContent, ['content_ids', 'contents', 'content_type', 'content_name', 'content_category', 'value', 'currency']);
  assert.deepEqual(META_EVENT_OBJECT_PROPERTIES.Search, ['search_string', 'content_ids', 'content_category']);
  assert.deepEqual(META_EVENT_OBJECT_PROPERTIES.VideoPlay, ['video_title', 'video_duration', 'percent_viewed']);
  assert.deepEqual(META_EVENT_OBJECT_PROPERTIES.UnlockAchievement, ['achievement_id', 'achievement_name']);
});

test('buildMetaPixelTag: objectProperties become an objectPropertyList of {name,value} maps', () => {
  const t = buildMetaPixelTag('cvt_5RM3Q', 'Meta - Event - Purchase Tag', '123', 'Purchase', ['9'], [
    { name: 'value', value: '{{Ecommerce Value}}' },
    { name: 'currency', value: '{{Ecommerce Currency}}' },
    { name: '', value: 'dropped' },
  ]);
  const p = (t.parameter ?? []) as Array<{ key: string; value?: string; list?: Array<{ map: Array<{ key: string; value: string }> }> }>;
  assert.equal(p.find((x) => x.key === 'objectPropertiesFromVariable')?.value, 'false');
  const list = p.find((x) => x.key === 'objectPropertyList')?.list ?? [];
  assert.equal(list.length, 2, 'blank-name row dropped');
  assert.equal(list[0].map.find((m) => m.key === 'name')?.value, 'value');
  assert.equal(list[0].map.find((m) => m.key === 'value')?.value, '{{Ecommerce Value}}');
});

test('buildMetaCapiServerTag: Stape FB CAPI tag with EMQ-tuned defaults', () => {
  const t = buildMetaCapiServerTag('cvt_5TP8W', 'Meta CAPI - AddToCart Tag', '{{Facebook Pixel ID}}', '{{Facebook Api Token}}', 'add to cart', { firingTriggerId: ['5'] });
  assert.equal(t.type, 'cvt_5TP8W');
  const p = (t.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'pixelId')?.value, '{{Facebook Pixel ID}}');
  assert.equal(p.find((x) => x.key === 'accessToken')?.value, '{{Facebook Api Token}}');
  assert.equal(p.find((x) => x.key === 'actionSource')?.value, 'website');
  assert.equal(p.find((x) => x.key === 'enableEventEnhancement')?.value, 'true', 'Event Enhancement on for EMQ');
  assert.equal(p.find((x) => x.key === 'generateFbp')?.value, 'true');
  // Verified against the live template: inheritEventName SELECT 'override', eventName RADIO 'standard'.
  assert.equal(p.find((x) => x.key === 'inheritEventName')?.value, 'override');
  assert.equal(p.find((x) => x.key === 'eventName')?.value, 'standard');
  assert.equal(p.find((x) => x.key === 'eventNameStandard')?.value, 'AddToCart', 'free text canonicalized');
  assert.deepEqual(t.firingTriggerId, ['5']);
  // non-standard event → override + custom + eventNameCustom
  const c = buildMetaCapiServerTag('cvt_5TP8W', 'x', 'P', 'T', 'my_custom');
  const cp = (c.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(cp.find((x) => x.key === 'inheritEventName')?.value, 'override');
  assert.equal(cp.find((x) => x.key === 'eventName')?.value, 'custom');
  assert.equal(cp.find((x) => x.key === 'eventNameCustom')?.value, 'my_custom');
});

test('tikTokStandardEvent: GA4 aliases map, exact-case TikTok events pass through, junk → null', () => {
  // GA4 purchase → Purchase (the current event; CompletePayment is legacy "Use Purchase instead")
  assert.equal(tikTokStandardEvent('purchase'), 'Purchase');
  assert.equal(tikTokStandardEvent('add_to_cart'), 'AddToCart');
  assert.equal(tikTokStandardEvent('view_item'), 'ViewContent');
  assert.equal(tikTokStandardEvent('begin_checkout'), 'InitiateCheckout');
  assert.equal(tikTokStandardEvent('generate_lead'), 'SubmitForm');
  assert.equal(tikTokStandardEvent('sign_up'), 'CompleteRegistration');
  assert.equal(tikTokStandardEvent('file_download'), 'Download');
  // exact-case escape hatch: the legacy CompletePayment is still reachable when asked for explicitly
  assert.equal(tikTokStandardEvent('CompletePayment'), 'CompletePayment');
  assert.equal(tikTokStandardEvent('Purchase'), 'Purchase');
  // case/separator-insensitive direct match
  assert.equal(tikTokStandardEvent('view content'), 'ViewContent');
  assert.equal(tikTokStandardEvent('completeregistration'), 'CompleteRegistration');
  // unknown → custom
  assert.equal(tikTokStandardEvent('Newsletter Signup'), null);
  assert.equal(tikTokStandardEvent('  '), null);
});

test('TIKTOK_EVENT_PROPERTIES: per-event recommended properties cover the commerce keys', () => {
  assert.deepEqual(TIKTOK_EVENT_PROPERTIES.Purchase, ['contents', 'content_type', 'value', 'currency', 'order_id', 'description']);
  assert.ok(TIKTOK_EVENT_PROPERTIES.ViewContent.includes('content_type') && TIKTOK_EVENT_PROPERTIES.ViewContent.includes('contents'));
  assert.ok(TIKTOK_EVENT_PROPERTIES.InitiateCheckout.includes('num_items'));
  assert.deepEqual(TIKTOK_EVENT_PROPERTIES.Search, ['query', 'content_type']);
  // a non-commerce event's props (routed to additional properties — not in TIKTOK_CUSTOM_DATA_KEYS)
  assert.deepEqual(TIKTOK_EVENT_PROPERTIES.SubmitForm, ['form_name', 'value']);
});

test('buildTikTokCapiServerTag: Stape TikTok Events API tag, standard event + match-quality wiring', () => {
  const t = buildTikTokCapiServerTag('cvt_TT01', 'TikTok CAPI - Purchase Tag', '{{TikTok Pixel}}', '{{TikTok Token}}', 'purchase', {
    firingTriggerId: ['5'],
    eventId: '{{Event ID}}',
    userData: [
      { name: 'Email', value: '{{Email}}' },
      { name: 'phone', value: '{{Phone}}' },
      { name: '', value: 'dropped' },
    ],
    eventProperties: [
      { name: 'value', value: '{{Ecom Value}}' },
      { name: 'currency', value: '{{Ecom Currency}}' },
      { name: 'made_up_prop', value: '{{X}}' },
    ],
  });
  assert.equal(t.type, 'cvt_TT01');
  const p = (t.parameter ?? []) as Array<{ key: string; value: string; type?: string; list?: unknown[] }>;
  assert.equal(p.find((x) => x.key === 'pixelId')?.value, '{{TikTok Pixel}}');
  assert.equal(p.find((x) => x.key === 'accessToken')?.value, '{{TikTok Token}}');
  assert.equal(p.find((x) => x.key === 'eventSource')?.value, 'web', 'default source web');
  // eventType RADIO is the inherit/override control (no Meta-style inheritEventName field)
  assert.equal(p.find((x) => x.key === 'inheritEventName'), undefined, 'no Meta inheritEventName key');
  assert.equal(p.find((x) => x.key === 'eventType')?.value, 'standard');
  assert.equal(p.find((x) => x.key === 'eventName')?.value, 'Purchase', 'GA4 purchase mapped to the current Purchase event, not legacy CompletePayment');
  assert.equal(p.find((x) => x.key === 'enableEventEnhancement')?.value, 'true', 'Event Enhancement on');
  assert.equal(p.find((x) => x.key === 'generateTtp')?.value, 'true', 'generate _ttp on');
  assert.equal(p.find((x) => x.key === 'adStorageConsent')?.value, 'optional');
  assert.equal(p.find((x) => x.key === 'eventId')?.value, '{{Event ID}}', 'dedup id wired');
  assert.deepEqual(t.firingTriggerId, ['5']);
  // userDataList: a list-of-maps; blank-name row dropped; "Email" canonicalized to "email"
  const ud = p.find((x) => x.key === 'userDataList') as { list: Array<{ map: Array<{ key: string; value: string }> }> } | undefined;
  assert.ok(ud, 'userDataList present');
  assert.equal(ud!.list.length, 2, 'blank-name row dropped');
  assert.equal(ud!.list[0].map.find((m) => m.key === 'name')?.value, 'email', 'name canonicalized to SELECT key');
  // known props → customDataList; unknown prop → additionalEventPropertiesList (not rejected)
  const cd = p.find((x) => x.key === 'customDataList') as { list: unknown[] } | undefined;
  const extra = p.find((x) => x.key === 'additionalEventPropertiesList') as { list: unknown[] } | undefined;
  assert.equal(cd?.list.length, 2, 'value + currency are known custom-data keys');
  assert.equal(extra?.list.length, 1, 'made_up_prop routed to additional properties');
});

test('buildTikTokCapiServerTag: a non-standard event → eventType=custom + eventNameCustom', () => {
  const c = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'my_custom_event');
  const p = (c.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'eventType')?.value, 'custom');
  assert.equal(p.find((x) => x.key === 'eventNameCustom')?.value, 'my_custom_event');
  assert.equal(p.find((x) => x.key === 'eventName'), undefined, 'no standard eventName for a custom event');
});

test('buildMetaPixelTag: a non-standard event → eventName=custom + customEventName', () => {
  assert.equal(metaStandardEvent('Newsletter Signup'), null);
  const c = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'Newsletter Signup');
  const p = (c.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(p.find((x) => x.key === 'eventName')?.value, 'custom');
  assert.equal(p.find((x) => x.key === 'customEventName')?.value, 'Newsletter Signup');
  assert.equal(p.find((x) => x.key === 'standardEventName'), undefined, 'no standard field for a custom event');
});

test('normalizeCustomEventName strips display prefixes + snake_cases, leaves clean tokens', () => {
  assert.equal(normalizeCustomEventName('CE - Purchase'), 'purchase');
  assert.equal(normalizeCustomEventName('GA4 - Event - Add To Cart'), 'add_to_cart');
  assert.equal(normalizeCustomEventName('Add To Cart'), 'add_to_cart');
  assert.equal(normalizeCustomEventName('purchase'), 'purchase', 'clean token unchanged');
  assert.equal(normalizeCustomEventName('add_to_cart'), 'add_to_cart', 'snake token unchanged');
  assert.equal(normalizeCustomEventName('gtm.dom'), 'gtm.dom', 'gtm.* event unchanged');
});

test('normalizeCustomEventTrigger fixes the {{_event}} match value', () => {
  const t = normalizeCustomEventTrigger({
    name: 'CE - Purchase',
    type: 'customEvent',
    customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{_event}}' }, { type: 'template', key: 'arg1', value: 'CE - Purchase' }] }],
  }) as { name: string; customEventFilter: Array<{ parameter: Array<{ key: string; value: string }> }> };
  assert.equal(t.name, 'CE - Purchase', 'display name unchanged');
  assert.equal(t.customEventFilter[0].parameter.find((p) => p.key === 'arg1')?.value, 'purchase', 'event match value normalized');
});

test('normalizeCustomEventTrigger REPAIRS a top-level eventName + missing filter (the create_gtm_trigger bug)', () => {
  // The model built a customEvent trigger with the event name at the TOP LEVEL (timer-only field) and
  // no customEventFilter → the API rejected trigger.event_name + "must have exactly one custom-event filter".
  const t = normalizeCustomEventTrigger({ name: 'Purchase Trigger', type: 'customEvent', eventName: 'purchase' }) as {
    eventName?: unknown;
    customEventFilter: Array<{ parameter: Array<{ key: string; value: string }> }>;
  };
  assert.equal('eventName' in t, false, 'invalid top-level eventName stripped');
  assert.equal(t.customEventFilter.length, 1, 'exactly one custom-event filter');
  assert.equal(t.customEventFilter[0].parameter.find((p) => p.key === 'arg0')?.value, '{{_event}}');
  assert.equal(t.customEventFilter[0].parameter.find((p) => p.key === 'arg1')?.value, 'purchase');
});

test('normalizeCustomEventTrigger: top-level eventName as a Parameter + display name → snake_cased filter', () => {
  const t = normalizeCustomEventTrigger({
    name: 'X',
    type: 'customEvent',
    eventName: { type: 'template', value: 'Add To Cart' },
  }) as { eventName?: unknown; customEventFilter: Array<{ parameter: Array<{ key: string; value: string }> }> };
  assert.equal('eventName' in t, false);
  assert.equal(t.customEventFilter[0].parameter.find((p) => p.key === 'arg1')?.value, 'add_to_cart');
});

test('normalizeCustomEventTrigger leaves a valid server all-events trigger (matchRegex .* + Client Name) intact', () => {
  const server = buildServerAllEventsTrigger('All Events', 'GA4') as unknown as Record<string, unknown>;
  const t = normalizeCustomEventTrigger(server) as {
    customEventFilter: Array<{ type: string; parameter: Array<{ key: string; value: string }> }>;
    filter?: Array<{ parameter: Array<{ key: string; value: string }> }>;
  };
  const evCond = t.customEventFilter.find((c) => c.parameter.some((p) => p.key === 'arg0' && p.value === '{{_event}}'));
  assert.equal(evCond?.type, 'matchRegex', 'event condition preserved as match-all');
  assert.equal(evCond?.parameter.find((p) => p.key === 'arg1')?.value, '.*', 'match-all value untouched');
  // the {{Client Name}} scoping condition (in `filter`, not customEventFilter) survives untouched
  assert.ok(t.filter?.some((c) => c.parameter.some((p) => p.key === 'arg0' && p.value === '{{Client Name}}')), 'client-name filter preserved');
});

test('findUnusedTriggers: firing/blocking used; a DEAD trigger group does NOT keep its member used', () => {
  const snap = {
    tags: [{ tagId: 't1', name: 'GA4', type: 'gaawe', firingTriggerId: ['10'], blockingTriggerId: ['11'], paused: false, parameter: [] }],
    triggers: [
      { triggerId: '10', name: 'All Pages', type: 'pageview' }, // used: firing
      { triggerId: '11', name: 'Block on X', type: 'customEvent' }, // used: blocking/exception
      { triggerId: '12', name: 'Orphan', type: 'customEvent' }, // UNUSED
      { triggerId: '14', name: 'Member of a DEAD group', type: 'customEvent' }, // orphan: its only referrer (tg) is unused
      { triggerId: 'tg', name: 'My Group', type: 'triggerGroup', parameter: [{ type: 'list', key: 'triggerIds', list: [{ type: 'triggerReference', value: '14' }] }] }, // UNUSED by any tag
      { triggerId: '2147479553', name: 'All Pages (built-in)', type: 'pageview' }, // reserved built-in — never offered
    ],
    variables: [],
  };
  assert.deepEqual([...collectUsedTriggerIds(snap)].sort(), ['10', '11'], 'firing + blocking; a dead group does NOT make its member used');
  assert.deepEqual(
    findUnusedTriggers(snap).map((t) => t.triggerId).sort(),
    ['12', '14', 'tg'],
    'the orphan, the unused group, AND the dead group\'s member; built-in excluded',
  );
});

test('findUnusedTriggers: a LIVE trigger group keeps its members used; a DEAD one does not', () => {
  const make = (groupFired: boolean) => ({
    tags: [{ tagId: 't', name: 'T', type: 'html', firingTriggerId: groupFired ? ['tg'] : [], blockingTriggerId: [], paused: false, parameter: [] }],
    triggers: [
      { triggerId: '20', name: 'member', type: 'customEvent' },
      { triggerId: 'tg', name: 'group', type: 'triggerGroup', parameter: [{ type: 'list', key: 'x', list: [{ type: 'triggerReference', value: '20' }] }] },
    ],
    variables: [],
  });
  assert.deepEqual(findUnusedTriggers(make(true)).map((t) => t.triggerId).sort(), [], 'tag fires the group → group + member both used');
  assert.deepEqual(findUnusedTriggers(make(false)).map((t) => t.triggerId).sort(), ['20', 'tg'], 'no tag uses the group → BOTH the group and its member are orphans');
});

test('findUnusedVariables: variables referenced by no tag/trigger/other-variable are orphans', () => {
  const snap = {
    tags: [{ tagId: 't', name: 'GA4', type: 'gaawe', firingTriggerId: [], paused: false, parameter: [{ type: 'template', key: 'measurementId', value: '{{GA4 ID}}' }] }],
    triggers: [],
    variables: [
      { variableId: '10', name: 'GA4 ID', type: 'c', parameter: [] }, // referenced by the tag
      { variableId: '11', name: 'Page Path', type: 'v', parameter: [] }, // referenced by nothing → orphan
      { variableId: '12', name: 'Wrapper', type: 'jsm', parameter: [{ type: 'template', key: 'javascript', value: 'return {{GA4 ID}};' }] }, // refs GA4 ID, itself unused → orphan
    ],
  };
  assert.deepEqual([...collectReferencedVariableNames(snap)].sort(), ['GA4 ID'], 'only GA4 ID is referenced (tag param + Wrapper body)');
  assert.deepEqual(
    findUnusedVariables(snap).map((v) => v.variableId).sort(),
    ['11', '12'],
    'Page Path + the unused Wrapper; GA4 ID is referenced so it is kept',
  );
});

test('triggerUsageBreakdown: orphaned count + how blocking / paused-firing would change it', () => {
  const snap = {
    tags: [
      { tagId: 'a', name: 'Active', type: 'gaawe', firingTriggerId: ['10'], blockingTriggerId: ['11'], paused: false, parameter: [] },
      { tagId: 'p', name: 'Paused', type: 'html', firingTriggerId: ['12'], blockingTriggerId: [], paused: true, parameter: [] },
    ],
    triggers: [
      { triggerId: '10', name: 'fires active tag', type: 'customEvent' },
      { triggerId: '11', name: 'blocks a tag', type: 'customEvent' },
      { triggerId: '12', name: 'fires a paused tag only', type: 'customEvent' },
      { triggerId: '14', name: 'true orphan', type: 'customEvent' },
    ],
    variables: [],
  };
  const b = triggerUsageBreakdown(snap);
  assert.equal(b.total, 4);
  assert.equal(b.orphaned, 1, 'only the true orphan (14)');
  assert.equal(b.orphanedIfBlockingUnused, 2, '+ the blocking-only trigger 11');
  assert.equal(b.orphanedIfPausedFiringUnused, 2, '+ the trigger that fires only a paused tag (12)');
});

test('setCustomEventName updates the {{_event}} value in place, preserving structure', () => {
  const t = setCustomEventName(
    { name: 'CE - Purchase', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{_event}}' }, { type: 'template', key: 'arg1', value: 'CE - Purchase' }] }] },
    'purchase',
  ) as { customEventFilter: Array<{ parameter: Array<{ key: string; value: string }> }> };
  assert.equal(t.customEventFilter[0].parameter.find((p) => p.key === 'arg1')?.value, 'purchase');
  // adds the {{_event}} condition if missing
  const t2 = setCustomEventName({ name: 'x', type: 'customEvent' }, 'add to cart') as { customEventFilter: Array<{ parameter: Array<{ key: string; value: string }> }> };
  assert.equal(t2.customEventFilter[0].parameter.find((p) => p.key === 'arg1')?.value, 'add_to_cart');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
