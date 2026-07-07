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
  buildGtmClient,
  buildGa4ServerTag,
  buildServerAllEventsTrigger,
  buildServerEventTrigger,
  buildMetaEmqVariables,
  buildMetaPixelTag,
  buildMetaCapiServerTag,
  metaStandardEvent,
  buildTikTokCapiServerTag,
  buildTikTokEmqVariables,
  buildLinkedInCapiServerTag,
  buildHotjarTag,
  buildPinterestTag,
  buildPinterestCapiServerTag,
  pinterestServerEvent,
  buildStackAdaptServerTag,
  buildRedditCapiServerTag,
  redditServerEvent,
  buildAmazonCapiServerTag,
  amazonServerEvent,
  buildSnapPixelTag,
  pinterestEvent,
  snapEventType,
  tikTokStandardEvent,
  TIKTOK_EVENT_PROPERTIES,
  META_EVENT_OBJECT_PROPERTIES,
  metaWebObjectProps,
  isGa4EcommerceEvent,
  normalizeCustomEventName,
  normalizeCustomEventTrigger,
  setCustomEventName,
  findUnusedTriggers,
  collectUsedTriggerIds,
  triggerUsageBreakdown,
  findUnusedVariables,
  collectReferencedVariableNames,
  findDanglingVariableReferences,
  inspectVariableConfig,
  findVariableNamingIssues,
  varParam,
  BUILTIN_VARIABLE_NAMES,
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
  triggerDataLayerVarKeys,
  builtInVarsForTemplates,
  buildVariable,
  buildFormNameVariable,
  buildUrlQueryVariable,
  buildEcommerceDlvVariables,
  ECOMMERCE_DLV_KEYS,
  GA4_ECOMMERCE_FUNNEL_EVENTS,
  buildConsentModeDefaultTag,
  CONSENT_INIT_TRIGGER_ID,
  evaluateTrackingSetup,
  auditContainer,
  sanitizeName,
  matchesServerContainer,
  findGa4BaseTag,
  ga4VariablePlan,
  planTriggerRetarget,
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

test('trigger conditions: negated operators emit the base type + a negate parameter; numeric ops map through', () => {
  // "does not contain" → type contains + {negate:true} (the GTM representation, corpus-verified). arg0/arg1 unchanged.
  const neg = buildTrigger({ name: 'x', kind: 'all_clicks', clickTextValue: 'spam', clickTextOperator: 'notContains' });
  const nf = (neg.filter ?? [])[0] as { type: string; parameter: Array<Record<string, unknown>> };
  assert.equal(nf.type, 'contains');
  assert.equal(nf.parameter.find((p) => p.key === 'arg1')?.value, 'spam');
  const ng = nf.parameter.find((p) => p.key === 'negate');
  assert.equal(ng?.type, 'boolean');
  assert.equal(ng?.value, 'true');
  // A non-negated operator emits NO negate parameter.
  const pos = buildTrigger({ name: 'x', kind: 'all_clicks', clickTextValue: 'buy', clickTextOperator: 'contains' });
  assert.equal(((pos.filter ?? [])[0] as { parameter: Array<Record<string, unknown>> }).parameter.find((p) => p.key === 'negate'), undefined);
  // greaterOrEquals / lessOrEquals map straight to their GTM condition types.
  const ge = buildTrigger({ name: 'x', kind: 'all_clicks', clickTextValue: '3', clickTextOperator: 'greaterOrEquals' });
  assert.equal(((ge.filter ?? [])[0] as { type: string }).type, 'greaterOrEquals');
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

test('custom_event trigger: dataLayerConditions scope on a pushed key via {{dlv - <key>}} (a manual push, where {{Form ID}} does not resolve)', () => {
  // AJAX/embed forms push {event, form_id}; {{Form ID}} is NOT populated by a manual push, so scope on
  // the pushed key via a {{dlv - form_id}} Data Layer Variable instead.
  const tr = buildTrigger({
    name: 'Contact Form (HubSpot)',
    kind: 'custom_event',
    eventName: 'form_submit',
    pagePathValue: '/contact',
    pagePathOperator: 'contains',
    dataLayerConditions: [{ key: 'form_id', value: 'contact', operator: 'equals' }],
  });
  assert.equal(tr.type, 'customEvent');
  // The {{_event}} customEventFilter is untouched.
  const ce = (tr.customEventFilter ?? [])[0] as { parameter: Array<Record<string, unknown>> };
  assert.equal(ce.parameter.find((p) => p.key === 'arg1')?.value, 'form_submit');
  const filters = (tr.filter ?? []) as Array<{ type: string; parameter: Array<Record<string, unknown>> }>;
  assert.equal(filters.length, 2); // Page Path (kept) AND dlv - form_id
  // The DLV condition references {{dlv - form_id}} equals "contact".
  const dlv = filters.find((fl) => fl.parameter.find((p) => p.key === 'arg0')?.value === '{{dlv - form_id}}');
  assert.ok(dlv, 'a {{dlv - form_id}} condition is emitted');
  assert.equal(dlv!.type, 'equals');
  assert.equal(dlv!.parameter.find((p) => p.key === 'arg1')?.value, 'contact');
  // triggerDataLayerVarKeys surfaces the key to auto-create the variable.
  assert.deepEqual(triggerDataLayerVarKeys({ name: 'x', kind: 'custom_event', eventName: 'form_submit', dataLayerConditions: [{ key: 'form_id', value: 'contact' }] }), ['form_id']);
  // The DLV is a CUSTOM variable, not a built-in, so nothing extra is enabled for it (only page scope here).
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'custom_event', eventName: 'form_submit', pagePathValue: '/contact', dataLayerConditions: [{ key: 'form_id', value: 'contact' }] }), ['pagePath']);
});

test('custom_event trigger: dataLayerConditions skips empty key/value; default operator is equals; keys are de-duped', () => {
  const tr = buildTrigger({
    name: 'x',
    kind: 'custom_event',
    eventName: 'lead',
    dataLayerConditions: [
      { key: 'form_id', value: 'a' }, // no operator → equals
      { key: '', value: 'skip' }, // empty key → skipped
      { key: 'form_id', value: '' }, // empty value → skipped
      { key: 'form_id', value: 'b' }, // duplicate key (for var collection) → one key
    ],
  });
  const filters = (tr.filter ?? []) as Array<{ type: string; parameter: Array<Record<string, unknown>> }>;
  // Two non-empty conditions survive (form_id=a, form_id=b); both default to equals.
  assert.equal(filters.length, 2);
  assert.ok(filters.every((fl) => fl.type === 'equals'));
  assert.ok(filters.every((fl) => fl.parameter.find((p) => p.key === 'arg0')?.value === '{{dlv - form_id}}'));
  // Distinct non-empty keys only.
  assert.deepEqual(triggerDataLayerVarKeys({ name: 'x', kind: 'custom_event', eventName: 'lead', dataLayerConditions: [{ key: 'form_id', value: 'a' }, { key: '', value: 'skip' }, { key: 'form_id', value: 'b' }] }), ['form_id']);
});

test('triggerDataLayerVarKeys: [] for a form_submit trigger — dataLayerConditions are ignored on non-custom_event kinds', () => {
  // form_submit uses native {{Form ID}}, which DOES resolve there — no dlv needed.
  const keys = triggerDataLayerVarKeys({ name: 'x', kind: 'form_submit', formIdValue: 'contact', dataLayerConditions: [{ key: 'form_id', value: 'contact' }] } as never);
  assert.deepEqual(keys, []);
  // And buildTrigger's form_submit path does NOT emit a {{dlv - ...}} condition.
  const tr = buildTrigger({ name: 'x', kind: 'form_submit', formIdValue: 'contact', dataLayerConditions: [{ key: 'form_id', value: 'contact' }] } as never);
  const filters = (tr.filter ?? []) as Array<{ parameter: Array<Record<string, unknown>> }>;
  assert.ok(!filters.some((fl) => String(fl.parameter.find((p) => p.key === 'arg0')?.value ?? '').startsWith('{{dlv')));
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
  // no epToAdd/upToAdd unless explicitly requested (the plain relay forwards everything via "All")
  assert.equal(p.find((x) => x.key === 'epToAdd'), undefined, 'no add-parameters list on a plain relay');
});

test('buildGa4ServerTag: optional eventParameters/userProperties → epToAdd/upToAdd (name/value rows)', () => {
  const t = buildGa4ServerTag('GA4 - Enriched', 'G-1', 'purchase', ['9'], {
    eventParameters: [{ name: 'page_type', value: 'checkout' }, { name: '', value: 'dropped' }],
    userProperties: [{ name: 'membership', value: '{{User Tier}}' }],
  });
  const rowsOf = (key: string): Array<[string, string]> => {
    const p = ((t.parameter as Array<{ key?: string; list?: Array<{ map: Array<{ key?: string; value?: string }> }> }>) ?? []).find((x) => x.key === key);
    return (p?.list ?? []).map((r) => [r.map.find((m) => m.key === 'name')?.value ?? '', r.map.find((m) => m.key === 'value')?.value ?? '']);
  };
  assert.deepEqual(rowsOf('epToAdd'), [['page_type', 'checkout']], 'empty-name row dropped');
  assert.deepEqual(rowsOf('upToAdd'), [['membership', '{{User Tier}}']]);
  // the relay still keeps its base config
  const keys = (t.parameter as Array<{ key?: string }>).map((x) => x.key);
  assert.ok(keys.includes('measurementId') && keys.includes('epToIncludeDropdown'), 'base relay config preserved');
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

test('buildServerEventTrigger → CUSTOM_EVENT on ONE event ({{_event}} equals purchase) + client scope', () => {
  const tr = buildServerEventTrigger('ga4 - purchase', 'purchase', 'GA4');
  assert.equal(tr.type, 'customEvent');
  const cef = (tr.customEventFilter ?? []) as Array<{ type: string; parameter: Array<{ key: string; value: string }> }>;
  assert.equal(cef.length, 1);
  assert.equal(cef[0].type, 'equals'); // the corpus-dominant per-event pattern (not matchRegex .*)
  assert.equal(cef[0].parameter.find((x) => x.key === 'arg0')?.value, '{{_event}}');
  assert.equal(cef[0].parameter.find((x) => x.key === 'arg1')?.value, 'purchase');
  const f = (tr.filter ?? []) as Array<{ type: string; parameter: Array<{ key: string; value: string }> }>;
  assert.equal(f[0].parameter.find((x) => x.key === 'arg0')?.value, '{{Client Name}}');
  assert.equal(f[0].parameter.find((x) => x.key === 'arg1')?.value, 'GA4');
  // No client → no filter.
  assert.equal(buildServerEventTrigger('t', 'purchase').filter, undefined);
});

test('buildVariable request_header → server rh variable reading one HTTP header', () => {
  const v = buildVariable({ name: 'X-Geo-Country', kind: 'request_header', headerName: 'X-Geo-Country' });
  assert.equal(v.type, 'rh');
  assert.equal((v.parameter ?? []).length, 1);
  assert.equal(findParam(v.parameter ?? [], 'headerName')?.value, 'X-Geo-Country');
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

test('matchesServerContainer: case-insensitive name + server usageContext; ignores web containers', () => {
  const want = 'www.example.com - Server';
  // Exact match.
  assert.equal(matchesServerContainer({ name: 'www.example.com - Server', usageContext: ['server'] }, want), true);
  // GTM may echo usageContext uppercase; name casing may differ — still a match.
  assert.equal(matchesServerContainer({ name: 'WWW.EXAMPLE.COM - SERVER', usageContext: ['SERVER'] }, want), true);
  // A WEB container with the same name is NOT a server container.
  assert.equal(matchesServerContainer({ name: 'www.example.com - Server', usageContext: ['web'] }, want), false);
  // Different name → no match.
  assert.equal(matchesServerContainer({ name: 'other - Server', usageContext: ['server'] }, want), false);
  // Missing/empty usageContext → no match (never reuse a container we can't confirm is server).
  assert.equal(matchesServerContainer({ name: want, usageContext: null }, want), false);
  assert.equal(matchesServerContainer({ name: want }, want), false);
});

test('Ads server tag builders emit the corpus-validated sgtm types + key fields', () => {
  // conversionId MUST be the numeric id: the sgtmadsct/sgtmadsremarket templates validate it as a
  // positive integer, so the "AW-" prefix is stripped (an "AW-12345678" input became a 400 before).
  const conv = buildAdsConversionServerTag('Ads - Purchase', 'AW-12345678', 'abcLABEL');
  assert.equal(conv.type, 'sgtmadsct');
  const cp = (conv.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(cp.find((x) => x.key === 'conversionId')?.value, '12345678', 'AW- prefix stripped to the numeric id');
  assert.equal(cp.find((x) => x.key === 'conversionLabel')?.value, 'abcLABEL');
  assert.equal(cp.find((x) => x.key === 'enableConversionLinker')?.value, 'true');
  // A {{variable}} conversion id passes through untouched.
  const convVar = buildAdsConversionServerTag('Ads', '{{Ads ID}}', 'L');
  assert.equal(((convVar.parameter ?? []) as Array<{ key: string; value: string }>).find((x) => x.key === 'conversionId')?.value, '{{Ads ID}}');

  const linker = buildAdsConversionLinkerServerTag('Ads - Linker');
  assert.equal(linker.type, 'sgtmadscl');

  const rmkt = buildAdsRemarketingServerTag('Ads - Remarketing', 'AW-12345678');
  assert.equal(rmkt.type, 'sgtmadsremarket');
  const rp = (rmkt.parameter ?? []) as Array<{ key: string; value: string }>;
  assert.equal(rp.find((x) => x.key === 'conversionId')?.value, '12345678', 'remarketing conversionId also stripped');
  assert.equal(rp.find((x) => x.key === 'enableDynamicRemarketing')?.value, 'true');
  assert.equal(rp.find((x) => x.key === 'remarketingEventDataSource')?.value, 'EVENT_DATA');
});

test('buildFormNameVariable → reusable "Form Name" Custom JS variable reading {{Form Element}}', () => {
  const v = buildFormNameVariable();
  assert.equal(v.name, 'Form Name');
  assert.equal(v.type, 'jsm'); // Custom JavaScript
  const js = ((v.parameter ?? []) as Array<{ key: string; value: string }>).find((x) => x.key === 'javascript')?.value ?? '';
  assert.match(js, /\{\{Form Element\}\}/, 'reads the submitted form element');
  assert.match(js, /getAttribute\('name'\)/);
  assert.match(js, /aria-label/);
  assert.match(js, /h1,h2,h3/, 'falls back to the nearest heading');
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

// Helpers for the corpus-motivated server checks (Vocal Minority GTM-57RM3QCT reference).
const clientNameEqualsGa4 = [
  { type: 'EQUALS', parameter: [
    { type: 'template', key: 'arg0', value: '{{Client Name}}' },
    { type: 'template', key: 'arg1', value: 'GA4' },
  ] },
];
const gaawTag = (tagId: string, name: string, measurementId: string, firingTriggerId: string[], paused = false) => ({
  tagId, name, type: 'sgtmgaaw', firingTriggerId, blockingTriggerId: [] as string[], paused,
  parameter: [{ type: 'template', key: 'measurementId', value: measurementId }], consentSettings: null,
});
// A Stape Facebook CAPI tag: pixelId + accessToken + a Facebook-distinctive key (generateFbp)
// so isMetaCapiServerTag recognizes it and does not confuse it with a TikTok CAPI tag.
const metaCapiTag = (tagId: string, name: string, params: Array<{ key: string; value: string }>) => ({
  tagId, name, type: 'cvt_5TP8W', firingTriggerId: ['1'], blockingTriggerId: [] as string[], paused: false,
  parameter: [
    { type: 'boolean', key: 'generateFbp', value: 'true' },
    ...params.map((p) => ({ type: 'template', key: p.key, value: p.value })),
  ],
  consentSettings: null,
});

test('auditServerContainer (1): flags DUPLICATE GA4 relays — same Measurement ID, equivalent triggers (different ids) → critical double-count', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    // Two ACTIVE GA4 relays on the SAME id firing on triggers #6 and #10 whose conditions are
    // identical ("Client Name equals GA4") though the ids differ — exactly the reference defect.
    triggers: [
      { triggerId: '6', name: 'GA Client Trigger', type: 'ALWAYS', filter: clientNameEqualsGa4 },
      { triggerId: '10', name: 'GA Client', type: 'ALWAYS', filter: clientNameEqualsGa4 },
    ],
    tags: [
      gaawTag('7', 'GA4 Tag', 'G-VOCAL', ['6']),
      gaawTag('15', 'Google Analytics GA4', 'G-VOCAL', ['10']),
    ],
  });
  const dup = rep.findings.find((f) => /counted 2× in GA4/i.test(f.message));
  assert.ok(dup, 'emits a duplicate-relay finding');
  assert.equal(dup!.severity, 'critical');
  assert.ok(/"GA4 Tag"/.test(dup!.message) && /"Google Analytics GA4"/.test(dup!.message), 'names both duplicate tags');
  assert.ok(/G-VOCAL/.test(dup!.message), 'names the shared Measurement ID');
});

test('auditServerContainer (1): does NOT flag GA4 relays with different ids/triggers, paused, TRIGGERLESS, or different eventName overrides', () => {
  const withEvent = (t: ReturnType<typeof gaawTag>, ev: string) => ({
    ...t, parameter: [...t.parameter, { type: 'template', key: 'eventName', value: ev }],
  });
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [
      { triggerId: '6', name: 'GA Client Trigger', type: 'ALWAYS', filter: clientNameEqualsGa4 },
      { triggerId: '20', name: 'Purchase only', type: 'ALWAYS', filter: [
        { type: 'EQUALS', parameter: [
          { type: 'template', key: 'arg0', value: '{{Event Name}}' },
          { type: 'template', key: 'arg1', value: 'purchase' },
        ] },
      ] },
    ],
    tags: [
      gaawTag('7', 'GA4 Prod', 'G-AAA', ['6']),        // distinct id
      gaawTag('8', 'GA4 Staging', 'G-BBB', ['6']),      // distinct id, same trigger — not a dup
      gaawTag('9', 'GA4 Narrow', 'G-AAA', ['20']),      // same id but a genuinely narrower trigger
      { ...gaawTag('12', 'GA4 Paused Dup', 'G-AAA', ['6']), paused: true }, // paused → excluded
      // Two ACTIVE same-id relays that NEVER fire (no trigger) — cannot double-count.
      gaawTag('30', 'GA4 Triggerless A', 'G-CCC', []),
      gaawTag('31', 'GA4 Triggerless B', 'G-CCC', []),
      // Two same-id relays on the SAME trigger but stamping DIFFERENT event names — complementary.
      withEvent(gaawTag('40', 'GA4 Purchase Relay', 'G-DDD', ['6']), 'purchase'),
      withEvent(gaawTag('41', 'GA4 AddToCart Relay', 'G-DDD', ['6']), 'add_to_cart'),
    ],
  });
  assert.ok(!rep.findings.some((f) => /counted .× in GA4/i.test(f.message)), 'no duplicate-relay false positive');
});

test('auditServerContainer (1): DOES flag two same-id relays on the same trigger that stamp the SAME event name', () => {
  const withEvent = (t: ReturnType<typeof gaawTag>, ev: string) => ({
    ...t, parameter: [...t.parameter, { type: 'template', key: 'eventName', value: ev }],
  });
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [{ triggerId: '6', name: 'GA Client Trigger', type: 'ALWAYS', filter: clientNameEqualsGa4 }],
    tags: [
      withEvent(gaawTag('50', 'GA4 Purchase A', 'G-EEE', ['6']), 'purchase'),
      withEvent(gaawTag('51', 'GA4 Purchase B', 'G-EEE', ['6']), 'purchase'),
    ],
  });
  assert.ok(rep.findings.some((f) => f.severity === 'critical' && /counted 2× in GA4/i.test(f.message)), 'same event on same trigger IS a duplicate');
});

test('auditServerContainer (2): flags URL-ENCODED trigger filter values on BOTH camelCase (live API) and UPPER_SNAKE (export) operators, not decoded or regex values', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [
      // camelCase operator — the shape the LIVE tagmanager API returns (the runtime audit path).
      { triggerId: '93', name: 'Sign Petition Click Trigger', type: 'ALWAYS', filter: [
        { type: 'contains', parameter: [
          { type: 'template', key: 'arg0', value: '{{Event Name}}' },
          { type: 'template', key: 'arg1', value: 'Sign+Petition+Click' },
        ] },
      ] },
      // UPPER_SNAKE operator — the shape a container EXPORT uses; must also be caught.
      { triggerId: '129', name: 'Form Submit Trigger', type: 'ALWAYS', filter: [
        { type: 'EQUALS', parameter: [
          { type: 'template', key: 'arg0', value: '{{Page URL Variable}}' },
          { type: 'template', key: 'arg1', value: '/petition%2Frefugee-rights/' },
        ] },
      ] },
      // Decoded event name — must NOT be flagged.
      { triggerId: '153', name: 'Decoded Form Submit', type: 'ALWAYS', filter: [
        { type: 'contains', parameter: [
          { type: 'template', key: 'arg0', value: '{{Event Name}}' },
          { type: 'template', key: 'arg1', value: 'Sign Petition Form Submission' },
        ] },
      ] },
      // A regex quantifier '+' is legal — matchRegex/MATCH_REGEX must NOT be flagged (both casings).
      { triggerId: '114', name: 'Regex URL', type: 'ALWAYS', filter: [
        { type: 'matchRegex', parameter: [
          { type: 'template', key: 'arg0', value: '{{Page URL Variable}}' },
          { type: 'template', key: 'arg1', value: '/expose-plastic/|/protect-turtles/a+b' },
        ] },
      ] },
    ],
    tags: [gaawTag('7', 'GA4 Tag', 'G-1', ['6'])],
  });
  const encoded = rep.findings.filter((f) => f.category === 'firing' && /URL-encoded/i.test(f.message));
  const names = encoded.map((f) => f.resource?.name).sort();
  assert.deepEqual(names, ['Form Submit Trigger', 'Sign Petition Click Trigger'], 'flags the encoded triggers regardless of operator casing');
  assert.ok(encoded.every((f) => f.severity === 'high'));
  assert.ok(encoded.some((f) => /"Sign\+Petition\+Click"/.test(f.message)), 'echoes the offending value');
  assert.ok(!rep.findings.some((f) => f.resource?.name === 'Decoded Form Submit'), 'decoded value not flagged');
  assert.ok(!rep.findings.some((f) => f.resource?.name === 'Regex URL'), 'regex quantifier not flagged');
});

test('auditServerContainer (3): flags SWAPPED Pixel ID / Access Token (never echoing the token), not correct or variable-backed tags', () => {
  const fakeToken = 'EAA' + 'x'.repeat(200); // token-shaped, NOT a real token
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [],
    tags: [
      // Swapped: pixelId holds the token, accessToken holds the 15-digit id (Church-in-Need defect).
      metaCapiTag('145', 'Church Need - Sign Petition Click CAPI Tag', [
        { key: 'pixelId', value: fakeToken },
        { key: 'accessToken', value: '123456789012345' },
      ]),
      // Correct wiring — must NOT be flagged.
      metaCapiTag('141', 'Church Need - Page View CAPI Tag', [
        { key: 'pixelId', value: '123456789012345' },
        { key: 'accessToken', value: fakeToken },
      ]),
      // Variable-backed — unknowable shape, must NOT be flagged.
      metaCapiTag('166', 'Parkinsons - Page View CAPI Tag', [
        { key: 'pixelId', value: '{{Parkinsons NSW Pixel ID}}' },
        { key: 'accessToken', value: '{{Parkinsons NSW API Token}}' },
      ]),
    ],
  });
  const swapped = rep.findings.filter((f) => /swapped/i.test(f.message));
  assert.equal(swapped.length, 1, 'exactly one swapped-field finding');
  assert.equal(swapped[0].resource?.id, '145');
  assert.equal(swapped[0].severity, 'high');
  assert.equal(swapped[0].category, 'security');
  assert.ok(!swapped[0].message.includes(fakeToken), 'never echoes the token value');
  assert.ok(!swapped[0].recommendation.includes(fakeToken), 'never echoes the token in the recommendation');
});

test('auditServerContainer (4): flags a Test Event Code left set (testId) as medium + auto-fixable clearing it', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [],
    tags: [
      metaCapiTag('107', 'UNHCR - Page View CAPI Tag', [
        { key: 'pixelId', value: '123456789012345' },
        { key: 'accessToken', value: 'EAA' + 'x'.repeat(200) },
        { key: 'testId', value: 'TEST30857' },
      ]),
      // Empty testId → production → must NOT be flagged.
      metaCapiTag('141', 'UNHCR - Clean CAPI Tag', [
        { key: 'pixelId', value: '123456789012345' },
        { key: 'accessToken', value: 'EAA' + 'x'.repeat(200) },
        { key: 'testId', value: '' },
      ]),
    ],
  });
  const testFindings = rep.findings.filter((f) => /Test Event Code/i.test(f.message));
  assert.equal(testFindings.length, 1, 'only the tag with a non-empty testId is flagged');
  const f = testFindings[0];
  assert.equal(f.severity, 'medium');
  assert.equal(f.resource?.id, '107');
  assert.equal(f.autoFixable, true);
  assert.equal(f.fix?.tool, 'update_gtm_tag');
  const clears = (f.fix?.args.tag as { parameter: Array<{ key: string; value: string }> }).parameter
    .some((p) => p.key === 'testId' && p.value === '');
  assert.ok(clears, 'the fix clears testId');
});

test('auditServerContainer (3/4): a TikTok CAPI tag (cvt_ with pixelId+accessToken but NO generateFbp/actionSource) is NOT audited under Meta rules', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [],
    tags: [
      // A TikTok server tag shares the pixelId/accessToken keys but uses TikTok-distinctive
      // fields (generateTtp/eventSource) and 'testEventCode' — not generateFbp/actionSource/testId.
      // A digit-shaped accessToken here must NOT be read as a swapped Meta Pixel ID.
      {
        tagId: '139', name: 'TikTok - CareFlight CAPI Tag', type: 'cvt_TT01',
        firingTriggerId: ['1'], blockingTriggerId: [], paused: false, consentSettings: null,
        parameter: [
          { type: 'boolean', key: 'generateTtp', value: 'true' },
          { type: 'template', key: 'eventSource', value: 'web' },
          { type: 'template', key: 'pixelId', value: '123456789012345' },
          { type: 'template', key: 'accessToken', value: '123456789012345' },
          { type: 'template', key: 'testEventCode', value: 'TEST123' },
        ],
      },
    ],
  });
  assert.ok(!rep.findings.some((f) => /swapped/i.test(f.message)), 'TikTok tag not flagged for swapped Meta fields');
  assert.ok(!rep.findings.some((f) => /Test Event Code/i.test(f.message)), 'TikTok testEventCode not read as a Meta testId');
});

// A TikTok Events API server tag: generateTtp + eventSource (never generateFbp/actionSource), so
// isTikTokCapiServerTag recognizes it and isMetaCapiServerTag does not.
const tiktokCapiTag = (tagId: string, name: string, extra: Array<{ type: string; key: string; value?: string; list?: unknown }>) => ({
  tagId, name, type: 'cvt_TT9', firingTriggerId: ['1'], blockingTriggerId: [] as string[], paused: false, consentSettings: null,
  parameter: [
    { type: 'boolean', key: 'generateTtp', value: 'true' },
    { type: 'template', key: 'eventSource', value: 'web' },
    { type: 'template', key: 'pixelId', value: '123456789012345' },
    { type: 'template', key: 'accessToken', value: 'TTTOKEN' },
    ...extra,
  ],
});

// A Stape Meta CAPI tag with an explicit auto-map toggle (autoMapServerEventData) and an optional
// serverEventDataList event_id OVERRIDE row. autoMapValue null = toggle absent (template default ON).
const metaCapiToggled = (tagId: string, name: string, autoMapValue: string | null, eventIdRow: boolean) => ({
  tagId, name, type: 'cvt_5TP8W', firingTriggerId: ['1'], blockingTriggerId: [] as string[], paused: false, consentSettings: null,
  parameter: [
    { type: 'boolean', key: 'generateFbp', value: 'true' },
    { type: 'template', key: 'pixelId', value: '123456789012345' },
    { type: 'template', key: 'accessToken', value: 'EAAtoken' },
    ...(autoMapValue !== null ? [{ type: 'boolean', key: 'autoMapServerEventData', value: autoMapValue }] : []),
    ...(eventIdRow
      ? [{ type: 'list', key: 'serverEventDataList', list: [{ type: 'map', map: [{ type: 'template', key: 'name', value: 'event_id' }, { type: 'template', key: 'value', value: '{{ed - event_id}}' }] }] }]
      : []),
  ],
});
// A LinkedIn CAPI server tag: distinguished by conversionRuleUrn (never pixelId), so isMeta/isTikTok never
// match it. Its template always auto-extracts eventId (getAllEventData, no toggle) → never config-flaggable.
const linkedinCapiTag = (tagId: string, name: string) => ({
  tagId, name, type: 'cvt_LI7', firingTriggerId: ['1'], blockingTriggerId: [] as string[], paused: false, consentSettings: null,
  parameter: [
    { type: 'template', key: 'type', value: 'conversion' },
    { type: 'template', key: 'accessToken', value: 'LITOKEN' },
    { type: 'template', key: 'conversionRuleUrn', value: 'urn:lla:llaPartnerConversion:99' },
  ],
});
// A Pinterest CAPI server tag: advertiserId + apiAccessToken (never pixelId/accessToken), auto-extracts
// event_id via getAllEventData (autoMapServerEventDataParameters default on) → never config-flaggable.
const pinterestCapiTag = (tagId: string, name: string) => ({
  tagId, name, type: 'cvt_PIN', firingTriggerId: ['1'], blockingTriggerId: [] as string[], paused: false, consentSettings: null,
  parameter: [
    { type: 'template', key: 'advertiserId', value: '549123456789' },
    { type: 'template', key: 'apiAccessToken', value: 'PINTOKEN' },
  ],
});
const dedupNoId = (f: { message: string }): boolean => /turned off and maps no explicit event_id/.test(f.message);

test('auditServerContainer (5): flags a Meta/TikTok CAPI tag ONLY when auto-map is explicitly off AND no explicit event_id', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [{ triggerId: '1', name: 'All', type: 'customEvent' }],
    tags: [
      // Meta: auto-map explicitly OFF + no override row → the one config that proves no id is sent → FLAGGED.
      metaCapiToggled('2', 'Meta off no id', 'false', false),
      // Meta: auto-map OFF but an explicit event_id override row present → id IS sent → NOT flagged.
      metaCapiToggled('3', 'Meta off with id', 'false', true),
      // Meta: toggle absent (template default ON) + no row → auto-extracts at runtime → NOT flagged (regression:
      // the old rule false-positived here).
      metaCapiToggled('4', 'Meta default no id', null, false),
      // Meta: auto-map explicitly ON + no row → auto-extracts → NOT flagged.
      metaCapiToggled('5', 'Meta on no id', 'true', false),
      // Meta from our builder → carries an event_id override row → NOT flagged.
      { ...buildMetaCapiServerTag('cvt_5TP8W', 'Meta builder with id', 'P', 'T', 'Purchase', { firingTriggerId: ['1'] }), tagId: '6', firingTriggerId: ['1'], paused: false, blockingTriggerId: [], consentSettings: null },
      // TikTok: auto-map explicitly OFF + no eventId → FLAGGED.
      tiktokCapiTag('7', 'TikTok off no id', [{ type: 'boolean', key: 'autoMapCommonEventData', value: 'false' }]),
      // TikTok: auto-map OFF but explicit eventId mapped → NOT flagged.
      tiktokCapiTag('8', 'TikTok off with id', [{ type: 'boolean', key: 'autoMapCommonEventData', value: 'false' }, { type: 'template', key: 'eventId', value: '{{ed - event_id}}' }]),
      // TikTok: toggle absent (default ON) + no eventId → NOT flagged (regression).
      tiktokCapiTag('9', 'TikTok default no id', []),
    ],
  });
  const noId = rep.findings.filter(dedupNoId);
  assert.equal(noId.length, 2, 'flags exactly the two auto-map-OFF + no-id tags (Meta + TikTok)');
  // Anchor the computed `${platform}` PREFIX to the specific tag so a future label swap (Meta detected as
  // TikTok or vice-versa) fails here — an unanchored /Meta off no id/ would still match inside the quoted
  // tag name and hide the regression.
  assert.ok(noId.some((f) => /^Meta CAPI server tag "Meta off no id"/.test(f.message)), 'the Meta tag is labeled Meta');
  assert.ok(noId.some((f) => /^TikTok CAPI server tag "TikTok off no id"/.test(f.message)), 'the TikTok tag is labeled TikTok');
  assert.ok(noId.every((f) => f.severity === 'low' && f.confidence === 'runtime-required'), 'advisory: low + runtime-required (the web side is invisible)');
  assert.ok(noId.every((f) => /can double-count/.test(f.message) && !/counts the conversion twice/.test(f.message)), 'phrased conditionally, never as a proven double-count');
  assert.ok(noId.every((f) => f.checkId === 'server_capi_no_event_id'), 'carries the STABLE dedup checkId (consumed by the tracking-status dedup dimension)');
  // None of the auto-map-ON / explicit-id / builder tags are flagged.
  for (const nm of ['Meta off with id', 'Meta default no id', 'Meta on no id', 'Meta builder with id', 'TikTok off with id', 'TikTok default no id']) {
    assert.ok(!noId.some((f) => new RegExp(nm).test(f.message)), `${nm} must NOT be flagged`);
  }
});

test('auditServerContainer (5): excludes LinkedIn and Pinterest CAPI tags (they auto-extract event_id, not config-checkable)', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [{ triggerId: '1', name: 'All', type: 'customEvent' }],
    tags: [
      linkedinCapiTag('2', 'LinkedIn CAPI - no explicit id'),
      pinterestCapiTag('3', 'Pinterest CAPI - no explicit id'),
    ],
  });
  assert.ok(!rep.findings.some(dedupNoId), 'LinkedIn/Pinterest are never flagged for a missing event_id (auto-extract is invisible to a server-only audit)');
});

test('auditServerContainer (5): does not flag paused or trigger-less CAPI tags even when auto-map is off', () => {
  const rep = auditServerContainer({
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
    transformations: [],
    triggers: [],
    tags: [
      { ...metaCapiToggled('2', 'Paused', 'false', false), paused: true },
      { ...metaCapiToggled('3', 'No trigger', 'false', false), firingTriggerId: [] },
    ],
  });
  assert.ok(!rep.findings.some(dedupNoId), 'paused + trigger-less CAPI tags are not flagged for dedup');
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

test('buildMetaEmqVariables: email/phone get a NESTED user_data.* fallback (GA4 nested shape never blanks)', () => {
  const vars = buildMetaEmqVariables();
  const byName = new Map(vars.map((v) => [v.name, v]));
  for (const key of ['email_address', 'phone_number']) {
    const companion = byName.get(`ed - user_data.${key}`);
    assert.ok(companion, `companion ed - user_data.${key} exists`);
    const ckp = (companion!.parameter ?? []).find((p) => (p as { key?: string }).key === 'keyPath') as { value?: string };
    assert.equal(ckp?.value, `user_data.${key}`);
    const primary = byName.get(`ed - ${key}`)!;
    const dv = (primary.parameter ?? []).find((p) => (p as { key?: string }).key === 'defaultValue') as { value?: string };
    assert.equal(dv?.value, `{{ed - user_data.${key}}}`, `ed - ${key} falls back to the nested companion`);
  }
});

test('buildMetaEmqVariables: creates ip_override + user_agent (erase-safe raw match), user_agent falls back to the request header', () => {
  const vars = buildMetaEmqVariables();
  const byName = new Map(vars.map((v) => [v.name, v]));
  // ip_override: event_data reading keyPath 'ip_override', falling back to the X-Forwarded-For header.
  const ip = byName.get('ed - ip_override');
  assert.ok(ip, 'ed - ip_override exists');
  assert.equal(ip!.type, 'ed');
  const ipKp = (ip!.parameter ?? []).find((p) => (p as { key?: string }).key === 'keyPath') as { value?: string };
  assert.equal(ipKp?.value, 'ip_override');
  const ipDv = (ip!.parameter ?? []).find((p) => (p as { key?: string }).key === 'defaultValue') as { value?: string };
  assert.equal(ipDv?.value, '{{rh - x-forwarded-for}}', 'ed - ip_override falls back to the X-Forwarded-For header');
  const rhXff = byName.get('rh - x-forwarded-for');
  assert.ok(rhXff && rhXff.type === 'rh', 'rh - x-forwarded-for request_header variable exists');
  const xffHn = (rhXff!.parameter ?? []).find((p) => (p as { key?: string }).key === 'headerName') as { value?: string };
  assert.equal(xffHn?.value, 'x-forwarded-for');
  // user_agent: event_data reading 'user_agent' with a defaultValue that falls back to the request header.
  const ua = byName.get('ed - user_agent');
  assert.ok(ua, 'ed - user_agent exists');
  assert.equal(ua!.type, 'ed');
  const uaKp = (ua!.parameter ?? []).find((p) => (p as { key?: string }).key === 'keyPath') as { value?: string };
  assert.equal(uaKp?.value, 'user_agent');
  const uaDv = (ua!.parameter ?? []).find((p) => (p as { key?: string }).key === 'defaultValue') as { value?: string };
  assert.equal(uaDv?.value, '{{rh - user-agent}}', 'ed - user_agent falls back to the request User-Agent header');
  // rh - user-agent: a request_header variable reading the 'user-agent' header.
  const rh = byName.get('rh - user-agent');
  assert.ok(rh, 'rh - user-agent exists');
  assert.equal(rh!.type, 'rh');
  const hn = (rh!.parameter ?? []).find((p) => (p as { key?: string }).key === 'headerName') as { value?: string };
  assert.equal(hn?.value, 'user-agent');
});

test('buildMetaCapiServerTag maps EMQ user_data (em/ph ONLY) + EVENT-AWARE ecommerce custom_data + event_id', () => {
  const t = buildMetaCapiServerTag('cvt_5TP8W', 'Meta CAPI - AddToCart Tag', 'P', 'T', 'AddToCart');
  const listOf = (tag: typeof t, key: string): Array<{ map: Array<{ key?: string; value?: string }> }> =>
    ((tag.parameter ?? []).find((p) => (p as { key?: string }).key === key) as { list?: Array<{ map: Array<{ key?: string; value?: string }> }> })?.list ?? [];
  const rowsOf = (tag: typeof t, key: string): Array<[string, string]> =>
    listOf(tag, key).map((r) => [r.map.find((m) => m.key === 'name')?.value ?? '', r.map.find((m) => m.key === 'value')?.value ?? '']);
  const rows = (key: string): Array<[string, string]> => rowsOf(t, key);
  // user_data: em/ph/external_id — the template extracts fn/ln/ct/zp/country itself (explicit rows for
  // those would ERASE template-extracted values when the ed variable resolves undefined); external_id is
  // NOT template-extracted, so adding it only ADDS matching (Meta's user-id field). client_ip_address /
  // client_user_agent are erase-safe (they read the same source the template extracts from, UA also
  // falling back to the request header) and are sent RAW (not hashed) — see META_USER_DATA_MAP.
  assert.deepEqual(rows('userDataList'), [
    ['em', '{{ed - email_address}}'],
    ['ph', '{{ed - phone_number}}'],
    ['external_id', '{{ed - external_id}}'],
    ['client_ip_address', '{{ed - ip_override}}'],
    ['client_user_agent', '{{ed - user_agent}}'],
  ]);
  // ed - external_id falls back to the GA4 user_id so it resolves whether the event has external_id or user_id.
  const emq = buildMetaEmqVariables();
  const extVar = emq.find((v) => v.name === 'ed - external_id');
  const extDefault = (extVar?.parameter ?? []).find((p) => (p as { key?: string }).key === 'defaultValue') as { value?: string } | undefined;
  assert.equal(extDefault?.value, '{{ed - user_id}}', 'external_id ed variable falls back to user_id');
  assert.ok(emq.some((v) => v.name === 'ed - user_id'), 'ed - user_id is created');
  // custom_data is the AddToCart recommended set (content_ids/contents/value/currency/num_items), NOT a
  // fixed list — no order_id (AddToCart has none). content_type is deliberately OMITTED so the template's
  // own product/product_group auto-detection is not clobbered by a hard-coded literal.
  assert.deepEqual(rows('customDataList'), [
    ['content_ids', '{{ed - content_ids}}'],
    ['contents', '{{ed - contents}}'],
    ['value', '{{ed - value}}'],
    ['currency', '{{ed - currency}}'],
    ['num_items', '{{ed - num_items}}'],
  ]);
  // content_type is never emitted as a custom_data row (the template auto-detects it).
  assert.ok(!rows('customDataList').some(([n]) => n === 'content_type'), 'content_type is left to the template');
  assert.deepEqual(rows('serverEventDataList'), [['event_id', '{{ed - event_id}}']]);
  // Purchase pulls in order_id (from transaction_id); a custom event falls back to the core set.
  const purchase = buildMetaCapiServerTag('cvt_5TP8W', 'Meta CAPI - Purchase Tag', 'P', 'T', 'Purchase');
  assert.ok(rowsOf(purchase, 'customDataList').some(([n, v]) => n === 'order_id' && v === '{{ed - transaction_id}}'), 'Purchase maps order_id');
  const custom = buildMetaCapiServerTag('cvt_5TP8W', 'Meta CAPI - Custom Tag', 'P', 'T', 'my_custom_event');
  assert.deepEqual(rowsOf(custom, 'customDataList').map(([n]) => n), ['content_ids', 'value', 'currency', 'order_id'], 'custom event → core ecommerce set');
  // Every referenced {{ed - …}} variable is provided by buildMetaEmqVariables (literals like "product" are skipped).
  const provided = new Set(buildMetaEmqVariables().map((v) => v.name));
  const referenced = [...rows('userDataList'), ...rows('customDataList'), ...rows('serverEventDataList')]
    .map(([, v]) => v).filter((v) => v.startsWith('{{')).map((v) => v.replace(/[{}]/g, ''));
  for (const ref of referenced) assert.ok(provided.has(ref), `${ref} is created by buildMetaEmqVariables`);
  // Opt-out: mapEmqVariables false → no lists at all.
  const off = buildMetaCapiServerTag('cvt_5TP8W', 'x', 'P', 'T', 'AddToCart', { mapEmqVariables: false });
  assert.ok(!(off.parameter ?? []).some((p) => ['userDataList', 'customDataList', 'serverEventDataList'].includes(String((p as { key?: string }).key))));
});

// Shared row extractor for the auto-fill tests.
const listRows = (tag: { parameter?: unknown }, key: string): Array<[string, string]> => {
  const p = ((tag.parameter as Array<{ key?: string; list?: Array<{ map: Array<{ key?: string; value?: string }> }> }>) ?? [])
    .find((x) => x.key === key);
  return (p?.list ?? []).map((r) => [r.map.find((m) => m.key === 'name')?.value ?? '', r.map.find((m) => m.key === 'value')?.value ?? '']);
};
const paramVal = (tag: { parameter?: unknown }, key: string): string | undefined =>
  ((tag.parameter as Array<{ key?: string; value?: string }>) ?? []).find((x) => x.key === key)?.value;

test('buildTikTokCapiServerTag: mapEventData (default) auto-fills user_data + event props + event_id from ed- variables', () => {
  const t = buildTikTokCapiServerTag('cvt_TT01', 'TikTok CAPI - Purchase Tag', '{{TT Pixel}}', '{{TT Token}}', 'purchase');
  assert.deepEqual(listRows(t, 'userDataList'), [
    ['email', '{{ed - email_address}}'],
    ['phone', '{{ed - phone_number}}'],
    ['external_id', '{{ed - external_id}}'],
    ['ip', '{{ed - ip_override}}'],
    ['user_agent', '{{ed - user_agent}}'],
  ]);
  const cd = new Map(listRows(t, 'customDataList'));
  assert.equal(cd.get('value'), '{{ed - value}}');
  assert.equal(cd.get('currency'), '{{ed - currency}}');
  assert.equal(cd.get('order_id'), '{{ed - transaction_id}}'); // order_id reads the GA4 transaction_id
  assert.equal(cd.get('content_type'), 'product'); // literal, not a variable
  assert.equal(paramVal(t, 'eventId'), '{{ed - event_id}}');
});

test('buildTikTokCapiServerTag: mapEventData=false leaves the lists empty; explicit rows override the auto-fill', () => {
  const off = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'purchase', { mapEventData: false });
  assert.ok(!((off.parameter as Array<{ key?: string }>) ?? []).some((p) => ['userDataList', 'customDataList', 'additionalEventPropertiesList'].includes(String(p.key))));
  assert.equal(paramVal(off, 'eventId'), undefined);
  const ex = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'purchase', {
    userData: [{ name: 'email', value: '{{My Email}}' }],
    eventProperties: [{ name: 'value', value: '{{My Value}}' }],
  });
  assert.deepEqual(listRows(ex, 'userDataList'), [['email', '{{My Email}}']]);
  assert.deepEqual(listRows(ex, 'customDataList'), [['value', '{{My Value}}']]);
});

test('buildTikTokEmqVariables: creates ed- variables for every auto-filled reference; email/phone get a nested fallback', () => {
  const vars = buildTikTokEmqVariables();
  const names = new Set(vars.map((v) => v.name));
  for (const k of ['email_address', 'phone_number', 'external_id', 'event_id', 'value', 'currency', 'contents', 'content_ids', 'content_type', 'num_items', 'transaction_id', 'search_string', 'description', 'ip_override', 'user_agent']) {
    assert.ok(names.has(`ed - ${k}`), `has ed - ${k}`);
  }
  assert.ok(names.has('ed - user_data.email_address'), 'nested email fallback exists');
  // ip/user_agent fall back to request headers, and the rh variables are created for them.
  assert.ok(names.has('rh - user-agent') && names.has('rh - x-forwarded-for'), 'rh - user-agent + rh - x-forwarded-for created');
  const uaVar = vars.find((v) => v.name === 'ed - user_agent');
  const uaDv = (uaVar?.parameter ?? []).find((p) => (p as { key?: string }).key === 'defaultValue') as { value?: string } | undefined;
  assert.equal(uaDv?.value, '{{rh - user-agent}}', 'ed - user_agent falls back to the request header');
  const ipVar = vars.find((v) => v.name === 'ed - ip_override');
  const ipDv = (ipVar?.parameter ?? []).find((p) => (p as { key?: string }).key === 'defaultValue') as { value?: string } | undefined;
  assert.equal(ipDv?.value, '{{rh - x-forwarded-for}}', 'ed - ip_override falls back to the X-Forwarded-For header');
  // The six OPT-IN address advanced-matching variables always exist (available whether or not a tag uses them).
  for (const suffix of ['address.first_name', 'address.last_name', 'address.city', 'address.region', 'address.country', 'address.postal_code']) {
    assert.ok(names.has(`ed - ${suffix}`), `has ed - ${suffix}`);
  }
  // Every {{ed - …}} the auto-filled TikTok tag references is actually created — including the opt-in
  // address rows (matchAddress) so their `ed - address.*` references are validated too.
  const t = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'purchase', { matchAddress: true });
  const refs = [
    ...listRows(t, 'userDataList').map(([, v]) => v),
    ...listRows(t, 'customDataList').map(([, v]) => v),
    paramVal(t, 'eventId') ?? '',
  ].filter((v) => v.startsWith('{{ed'));
  for (const r of refs) assert.ok(names.has(r.replace(/[{}]/g, '')), `${r} is created by buildTikTokEmqVariables`);
});

test('buildTikTokCapiServerTag: matchAddress appends the six address rows; absent without matchAddress, mapEventData=false, or explicit userData', () => {
  const addressRows: Array<[string, string]> = [
    ['first_name', '{{ed - address.first_name}}'],
    ['last_name', '{{ed - address.last_name}}'],
    ['city', '{{ed - address.city}}'],
    ['state', '{{ed - address.region}}'],
    ['country', '{{ed - address.country}}'],
    ['zip_code', '{{ed - address.postal_code}}'],
  ];
  const addressKeys = new Set(addressRows.map(([n]) => n));
  // matchAddress=true → the six address rows APPEND after email/phone/external_id/ip/user_agent.
  const on = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'purchase', { matchAddress: true });
  assert.deepEqual(listRows(on, 'userDataList'), [
    ['email', '{{ed - email_address}}'],
    ['phone', '{{ed - phone_number}}'],
    ['external_id', '{{ed - external_id}}'],
    ['ip', '{{ed - ip_override}}'],
    ['user_agent', '{{ed - user_agent}}'],
    ...addressRows,
  ]);
  // default (no matchAddress) → address rows absent.
  const off = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'purchase');
  assert.ok(!listRows(off, 'userDataList').some(([n]) => addressKeys.has(n)), 'no address rows without matchAddress');
  // mapEventData=false → no auto user_data at all, so no address rows even with matchAddress.
  const noMap = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'purchase', { matchAddress: true, mapEventData: false });
  assert.ok(!((noMap.parameter as Array<{ key?: string }>) ?? []).some((p) => p.key === 'userDataList'), 'no userDataList when mapEventData=false');
  // explicit userData → respected verbatim; matchAddress must NOT inject address rows.
  const explicit = buildTikTokCapiServerTag('cvt_TT01', 'x', 'P', 'T', 'purchase', {
    matchAddress: true,
    userData: [{ name: 'email', value: '{{My Email}}' }],
  });
  assert.deepEqual(listRows(explicit, 'userDataList'), [['email', '{{My Email}}']]);
});

test('buildMetaPixelTag: auto-fills Object Properties from dlv variables when omitted; explicit [] → none; explicit array → used', () => {
  const auto = buildMetaPixelTag('cvt_5RM3Q', 'Meta - Purchase', '123', 'Purchase', ['9']);
  const m = new Map(listRows(auto, 'objectPropertyList'));
  // Only value + currency are auto-filled (clean 1:1 dlv mapping); content_ids/contents need the items
  // array reshaped, so they are intentionally NOT auto-filled (a raw items array would be malformed).
  assert.equal(m.get('value'), '{{dlv - ecommerce.value}}');
  assert.equal(m.get('currency'), '{{dlv - ecommerce.currency}}');
  assert.equal(m.get('content_ids'), undefined, 'content_ids not auto-filled (needs reshape)');
  assert.equal(m.get('contents'), undefined, 'contents not auto-filled (needs reshape)');
  // Every referenced dlv variable is created by buildEcommerceDlvVariables.
  const dlvNames = new Set(buildEcommerceDlvVariables().map((v) => v.name));
  for (const { value } of metaWebObjectProps('Purchase')) assert.ok(value.startsWith('{{dlv') && dlvNames.has(value.replace(/[{}]/g, '')), `${value} created`);
  // explicit empty array → respected (no auto-fill)
  const none = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'Purchase', undefined, []);
  assert.equal(((none.parameter as Array<{ key?: string }>) ?? []).find((p) => p.key === 'objectPropertyList'), undefined);
  // explicit array → used verbatim
  const ex = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'Purchase', undefined, [{ name: 'value', value: '{{My V}}' }]);
  assert.deepEqual(listRows(ex, 'objectPropertyList'), [['value', '{{My V}}']]);
  // custom event → no recommended set → no auto-fill
  const custom = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'my_custom_event');
  assert.equal(((custom.parameter as Array<{ key?: string }>) ?? []).find((p) => p.key === 'objectPropertyList'), undefined);
});

test('buildGa4EventTag: defaults Send-Ecommerce ON for an ecommerce event with no params; OFF otherwise; explicit wins', () => {
  const purch = buildGa4EventTag({ name: 'GA4 - Purchase', measurementId: 'G-1', eventName: 'purchase' });
  assert.equal(paramVal(purch, 'sendEcommerceData'), 'true');
  assert.equal(paramVal(purch, 'getEcommerceDataFrom'), 'dataLayer');
  const login = buildGa4EventTag({ name: 'GA4 - Login', measurementId: 'G-1', eventName: 'login' });
  assert.equal(paramVal(login, 'sendEcommerceData'), 'false');
  // ecommerce event but caller passed explicit params → do NOT force the object
  const withParams = buildGa4EventTag({ name: 'GA4 - ATC', measurementId: 'G-1', eventName: 'add_to_cart', eventParameters: [{ name: 'x', value: 'y' }] });
  assert.equal(paramVal(withParams, 'sendEcommerceData'), 'false');
  // explicit false wins even for an ecommerce event
  const forcedOff = buildGa4EventTag({ name: 'GA4 - Purchase Off', measurementId: 'G-1', eventName: 'purchase', sendEcommerceData: false });
  assert.equal(paramVal(forcedOff, 'sendEcommerceData'), 'false');
  assert.ok(isGa4EcommerceEvent('add_to_cart') && !isGa4EcommerceEvent('login'));
});

test('buildGa4EventTag: auto-fills default event parameters (page_url/previous_page) when none passed; opt-out + explicit override', () => {
  const est = (t: { parameter?: unknown }): Array<[string, string]> => {
    const p = ((t.parameter as Array<{ key?: string; list?: Array<{ map: Array<{ key?: string; value?: string }> }> }>) ?? []).find((x) => x.key === 'eventSettingsTable');
    return (p?.list ?? []).map((r) => [r.map.find((m) => m.key === 'parameter')?.value ?? '', r.map.find((m) => m.key === 'parameterValue')?.value ?? '']);
  };
  // no params passed → default page params filled (bound to default-enabled built-ins)
  const auto = buildGa4EventTag({ name: 'GA4 - Login', measurementId: 'G-1', eventName: 'login' });
  assert.deepEqual(est(auto), [['page_url', '{{Page URL}}'], ['previous_page', '{{Referrer}}']]);
  // ecommerce event with no params → default params AND the ecommerce object coexist
  const purch = buildGa4EventTag({ name: 'GA4 - Purchase', measurementId: 'G-1', eventName: 'purchase' });
  assert.equal(paramVal(purch, 'sendEcommerceData'), 'true');
  assert.deepEqual(est(purch), [['page_url', '{{Page URL}}'], ['previous_page', '{{Referrer}}']]);
  // explicit params win (no auto-fill)
  const explicit = buildGa4EventTag({ name: 'x', measurementId: 'G-1', eventName: 'sign_up', eventParameters: [{ name: 'method', value: '{{Method}}' }] });
  assert.deepEqual(est(explicit), [['method', '{{Method}}']]);
  // opt-out → bare tag, no event parameters
  const bare = buildGa4EventTag({ name: 'x', measurementId: 'G-1', eventName: 'login', autoEventParameters: false });
  assert.equal(((bare.parameter as Array<{ key?: string }>) ?? []).some((p) => p.key === 'eventSettingsTable'), false);
});

test('buildLinkedInCapiServerTag: conversion tag (token + rule + automap on); eventId → eventData row; explicit rows + opt-outs', () => {
  const t = buildLinkedInCapiServerTag('cvt_LI01', 'LinkedIn CAPI', '{{LI Token}}', '{{LI Rule}}', { eventId: '{{Event ID}}', firingTriggerId: ['9'] });
  assert.equal(t.type, 'cvt_LI01');
  assert.equal(paramVal(t, 'type'), 'conversion');
  assert.equal(paramVal(t, 'accessToken'), '{{LI Token}}');
  assert.equal(paramVal(t, 'conversionRuleUrn'), '{{LI Rule}}');
  assert.equal(paramVal(t, 'autoMapUserIds'), 'true');
  assert.equal(paramVal(t, 'autoMapEventData'), 'true');
  assert.equal(paramVal(t, 'autoMapExternalIds'), 'false');
  assert.equal(paramVal(t, 'adStorageConsent'), 'optional');
  assert.deepEqual(listRows(t, 'eventData'), [['eventId', '{{Event ID}}']]);
  assert.deepEqual(t.firingTriggerId, ['9']);
  // explicit rows + opt-outs (autoMap off, consent required)
  const t2 = buildLinkedInCapiServerTag('cvt_LI01', 'x', 'T', 'R', {
    autoMap: false, requireConsent: true,
    userIds: [{ name: 'email', value: '{{Hashed Email}}' }],
    userInfo: [{ name: 'firstName', value: '{{First}}' }],
  });
  assert.equal(paramVal(t2, 'autoMapUserIds'), 'false');
  assert.equal(paramVal(t2, 'adStorageConsent'), 'required');
  assert.deepEqual(listRows(t2, 'userIds'), [['email', '{{Hashed Email}}']]);
  assert.deepEqual(listRows(t2, 'userInfo'), [['firstName', '{{First}}']]);
  // no SIMPLE_TABLE lists when there's nothing to add and no eventId
  const bare = buildLinkedInCapiServerTag('cvt_LI01', 'x', 'T', 'R');
  assert.ok(!((bare.parameter as Array<{ key?: string }>) ?? []).some((p) => ['eventData', 'userIds', 'userInfo'].includes(String(p.key))), 'no tables when empty');
});

test('buildVariable throws on an unknown kind (no silent empty Custom JS variable)', () => {
  assert.throws(() => buildVariable({ name: 'x', kind: 'cookie' as never }), /Unknown variable kind "cookie"/);
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
  // Search's only recommended property is the query (search_string); content_type is NOT a Search
  // parameter (it means product/product_group for catalog events) so it was removed to avoid emitting a
  // spurious content_type='product' on a search event.
  assert.deepEqual(TIKTOK_EVENT_PROPERTIES.Search, ['query']);
  // page_url / referrer are NOT properties — TikTok carries page context in a separate `page` object the
  // template auto-fills, so no event lists them (Pageview has no property row; ClickButton is button_name only).
  assert.equal(TIKTOK_EVENT_PROPERTIES.Pageview, undefined);
  assert.deepEqual(TIKTOK_EVENT_PROPERTIES.ClickButton, ['button_name']);
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

test('findDanglingVariableReferences: only truly-undefined {{refs}} flagged; built-ins / _internal / defined vars kept', () => {
  const snap = {
    tags: [
      {
        tagId: 't1', name: 'GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
        parameter: [
          { type: 'template', key: 'p1', value: '{{Page URL}}' },        // built-in → NOT dangling
          { type: 'template', key: 'p2', value: '{{Defined Var}}' },     // defined → NOT dangling
          { type: 'template', key: 'p3', value: '{{Ghost Var}}' },       // undefined → DANGLING
        ],
      },
    ],
    triggers: [
      {
        triggerId: 'T1', name: 'CE', type: 'customEvent',
        customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{_event}}' }, { type: 'template', key: 'arg1', value: 'x' }] }],
        filter: [{ type: 'contains', parameter: [{ type: 'template', key: 'arg0', value: '{{Also Missing}}' }] }], // undefined → DANGLING
      },
    ],
    variables: [
      { variableId: 'V1', name: 'Defined Var', type: 'c', parameter: [] },
      // A variable that references ITSELF plus a real missing var — self-ref must NOT be flagged.
      { variableId: 'V2', name: 'Self Ref', type: 'jsm', parameter: [{ type: 'template', key: 'javascript', value: 'return {{Self Ref}} + {{Nope}};' }] },
    ],
  };
  const dangling = findDanglingVariableReferences(snap);
  const byId = new Map(dangling.map((d) => [d.resource.id, d.missing.sort()]));
  assert.deepEqual(byId.get('t1'), ['Ghost Var'], 'tag: only Ghost Var (not Page URL / Defined Var)');
  assert.deepEqual(byId.get('T1'), ['Also Missing'], 'trigger: only Also Missing (not {{_event}} internal)');
  assert.deepEqual(byId.get('V2'), ['Nope'], 'variable: only Nope (self-reference {{Self Ref}} not flagged)');
  assert.equal(dangling.length, 3, 'exactly three resources have dangling refs');
});

test('BUILTIN_VARIABLE_NAMES covers the common enabled built-ins', () => {
  for (const n of ['Page URL', 'Click Text', 'Form Element', 'Error Message', 'Scroll Depth Threshold', 'Video Provider', 'New History Fragment', 'Percent Visible', 'Event']) {
    assert.ok(BUILTIN_VARIABLE_NAMES.has(n), `${n} is a recognised built-in`);
  }
  assert.ok(!BUILTIN_VARIABLE_NAMES.has('Not A Builtin'));
});

test('varParam reads a scalar param value; missing → empty string', () => {
  const v = { variableId: 'V', name: 'x', type: 'v', parameter: [{ type: 'template', key: 'name', value: 'ecommerce.value' }, { type: 'integer', key: 'dataLayerVersion', value: '2' }] };
  assert.equal(varParam(v, 'name'), 'ecommerce.value');
  assert.equal(varParam(v, 'dataLayerVersion'), '2');
  assert.equal(varParam(v, 'absent'), '');
});

test('inspectVariableConfig: broken DLV / URL-query / cookie / lookup flagged; well-formed ones are NOT', () => {
  const bad = {
    tags: [], triggers: [],
    variables: [
      { variableId: 'D1', name: 'DLV empty', type: 'v', parameter: [{ type: 'integer', key: 'dataLayerVersion', value: '2' }] }, // no 'name' key
      { variableId: 'U1', name: 'URL no key', type: 'u', parameter: [{ type: 'template', key: 'component', value: 'QUERY' }] },     // QUERY, no queryKey
      { variableId: 'K1', name: 'Cookie no name', type: 'k', parameter: [] },                                                       // no cookie name
      { variableId: 'L1', name: 'Empty lookup', type: 'smm', parameter: [{ type: 'list', key: 'map', list: [] }] },                 // no rows
      { variableId: 'R1', name: 'Empty regex', type: 'remm', parameter: [] },                                                       // no map at all
    ],
  };
  const badChecks = new Map(inspectVariableConfig(bad).map((c) => [c.variable.variableId, c.checkId]));
  assert.equal(badChecks.get('D1'), 'variable-config-dlv');
  assert.equal(badChecks.get('U1'), 'variable-config-url');
  assert.equal(badChecks.get('K1'), 'variable-config-cookie');
  assert.equal(badChecks.get('L1'), 'variable-config-lookup');
  assert.equal(badChecks.get('R1'), 'variable-config-lookup');
  assert.equal(badChecks.size, 5, 'all five broken variables flagged');

  const good = {
    tags: [], triggers: [],
    variables: [
      buildVariable({ name: 'DLV ok', kind: 'data_layer', dataLayerName: 'ecommerce.value' }),
      buildUrlQueryVariable('URL ok', 'q'),
      { variableId: 'K2', name: 'Cookie ok', type: 'k', parameter: [{ type: 'template', key: 'name', value: 'gclid' }] },
      buildLookupTableVariable('Lookup ok', '{{Page Path}}', [{ key: '/a', value: 'A' }]),
    ].map((v, i) => ({ variableId: `G${i}`, name: v.name, type: v.type, parameter: v.parameter ?? [] })),
  };
  assert.deepEqual(inspectVariableConfig(good), [], 'no well-formed variable is flagged');

  // A URL variable that is NOT a QUERY component (e.g. HOST) with no queryKey must NOT be flagged.
  const nonQuery = { tags: [], triggers: [], variables: [{ variableId: 'U2', name: 'URL host', type: 'u', parameter: [{ type: 'template', key: 'component', value: 'HOST' }] }] };
  assert.deepEqual(inspectVariableConfig(nonQuery), [], 'non-QUERY URL variable without queryKey is fine');
});

test('findVariableNamingIssues: placeholder + whitespace names flagged; clean names are NOT', () => {
  const snap = {
    tags: [
      { tagId: 'T1', name: 'Untitled Variable', type: 'html', firingTriggerId: [], paused: false, parameter: [] }, // placeholder
      { tagId: 'T2', name: 'GA4 - purchase', type: 'gaawe', firingTriggerId: [], paused: false, parameter: [] },   // clean
    ],
    triggers: [
      { triggerId: 'TR1', name: 'Copy of Click', type: 'linkClick' }, // placeholder
    ],
    variables: [
      { variableId: 'V1', name: 'Trailing space ', type: 'c', parameter: [] }, // whitespace
      { variableId: 'V2', name: 'Double  space', type: 'c', parameter: [] },   // whitespace (≥2 run)
      { variableId: 'V3', name: '', type: 'c', parameter: [] },                // empty → placeholder
      { variableId: 'V4', name: 'Clean Name', type: 'c', parameter: [] },      // clean
    ],
  };
  const issues = findVariableNamingIssues(snap);
  const byId = new Map(issues.map((i) => [i.resource.id, i.checkId]));
  assert.equal(byId.get('T1'), 'placeholder-name');
  assert.equal(byId.get('TR1'), 'placeholder-name');
  assert.equal(byId.get('V1'), 'name-whitespace');
  assert.equal(byId.get('V2'), 'name-whitespace');
  assert.equal(byId.get('V3'), 'placeholder-name');
  assert.equal(byId.has('T2'), false, 'clean tag name not flagged');
  assert.equal(byId.has('V4'), false, 'clean variable name not flagged');
  assert.equal(issues.length, 5);
});

test('auditContainer surfaces dangling-variable-ref + variable-config-* + placeholder-name findings', () => {
  const r = auditContainer({
    tags: [
      {
        tagId: 'TG', name: 'Untitled Tag', type: 'gaawe', firingTriggerId: ['T1'], paused: false,
        // valid mid + event so no ga4 findings; references a variable that does not exist
        parameter: [
          { type: 'template', key: 'measurementIdOverride', value: 'G-1' },
          { type: 'template', key: 'eventName', value: 'purchase' },
          { type: 'template', key: 'x', value: '{{Missing Thing}}' },
        ],
        consentSettings: { consentStatus: 'needed' },
      },
    ],
    triggers: [{ triggerId: 'T1', name: 'Used', type: 'pageview' }],
    variables: [
      // A broken Data Layer variable (no key) that IS referenced (so not flagged unused) — via the tag? No.
      // Reference it from another variable so it isn't reported unused, keeping the test focused.
      { variableId: 'V1', name: 'Broken DLV', type: 'v', parameter: [{ type: 'integer', key: 'dataLayerVersion', value: '2' }] },
      { variableId: 'V2', name: 'Refs DLV', type: 'jsm', parameter: [{ type: 'template', key: 'javascript', value: 'return {{Broken DLV}} + {{Missing Thing}};' }] },
    ],
  });
  const byCheck = (id: string) => r.findings.filter((f) => f.checkId === id);

  const dangling = byCheck('dangling-variable-ref');
  assert.ok(dangling.length >= 1, 'at least one dangling-variable-ref finding');
  assert.ok(dangling.every((f) => f.severity === 'medium' && f.confidence === 'likely' && f.category === 'variable' && f.autoFixable === false));
  assert.ok(dangling.some((f) => f.message.includes('{{Missing Thing}}')), 'names the missing variable');

  const dlv = byCheck('variable-config-dlv');
  assert.equal(dlv.length, 1, 'the empty-key Data Layer variable is flagged');
  assert.equal(dlv[0].severity, 'medium');
  assert.equal(dlv[0].confidence, 'certain');
  assert.equal(dlv[0].category, 'variable');
  assert.equal(dlv[0].resource?.id, 'V1');
  assert.equal(dlv[0].autoFixable, false);

  const placeholder = byCheck('placeholder-name');
  assert.ok(placeholder.some((f) => f.resource?.id === 'TG'), 'the "Untitled Tag" is flagged placeholder-name');
  assert.ok(placeholder.every((f) => f.severity === 'low' && f.category === 'naming'));

  // The confidence/type enrichment still runs: resource.type is present on the DLV finding.
  assert.equal(dlv[0].resource?.type, 'v');
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

console.log('\nServer reference architecture (FPID client / GTM serving client / page-scoped triggers):');

test('buildGa4Client: server-managed FPID cookies by DEFAULT (reference shape), plain client on opt-out', () => {
  const c = buildGa4Client('GA4');
  assert.equal(c.type, 'gaaw_client');
  const params = c.parameter as Array<Record<string, unknown>>;
  assert.equal(findParam(params, 'activateDefaultPaths')?.value, 'true');
  assert.equal(findParam(params, 'activateGtagSupport')?.value, 'true');
  // The FPID block — exact keys/values from the reference export (GTM-57RM3QCT).
  assert.equal(findParam(params, 'cookieManagement')?.value, 'server');
  assert.equal(findParam(params, 'cookieName')?.value, 'FPID');
  assert.equal(findParam(params, 'cookieDomain')?.value, 'auto');
  assert.equal(findParam(params, 'cookiePath')?.value, '/');
  assert.equal(findParam(params, 'cookieMaxAgeInSec')?.value, '63072000');
  assert.equal(findParam(params, 'migrateFromJsClientId')?.value, 'true');
  const plain = buildGa4Client('GA4', { serverManagedCookies: false });
  const plainParams = plain.parameter as Array<Record<string, unknown>>;
  assert.equal(findParam(plainParams, 'cookieManagement'), undefined, 'opt-out drops the whole FPID block');
  assert.equal(plainParams.length, 2, 'plain client keeps only the two activate flags');
});

test('buildGtmClient: first-party serving client locked to the web container ids', () => {
  const c = buildGtmClient('GTM Web Container', ['GTM-W7M2SN98', 'GTM-ABC1234']);
  assert.equal(c.type, 'gtm_client');
  const params = c.parameter as Array<Record<string, unknown>>;
  assert.equal(findParam(params, 'activateResponseCompression')?.value, 'true');
  assert.equal(findParam(params, 'activateDependencyServing')?.value, 'true');
  assert.equal(findParam(params, 'activateGeoResolution')?.value, 'false');
  const list = findParam(params, 'allowedContainerIds') as { list?: Array<{ map: Array<{ key: string; value: string }> }> };
  assert.equal(list?.list?.length, 2);
  assert.deepEqual(
    list.list!.map((m) => m.map.find((x) => x.key === 'containerId')?.value),
    ['GTM-W7M2SN98', 'GTM-ABC1234'],
    'LIST of {containerId} maps — the exact reference shape',
  );
});

test('buildServerEventTrigger pageUrlContains: campaign-scoped trigger (event + client + page URL)', () => {
  const t = buildServerEventTrigger('ACF - Sign Petition Click', 'Sign Petition Click', 'GA4', { pageUrlContains: '/petition/minister-for-children/' });
  const ce = (t.customEventFilter as Array<{ parameter: Array<{ key: string; value: string }> }>)[0];
  assert.equal(ce.parameter.find((p) => p.key === 'arg1')?.value, 'Sign Petition Click', 'event name stays EXACT (spaces, never URL-encoded)');
  const filters = t.filter as Array<{ type: string; parameter: Array<{ key: string; value: string }> }>;
  assert.equal(filters.length, 2);
  assert.deepEqual(filters.map((f) => f.type), ['equals', 'contains']);
  assert.equal(filters[0].parameter.find((p) => p.key === 'arg0')?.value, '{{Client Name}}');
  assert.equal(filters[1].parameter.find((p) => p.key === 'arg0')?.value, '{{ed - page_location}}', 'page filter reads the ed - page_location variable by default');
  assert.equal(filters[1].parameter.find((p) => p.key === 'arg1')?.value, '/petition/minister-for-children/');
  // Custom page variable override + no client scope.
  const t2 = buildServerEventTrigger('X', 'purchase', undefined, { pageUrlContains: '/shop/', pageUrlVariable: '{{Page URL Variable}}' });
  const f2 = t2.filter as Array<{ parameter: Array<{ key: string; value: string }> }>;
  assert.equal(f2.length, 1);
  assert.equal(f2[0].parameter.find((p) => p.key === 'arg0')?.value, '{{Page URL Variable}}');
});

test('buildServerAllEventsTrigger pageUrlContains: all-events relay scoped to a page section', () => {
  const t = buildServerAllEventsTrigger('Campaign - All Events', 'GA4', { pageUrlContains: '/petition/' });
  const filters = t.filter as Array<{ type: string; parameter: Array<{ key: string; value: string }> }>;
  assert.equal(filters.length, 2);
  assert.equal(filters[1].type, 'contains');
  assert.equal(filters[1].parameter.find((p) => p.key === 'arg1')?.value, '/petition/');
  // No page filter → unchanged single client filter (back-compat).
  const plain = buildServerAllEventsTrigger('All', 'GA4');
  assert.equal((plain.filter as unknown[]).length, 1);
});

console.log('\nOne-shot funnel + consent + verify:');

test('buildGa4EventTag sendEcommerceData: emits the flag + getEcommerceDataFrom dataLayer; absent otherwise', () => {
  const on = buildGa4EventTag({ name: 'GA4 - Event - Purchase Tag', measurementId: 'G-1', eventName: 'purchase', sendEcommerceData: true });
  const params = on.parameter as Array<Record<string, unknown>>;
  assert.equal(findParam(params, 'sendEcommerceData')?.value, 'true');
  assert.equal(findParam(params, 'sendEcommerceData')?.type, 'boolean');
  assert.equal(findParam(params, 'getEcommerceDataFrom')?.value, 'dataLayer');
  const off = buildGa4EventTag({ name: 'GA4 - Event - Login Tag', measurementId: 'G-1', eventName: 'login' });
  const offParams = off.parameter as Array<Record<string, unknown>>;
  // corpus-faithful: real GA4 event tags carry an explicit false (99% of 562)
  assert.equal(findParam(offParams, 'sendEcommerceData')?.value, 'false', 'explicit false unless requested');
  assert.equal(findParam(offParams, 'getEcommerceDataFrom'), undefined, 'source only present when forwarding');
});

test('buildEcommerceDlvVariables: one dlv per corpus ecommerce key', () => {
  const vars = buildEcommerceDlvVariables();
  assert.equal(vars.length, ECOMMERCE_DLV_KEYS.length);
  for (const [i, key] of ECOMMERCE_DLV_KEYS.entries()) {
    assert.equal(vars[i].name, `dlv - ${key}`);
    assert.equal(vars[i].type, 'v');
    const p = vars[i].parameter as Array<Record<string, unknown>>;
    assert.equal(findParam(p, 'name')?.value, key);
  }
});

test('buildConsentModeDefaultTag: denied-by-default Custom HTML on the Consent Initialization trigger', () => {
  const t = buildConsentModeDefaultTag('Consent Mode - Defaults');
  assert.equal(t.type, 'html');
  assert.deepEqual(t.firingTriggerId, [CONSENT_INIT_TRIGGER_ID]);
  const html = String(findParam(t.parameter as Array<Record<string, unknown>>, 'html')?.value ?? '');
  assert.ok(html.includes("gtag('consent', 'default'"), 'is a consent default call');
  for (const signal of ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization']) {
    assert.ok(html.includes(`${signal}: 'denied'`), `${signal} denied by default`);
  }
  assert.ok(html.includes("functionality_storage: 'granted'"), 'functionality granted by default');
  assert.ok(html.includes("security_storage: 'granted'"), 'security granted by default');
  assert.ok(html.includes('wait_for_update: 500'), 'waits for the CMP update');
  assert.equal(findParam(t.parameter as Array<Record<string, unknown>>, 'supportDocumentWrite')?.value, 'false');
});

test('buildConsentModeDefaultTag: per-signal overrides + waitForUpdate', () => {
  const t = buildConsentModeDefaultTag('Consent', { analytics_storage: 'granted', functionality_storage: 'denied', waitForUpdate: 2000 });
  const html = String(findParam(t.parameter as Array<Record<string, unknown>>, 'html')?.value ?? '');
  assert.ok(html.includes("analytics_storage: 'granted'"));
  assert.ok(html.includes("ad_storage: 'denied'"), 'unspecified ad signal stays denied');
  assert.ok(html.includes("functionality_storage: 'denied'"));
  assert.ok(html.includes('wait_for_update: 2000'));
});

// --- evaluateTrackingSetup ---------------------------------------------------

const fullWebTags = (): Array<Record<string, unknown>> => [
  { name: 'Google Tag', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [
    { type: 'template', key: 'tagId', value: 'G-1' },
    { type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [
      { type: 'template', key: 'parameter', value: 'server_container_url' },
      { type: 'template', key: 'parameterValue', value: 'https://sgtm.example.com' },
    ] }] },
  ] },
  { name: 'Consent Mode - Defaults', type: 'html', firingTriggerId: [CONSENT_INIT_TRIGGER_ID], parameter: [] },
  ...GA4_ECOMMERCE_FUNNEL_EVENTS.map((ev) => ({
    name: `GA4 - Event - ${ev} Tag`, type: 'gaawe', firingTriggerId: ['10'],
    parameter: [
      { type: 'template', key: 'eventName', value: ev },
      { type: 'boolean', key: 'sendEcommerceData', value: 'true' },
    ],
  })),
];
const fullServer = () => ({
  tags: [{ name: 'GA4 - Server', type: 'sgtmgaaw', firingTriggerId: ['5'], parameter: [{ type: 'template', key: 'measurementId', value: 'G-1' }] }],
  clients: [{ name: 'GA4', type: 'gaaw_client' }],
  taggingServerUrls: ['https://sgtm.example.com'],
});

test('evaluateTrackingSetup: a complete web+server install passes every check', () => {
  const r = evaluateTrackingSetup(fullWebTags(), [...GA4_ECOMMERCE_FUNNEL_EVENTS], fullServer());
  assert.equal(r.failures, 0, JSON.stringify(r.checks.filter((c) => c.status === 'fail')));
  assert.equal(r.warnings, 0, JSON.stringify(r.checks.filter((c) => c.status === 'warn')));
  assert.equal(r.ok, true);
  // 3 web-level + 7 web events + 7 schema (one per funnel event) + client + url + 7 server events
  assert.equal(r.checks.length, 3 + 7 + 7 + 2 + 7);
  // Every funnel event forwards the ecommerce object → its schema check passes with a DebugView note.
  const schema = r.checks.filter((c) => c.id.startsWith('schema_') && !c.id.endsWith('_name'));
  assert.equal(schema.length, 7);
  assert.ok(schema.every((c) => c.status === 'pass' && c.detail.includes('ecommerce object')), 'schema checks pass for sendEcommerceData funnel tags');
  const serverEvents = r.checks.filter((c) => c.id.startsWith('server_event_'));
  assert.ok(serverEvents.every((c) => c.status === 'pass' && c.detail.includes('base GA4 server tag')), 'base relay covers every event');
});

test('evaluateTrackingSetup: missing Google tag + missing event tags fail; consent missing warns', () => {
  const r = evaluateTrackingSetup([], ['purchase']);
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.id === 'web_google_tag')?.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'web_event_purchase')?.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'web_consent_defaults')?.status, 'warn');
  assert.equal(r.checks.find((c) => c.id === 'web_server_url')?.status, 'skip', 'no server side in this check → skip, not fail');
});

test('evaluateTrackingSetup: paused / trigger-less / ecommerce-off tags warn, not pass', () => {
  const tags: Array<Record<string, unknown>> = [
    { name: 'P', type: 'gaawe', paused: true, firingTriggerId: ['1'], parameter: [{ key: 'eventName', value: 'purchase' }, { key: 'sendEcommerceData', value: 'true' }] },
    { name: 'NT', type: 'gaawe', firingTriggerId: [], parameter: [{ key: 'eventName', value: 'add_to_cart' }, { key: 'sendEcommerceData', value: 'true' }] },
    { name: 'NE', type: 'gaawe', firingTriggerId: ['1'], parameter: [{ key: 'eventName', value: 'view_item' }] },
    { name: 'Lead', type: 'gaawe', firingTriggerId: ['1'], parameter: [{ key: 'eventName', value: 'generate_lead' }] },
  ];
  const r = evaluateTrackingSetup(tags, ['purchase', 'add_to_cart', 'view_item', 'generate_lead']);
  assert.equal(r.checks.find((c) => c.id === 'web_event_purchase')?.status, 'warn');
  assert.ok(r.checks.find((c) => c.id === 'web_event_purchase')?.detail.includes('PAUSED'));
  assert.equal(r.checks.find((c) => c.id === 'web_event_add_to_cart')?.status, 'warn');
  assert.ok(r.checks.find((c) => c.id === 'web_event_add_to_cart')?.detail.includes('NO firing trigger'));
  assert.equal(r.checks.find((c) => c.id === 'web_event_view_item')?.status, 'warn', 'funnel event without Send Ecommerce data warns');
  assert.equal(r.checks.find((c) => c.id === 'web_event_generate_lead')?.status, 'pass', 'non-ecommerce event needs no ecommerce flag');
});

test('evaluateTrackingSetup: contract schema check — ecommerce-object note vs missing required param', () => {
  const tags: Array<Record<string, unknown>> = [
    { name: 'Google Tag', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'tagId', value: 'G-1' }] },
    // purchase forwards the whole ecommerce object → schema PASSES with a "site must push …" DebugView note.
    { name: 'Purchase', type: 'gaawe', firingTriggerId: ['1'], parameter: [{ key: 'eventName', value: 'purchase' }, { key: 'sendEcommerceData', value: 'true' }] },
    // search maps only page_path → missing the required search_term → schema WARNS.
    { name: 'Search', type: 'gaawe', firingTriggerId: ['1'], parameter: [
      { key: 'eventName', value: 'search' },
      { type: 'list', key: 'eventSettingsTable', list: [{ type: 'map', map: [{ key: 'parameter', value: 'page_path' }, { key: 'parameterValue', value: '{{Page Path}}' }] }] },
    ] },
  ];
  const r = evaluateTrackingSetup(tags, ['purchase', 'search']);
  const sp = r.checks.find((c) => c.id === 'schema_purchase');
  assert.equal(sp?.status, 'pass');
  assert.ok(sp?.detail.includes('transaction_id') && sp?.detail.includes('DebugView'), 'purchase names the required dataLayer params for runtime verify');
  const ss = r.checks.find((c) => c.id === 'schema_search');
  assert.equal(ss?.status, 'warn');
  assert.ok(ss?.detail.includes('search_term'), 'search flags the missing required parameter');
});

test('evaluateTrackingSetup: taxonomy flags a reserved event name (GA4 will reject it)', () => {
  const tags: Array<Record<string, unknown>> = [
    { name: 'Bad', type: 'gaawe', firingTriggerId: ['1'], parameter: [{ key: 'eventName', value: 'google_bad' }] },
  ];
  const r = evaluateTrackingSetup(tags, ['google_bad']);
  const nameCheck = r.checks.find((c) => c.id === 'schema_google_bad_name');
  assert.equal(nameCheck?.status, 'fail');
  assert.ok(nameCheck?.detail.includes('reserved'));
});

test('evaluateTrackingSetup: server side — missing client/url/relay fail; web not pointed at server fails', () => {
  const web = fullWebTags();
  // strip the server_container_url row off the Google tag
  (web[0].parameter as Array<Record<string, unknown>>).splice(1, 1);
  const r = evaluateTrackingSetup(web, ['purchase'], { tags: [], clients: [], taggingServerUrls: [] });
  assert.equal(r.checks.find((c) => c.id === 'web_server_url')?.status, 'fail', 'server given but web not linked → fail');
  assert.equal(r.checks.find((c) => c.id === 'server_client')?.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'server_tagging_url')?.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'server_event_purchase')?.status, 'fail');
  assert.equal(r.ok, false);
});

test('evaluateTrackingSetup: per-event server relay beats the base relay in the detail; paused base relay does not count', () => {
  const server = {
    tags: [
      { name: 'GA4 - Purchase Tag (Server)', type: 'sgtmgaaw', firingTriggerId: ['7'], parameter: [{ key: 'measurementId', value: 'G-1' }, { key: 'eventName', value: 'purchase' }] },
      { name: 'GA4 - Server', type: 'sgtmgaaw', paused: true, firingTriggerId: ['5'], parameter: [{ key: 'measurementId', value: 'G-1' }] },
    ],
    clients: [{ name: 'GA4', type: 'gaaw_client' }],
    taggingServerUrls: ['https://sgtm.example.com'],
  };
  const r = evaluateTrackingSetup(fullWebTags(), ['purchase', 'view_item'], server);
  const purchase = r.checks.find((c) => c.id === 'server_event_purchase');
  assert.equal(purchase?.status, 'pass');
  assert.ok(purchase?.detail.includes('GA4 - Purchase Tag (Server)'));
  assert.equal(r.checks.find((c) => c.id === 'server_event_view_item')?.status, 'fail', 'paused base relay is NOT coverage');
});

/* ───────────── Marketing-tag USER IDENTITY (advanced matching) ───────────── */

// Shared param/list extractors (mirror the ones above, scoped for these tests).
const pval = (tag: { parameter?: unknown }, key: string): string | undefined =>
  ((tag.parameter as Array<{ key?: string; value?: string }>) ?? []).find((x) => x.key === key)?.value;
const lrows = (tag: { parameter?: unknown }, key: string): Array<[string, string]> => {
  const p = ((tag.parameter as Array<{ key?: string; list?: Array<{ map: Array<{ key?: string; value?: string }> }> }>) ?? [])
    .find((x) => x.key === key);
  return (p?.list ?? []).map((r) => [r.map.find((m) => m.key === 'name')?.value ?? '', r.map.find((m) => m.key === 'value')?.value ?? '']);
};

test('buildMetaCapiServerTag: explicit userData ADDS to the auto-map; caller row wins a collision; canonicalized', () => {
  const t = buildMetaCapiServerTag('cvt_5TP8W', 'x', 'P', 'T', 'Purchase', {
    userData: [
      { name: 'fbc', value: '{{fbc}}' },
      { name: 'EM', value: '{{My Email}}' }, // collides with the auto em row → caller wins, key lowercased
      { name: '', value: 'dropped' },        // blank name dropped
    ],
    userDataObject: '{{User Data Object}}',
  });
  const ud = new Map(lrows(t, 'userDataList'));
  assert.equal(ud.get('em'), '{{My Email}}', 'caller em overrides the auto {{ed - email_address}}');
  assert.equal(ud.get('ph'), '{{ed - phone_number}}', 'auto ph kept');
  assert.equal(ud.get('external_id'), '{{ed - external_id}}', 'auto external_id kept');
  assert.equal(ud.get('fbc'), '{{fbc}}', 'new advanced-matching key appended');
  assert.ok(!ud.has(''), 'blank-name row dropped');
  assert.equal(pval(t, 'userDataObject'), '{{User Data Object}}');
});

test('buildMetaCapiServerTag: userData ships even with mapEmqVariables=false (identity is not gated by the ecommerce toggle)', () => {
  const t = buildMetaCapiServerTag('cvt_5TP8W', 'x', 'P', 'T', 'Purchase', {
    mapEmqVariables: false,
    userData: [{ name: 'em', value: '{{My Email}}' }],
  });
  assert.deepEqual(lrows(t, 'userDataList'), [['em', '{{My Email}}']], 'only the explicit row, no auto-map');
  // ecommerce/event_id lists stay OFF under mapEmqVariables=false.
  assert.ok(!((t.parameter as Array<{ key?: string }>) ?? []).some((p) => ['customDataList', 'serverEventDataList'].includes(String(p.key))));
});

test('buildMetaPixelTag: advancedMatching → advancedMatching=true + advancedMatchingList of {name,value}; key canonicalized; omitted → absent', () => {
  const t = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'Purchase', ['9'], [], [
    { name: 'EM', value: '{{Hashed Email}}' },
    { name: 'fn', value: '{{First Name}}' },
    { name: '', value: 'dropped' },
  ]);
  assert.equal(pval(t, 'advancedMatching'), 'true', 'advanced matching toggled on');
  assert.deepEqual(lrows(t, 'advancedMatchingList'), [['em', '{{Hashed Email}}'], ['fn', '{{First Name}}']]);
  // The web Pixel SELECT uses the SHORT `cn` for country (CAPI uses long `country`); the builder aliases it.
  const withCountry = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'Purchase', undefined, [], [
    { name: 'country', value: '{{Country}}' },
    { name: 'cn', value: '{{Country 2}}' },
  ]);
  assert.deepEqual(lrows(withCountry, 'advancedMatchingList'), [['cn', '{{Country}}'], ['cn', '{{Country 2}}']], 'country → cn alias; cn passes through');
  const none = buildMetaPixelTag('cvt_5RM3Q', 'x', '123', 'Purchase', undefined, []);
  assert.equal(pval(none, 'advancedMatching'), undefined, 'no advancedMatching param when none passed');
  assert.ok(!((none.parameter as Array<{ key?: string }>) ?? []).some((p) => p.key === 'advancedMatchingList'));
});

test('buildHotjarTag: base snippet only; identify appended with userId + attributes; values quoted', () => {
  const base = buildHotjarTag('Hotjar', '{{Hotjar Site ID}}', { firingTriggerId: ['5'] });
  assert.equal(base.type, 'html');
  assert.deepEqual(base.firingTriggerId, ['5']);
  const html0 = pval(base, 'html') ?? '';
  assert.ok(html0.includes('h._hjSettings={hjid:{{Hotjar Site ID}},hjsv:6}'), 'hjid substituted raw (variable)');
  assert.ok(!html0.includes("hj('identify'"), 'no identify without userId/attributes');
  assert.ok(((base.parameter as Array<{ key?: string; value?: string }>) ?? []).some((p) => p.key === 'supportDocumentWrite' && p.value === 'false'));

  const id = buildHotjarTag('Hotjar', '3476610', { userId: '{{User ID}}', userAttributes: [{ name: 'email', value: '{{User Email}}' }, { name: '', value: 'x' }] });
  const html1 = pval(id, 'html') ?? '';
  assert.ok(html1.includes('h._hjSettings={hjid:3476610,hjsv:6}'), 'numeric site id inlined');
  assert.ok(html1.includes(`hj('identify', "{{User ID}}", {"email": "{{User Email}}"});`), 'identify with quoted userId + attribute; blank dropped');
});

test('pinterestEvent + buildPinterestTag: standard/GA4 mapping, ADE custom fallback, Enhanced Match em', () => {
  assert.equal(pinterestEvent('purchase'), 'checkout');
  assert.equal(pinterestEvent('view_item'), 'viewcontent');
  assert.equal(pinterestEvent('addtocart'), 'addtocart');
  assert.equal(pinterestEvent('Newsletter Signup Custom'), null);
  const t = buildPinterestTag('cvt_PIN', 'Pinterest - Purchase Tag', '{{Pinterest Tag ID}}', 'purchase', ['9'], { em: '{{Hashed Email}}' });
  assert.equal(pval(t, 'tagId'), '{{Pinterest Tag ID}}');
  assert.equal(pval(t, 'eventName'), 'checkout');
  assert.equal(pval(t, 'em'), '{{Hashed Email}}');
  assert.deepEqual(t.firingTriggerId, ['9']);
  const custom = buildPinterestTag('cvt_PIN', 'x', '123', 'my_custom_thing');
  assert.equal(pval(custom, 'eventName'), 'ADE');
  assert.equal(pval(custom, 'adeEventName'), 'my_custom_thing');
  assert.equal(pval(custom, 'em'), undefined, 'no em when none passed');
});

test('pinterestServerEvent + buildPinterestCapiServerTag: inherit by default, forced/custom event, override tables, testMode', () => {
  assert.equal(pinterestServerEvent('purchase'), 'checkout');
  assert.equal(pinterestServerEvent('view_item'), 'view_content');
  assert.equal(pinterestServerEvent('add_to_cart'), 'add_to_cart');
  assert.equal(pinterestServerEvent('page_view'), 'page_visit');
  assert.equal(pinterestServerEvent('custom'), 'custom'); // 'custom' is a real template SELECT value (≠ custom_event)
  assert.equal(pinterestServerEvent('some_custom'), null);
  // Default: inherit the event + overrideMode OFF (auto getAllEventData) — a complete relay from id+token.
  const t = buildPinterestCapiServerTag('cvt_PINS', 'Pinterest CAPI', '{{Adv ID}}', '{{Pin Token}}', { firingTriggerId: ['9'] });
  assert.equal(t.type, 'cvt_PINS');
  assert.equal(pval(t, 'advertiserId'), '{{Adv ID}}');
  assert.equal(pval(t, 'apiAccessToken'), '{{Pin Token}}');
  assert.equal(pval(t, 'eventName'), 'inherit');
  assert.equal(pval(t, 'overrideMode'), 'false');
  assert.equal(pval(t, 'testMode'), 'false');
  assert.equal(pval(t, 'logMode'), 'donotlog');
  assert.deepEqual(t.firingTriggerId, ['9']);
  // Forced standard event → pinterestEventName + eventNameStandard.
  const purch = buildPinterestCapiServerTag('cvt_PINS', 'x', 'A', 'T', { event: 'purchase' });
  assert.equal(pval(purch, 'eventName'), 'pinterestEventName');
  assert.equal(pval(purch, 'eventNameStandard'), 'checkout');
  // Custom (non-standard) event → custom_event + adeEventName.
  const cust = buildPinterestCapiServerTag('cvt_PINS', 'x', 'A', 'T', { event: 'my_thing' });
  assert.equal(pval(cust, 'eventNameStandard'), 'custom_event');
  assert.equal(pval(cust, 'adeEventName'), 'my_thing');
  // Override rows → overrideMode ON + the table; testMode ON.
  const ov = buildPinterestCapiServerTag('cvt_PINS', 'x', 'A', 'T', { testMode: true, override: { customData: [{ name: 'value', value: '{{V}}' }] } });
  assert.equal(pval(ov, 'overrideMode'), 'true');
  assert.equal(pval(ov, 'testMode'), 'true');
  const cd = ((ov.parameter as Array<{ key?: string; list?: Array<{ map: Array<{ key?: string; value?: string }> }> }>) ?? []).find((p) => p.key === 'customDataList');
  assert.deepEqual((cd?.list ?? []).map((r) => [r.map.find((m) => m.key === 'name')?.value, r.map.find((m) => m.key === 'value')?.value]), [['value', '{{V}}']]);
});

test('buildPinterestCapiServerTag: override rows are canonicalized to Pinterest keys and blank-value rows are dropped', () => {
  const t = buildPinterestCapiServerTag('cvt_PINS', 'x', 'A', 'T', {
    override: {
      userData: [
        { name: 'email', value: '{{Email}}' },     // alias → em
        { name: 'Phone', value: '{{Phone}}' },      // alias + casing → ph
        { name: 'zip_code', value: '{{Zip}}' },     // alias → zp
        { name: 'external_id', value: '   ' },       // blank value → dropped (erase-safety)
      ],
      customData: [
        { name: 'transaction_id', value: '{{Txn}}' }, // alias → order_id
        { name: 'value', value: '{{V}}' },            // already canonical
        { name: 'my_custom', value: '{{C}}' },        // off-list → passed through verbatim
      ],
    },
  });
  // aliases corrected; the blank-value external_id row is not emitted.
  assert.deepEqual(listRows(t, 'userDataList'), [['em', '{{Email}}'], ['ph', '{{Phone}}'], ['zp', '{{Zip}}']]);
  assert.deepEqual(listRows(t, 'customDataList'), [['order_id', '{{Txn}}'], ['value', '{{V}}'], ['my_custom', '{{C}}']]);
  assert.equal(paramVal(t, 'overrideMode'), 'true');
  // A table of ONLY blank-value rows contributes nothing and leaves overrideMode off.
  const blank = buildPinterestCapiServerTag('cvt_PINS', 'x', 'A', 'T', { override: { userData: [{ name: 'em', value: '' }] } });
  assert.equal(paramVal(blank, 'overrideMode'), 'false');
  assert.ok(!((blank.parameter as Array<{ key?: string }>) ?? []).some((p) => p.key === 'userDataList'));
});

test('buildStackAdaptServerTag: id-only pixel (pixelID/pixelType), action row, property tables; bad type → conv', () => {
  const t = buildStackAdaptServerTag('cvt_SA01', 'StackAdapt - Purchase', '{{SA Pixel}}', 'conv', {
    action: 'purchase',
    commonProperties: [{ name: 'revenue', value: '{{Value}}' }, { name: 'blank', value: '   ' }],
    customProperties: [{ name: 'campaign', value: '{{Campaign}}' }],
    firingTriggerId: ['5'],
  });
  assert.equal(t.type, 'cvt_SA01');
  assert.equal(paramVal(t, 'pixelID'), '{{SA Pixel}}');
  assert.equal(paramVal(t, 'pixelType'), 'conv');
  // action lands as a commonProperties row; the blank-value row is dropped.
  assert.deepEqual(listRows(t, 'commonProperties'), [['revenue', '{{Value}}'], ['action', 'purchase']]);
  assert.deepEqual(listRows(t, 'customProperties'), [['campaign', '{{Campaign}}']]);
  assert.deepEqual(t.firingTriggerId, ['5']);
  // This template has NO access token / event_id / eventName field — never emit one.
  for (const k of ['accessToken', 'apiAccessToken', 'event_id', 'eventName', 'serverEventDataList']) {
    assert.ok(!((t.parameter as Array<{ key?: string }>) ?? []).some((p) => p.key === k), `${k} must not be emitted`);
  }
  // an unknown pixelType falls back to 'conv'; an explicit action row is NOT duplicated by opts.action.
  const t2 = buildStackAdaptServerTag('cvt_SA01', 'x', 'P', 'bogus', { action: 'lead', commonProperties: [{ name: 'action', value: 'signup' }] });
  assert.equal(paramVal(t2, 'pixelType'), 'conv');
  assert.deepEqual(listRows(t2, 'commonProperties'), [['action', 'signup']]);
});

test('redditServerEvent + buildRedditCapiServerTag: inherit default, standard/custom event, automap, eventId → conversion_id', () => {
  assert.equal(redditServerEvent('purchase'), 'PURCHASE');
  assert.equal(redditServerEvent('add_to_cart'), 'ADD_TO_CART');
  assert.equal(redditServerEvent('PAGE_VISIT'), 'PAGE_VISIT'); // exact SELECT value passes
  assert.equal(redditServerEvent('view_item'), 'VIEW_CONTENT'); // GA4 alias
  assert.equal(redditServerEvent('totally_custom'), null);

  const t = buildRedditCapiServerTag('cvt_RD01', 'Reddit CAPI', '{{Reddit Pixel}}', '{{Reddit Token}}', { eventId: '{{Event ID}}', firingTriggerId: ['7'] });
  assert.equal(t.type, 'cvt_RD01');
  assert.equal(paramVal(t, 'eventType'), 'inherit');
  assert.equal(paramVal(t, 'accountId'), '{{Reddit Pixel}}'); // pixel id lives in the template's accountId field
  assert.equal(paramVal(t, 'accessToken'), '{{Reddit Token}}');
  assert.equal(paramVal(t, 'actionSource'), 'WEBSITE');
  assert.equal(paramVal(t, 'autoMapCommonEventData'), 'true');
  assert.equal(paramVal(t, 'autoMapServerEventData'), 'true');
  assert.equal(paramVal(t, 'autoMapUserData'), 'true');
  assert.equal(paramVal(t, 'useOptimisticScenario'), 'false');
  assert.equal(paramVal(t, 'adStorageConsent'), 'optional');
  assert.deepEqual(listRows(t, 'serverEventDataList'), [['conversion_id', '{{Event ID}}']]); // dedup row
  assert.deepEqual(t.firingTriggerId, ['7']);

  const t2 = buildRedditCapiServerTag('cvt_RD01', 'x', 'P', 'T', {
    event: 'purchase', autoMap: false, requireConsent: true, optimistic: true,
    testId: '{{Test}}', clickId: '{{rdt_cid}}',
    serverEventData: [{ name: 'value', value: '{{V}}' }, { name: 'blank', value: '   ' }],
    userData: [{ name: 'email', value: '{{Email}}' }],
  });
  assert.equal(paramVal(t2, 'eventType'), 'standard');
  assert.equal(paramVal(t2, 'eventName'), 'PURCHASE');
  assert.equal(paramVal(t2, 'autoMapServerEventData'), 'false');
  assert.equal(paramVal(t2, 'useOptimisticScenario'), 'true');
  assert.equal(paramVal(t2, 'adStorageConsent'), 'required');
  assert.equal(paramVal(t2, 'testId'), '{{Test}}');
  assert.equal(paramVal(t2, 'clickId'), '{{rdt_cid}}');
  assert.deepEqual(listRows(t2, 'serverEventDataList'), [['value', '{{V}}']]); // blank dropped, no eventId passed
  assert.deepEqual(listRows(t2, 'userDataList'), [['email', '{{Email}}']]);

  const t3 = buildRedditCapiServerTag('cvt_RD01', 'x', 'P', 'T', { event: 'my_custom_event' });
  assert.equal(paramVal(t3, 'eventType'), 'custom');
  assert.equal(paramVal(t3, 'eventNameCustom'), 'my_custom_event');
  assert.equal(paramVal(t3, 'eventName'), undefined);
});

test('amazonServerEvent + buildAmazonCapiServerTag: tagIdsList value column, region, event map, eventId → clientDedupeId', () => {
  assert.equal(amazonServerEvent('purchase'), 'Off-AmazonPurchases');
  assert.equal(amazonServerEvent('add_to_cart'), 'AddToShoppingCart');
  assert.equal(amazonServerEvent('Off-AmazonPurchases'), 'Off-AmazonPurchases'); // exact value passes
  assert.equal(amazonServerEvent('page_view'), 'PageView');
  assert.equal(amazonServerEvent('nope'), null);

  const t = buildAmazonCapiServerTag('cvt_AZ01', 'Amazon CAPI', ['2a2b1197-3668-0000', '   ', 'ffff-1111'], 'EU', {
    eventId: '{{Event ID}}', matchId: '{{User}}', enableAdvancedMatching: true,
    userData: [{ name: 'email', value: '{{Email}}' }],
    defaultAttributes: [{ name: 'value', value: '{{V}}' }],
    firingTriggerId: ['3'],
  });
  assert.equal(t.type, 'cvt_AZ01');
  assert.equal(paramVal(t, 'tagRegion'), 'EU');
  assert.equal(paramVal(t, 'eventType'), 'inherit');
  // tagIdsList uses a SINGLE 'value' column (not name/value); the blank id is dropped.
  const idRows = ((t.parameter as Array<{ key?: string; list?: Array<{ map: Array<{ key?: string; value?: string }> }> }>) ?? [])
    .find((x) => x.key === 'tagIdsList')?.list?.map((r) => r.map.find((m) => m.key === 'value')?.value);
  assert.deepEqual(idRows, ['2a2b1197-3668-0000', 'ffff-1111']);
  assert.equal(paramVal(t, 'matchId'), '{{User}}');
  assert.equal(paramVal(t, 'enableAdvancedMatching'), 'true');
  assert.deepEqual(listRows(t, 'userDataAttributesList'), [['email', '{{Email}}']]);
  // eventId → clientDedupeId row appended to defaultAttributesList (after the explicit value row).
  assert.deepEqual(listRows(t, 'defaultAttributesList'), [['value', '{{V}}'], ['clientDedupeId', '{{Event ID}}']]);
  assert.deepEqual(t.firingTriggerId, ['3']);

  // advanced matching OFF → userDataAttributesList not emitted even if userData passed; unknown region → NA; custom event.
  const t2 = buildAmazonCapiServerTag('cvt_AZ01', 'x', ['id1'], 'XX', { event: 'my_evt', userData: [{ name: 'email', value: '{{E}}' }] });
  assert.equal(paramVal(t2, 'tagRegion'), 'NA');
  assert.equal(paramVal(t2, 'eventType'), 'custom');
  assert.equal(paramVal(t2, 'eventNameCustom'), 'my_evt');
  assert.equal(paramVal(t2, 'enableAdvancedMatching'), 'false');
  assert.ok(!((t2.parameter as Array<{ key?: string }>) ?? []).some((p) => p.key === 'userDataAttributesList'), 'no user data when advanced matching off');
});

test('snapEventType + buildSnapPixelTag: event mapping + flat advanced-matching fields; unknown → PAGE_VIEW', () => {
  assert.equal(snapEventType('purchase'), 'PURCHASE');
  assert.equal(snapEventType('add_to_cart'), 'ADD_CART');
  assert.equal(snapEventType('VIEW_CONTENT'), 'VIEW_CONTENT'); // exact SELECT value passes through
  assert.equal(snapEventType('something_unmapped'), 'PAGE_VIEW');
  const t = buildSnapPixelTag('cvt_SNAP', 'Snap - Purchase Tag', '{{Snap Pixel ID}}', 'purchase', ['9'], {
    user_email: '{{User Email}}',
    user_hashed_phone_number: '{{Hashed Phone}}',
    bogus_key: 'ignored', // not a Snap AM field → not emitted
  });
  assert.equal(pval(t, 'pixel_id'), '{{Snap Pixel ID}}');
  assert.equal(pval(t, 'event_type'), 'PURCHASE');
  assert.equal(pval(t, 'user_email'), '{{User Email}}');
  assert.equal(pval(t, 'user_hashed_phone_number'), '{{Hashed Phone}}');
  assert.equal(pval(t, 'bogus_key'), undefined, 'non-AM key not emitted');
  assert.equal(pval(t, 'user_phone_number'), undefined, 'unset AM field absent');
  assert.deepEqual(t.firingTriggerId, ['9']);
});

// ── planTriggerRetarget: decide rewrite-in-place vs rebind (shared trigger) ──────────────────────
{
  const snap = (): { tags: unknown[]; triggers: unknown[]; variables: unknown[] } => ({
    tags: [
      { tagId: 'tA', name: 'CTA Tag', type: 'gaawe', firingTriggerId: ['t1'], paused: false, parameter: [] },
      { tagId: 'tB', name: 'Shared Tag', type: 'gaawe', firingTriggerId: ['tShared'], paused: false, parameter: [] },
      { tagId: 'tC', name: 'Other', type: 'gaawe', firingTriggerId: ['tShared'], paused: false, parameter: [] },
    ],
    triggers: [
      { triggerId: 't1', name: 'CTA click', type: 'linkClick' },
      { triggerId: 'tShared', name: 'Any click', type: 'click' },
    ],
    variables: [],
  });
  const corrected = { name: 'CTA click', kind: 'link_click' as const, clickTextValue: 'Book a Call', clickTextOperator: 'contains' };

  test('planTriggerRetarget: sole-owner trigger → rewrite in place', () => {
    const p = planTriggerRetarget(snap() as never, 'CTA Tag', corrected);
    assert.equal(p.mode, 'rewrite');
    assert.equal(p.tagId, 'tA');
    assert.equal(p.triggerId, 't1');
    assert.equal(p.sharedBy, 1);
    assert.equal(p.built.type, 'linkClick', 'built the corrected GTM trigger');
  });

  test('planTriggerRetarget: shared trigger → rebind (never mutate siblings)', () => {
    const p = planTriggerRetarget(snap() as never, 'Shared Tag', { name: 'Any click', kind: 'all_clicks', clickTextValue: 'Buy', clickTextOperator: 'equals' });
    assert.equal(p.mode, 'rebind');
    assert.equal(p.sharedBy, 2, 'tShared fires two tags');
    assert.equal(p.triggerId, 'tShared');
  });

  test('planTriggerRetarget: unknown tag / no firing trigger → throws', () => {
    assert.throws(() => planTriggerRetarget(snap() as never, 'Nope', corrected), /No tag named/);
    const s2 = snap();
    (s2.tags as Array<{ firingTriggerId: string[] }>)[0].firingTriggerId = [];
    assert.throws(() => planTriggerRetarget(s2 as never, 'CTA Tag', corrected), /no firing trigger/);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
