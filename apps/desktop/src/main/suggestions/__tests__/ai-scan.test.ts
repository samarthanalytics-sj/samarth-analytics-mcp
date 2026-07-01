// Pure tests for the AI single-page scan mapping + vision-response parsing (no
// network, no browser). Run: tsx src/main/suggestions/__tests__/ai-scan.test.ts

import { aiTagsToSuggestions, openaiVisionSuggest, type AiTagPick } from '../ai-scan';
import { dropAiSuggestion } from '../scan-core';
import type { RawElement } from '../../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import type { RawForm } from '../../../../../web-audit-mcp/src/agent/forms.js';
import type { SuggestedTag } from '../../../../../web-audit-mcp/src/agent/tag-suggest/types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const elements: RawElement[] = [
  { tag: 'a', href: 'https://x.com/guide.pdf', text: 'Download guide', hasDownload: false, region: '' }, // E0
  { tag: 'button', href: '', text: 'Book a demo', hasDownload: false, region: '' }, // E1
];
const forms: RawForm[] = [
  { index: 0, action: '/c', method: 'post', formId: 'contact', formName: '', formClasses: '', title: 'Contact', fieldCount: 1, fields: [{ tag: 'input', type: 'email', name: 'email', id: '', label: '', placeholder: '', autocomplete: '', required: true }], hasPrivacyLink: false, text: '' }, // F0
];

// ── aiTagsToSuggestions: AI picks + scraped inventory → creatable tags ────────
const picks: AiTagPick[] = [
  { name: 'Contact Form Submit', event: 'contact_form', kind: 'form', formIndex: 0, why: 'lead form' },
  { name: 'Book a Demo Click', event: 'book_demo_click', kind: 'click', elementIndex: 1 },
  { name: 'Guide Download', event: 'file_download', kind: 'link', elementIndex: 0 },
  { name: 'Hero View', event: 'hero_view', kind: 'pageview' },
  { name: 'Bad Form: x', event: 'x', kind: 'form', formIndex: 9 }, // no such form → dropped
  { name: '', event: 'y', kind: 'click', elementIndex: 1 }, // empty name → dropped
];
const sugs = aiTagsToSuggestions(picks, '/', elements, forms);
check('ai-map: form pick → form_submit scoped by {{Form ID}} equals its real formId', sugs.some((s) => s.eventName === 'contact_form' && s.trigger.kind === 'form_submit' && s.trigger.formIdValue === 'contact' && s.trigger.formIdOperator === 'equals'));
check('ai-map: click pick → all_clicks on {{Click Text}} equals the element text', sugs.some((s) => s.eventName === 'book_demo_click' && s.trigger.kind === 'all_clicks' && s.trigger.clickTextValue === 'Book a demo' && s.trigger.clickTextOperator === 'equals'));
check('ai-map: link pick → link_click on {{Click URL}} contains the element href', sugs.some((s) => s.eventName === 'file_download' && s.trigger.kind === 'link_click' && /guide\.pdf/.test(s.trigger.clickUrlValue ?? '')));
check('ai-map: pageview pick → pageview trigger', sugs.some((s) => s.eventName === 'hero_view' && s.trigger.kind === 'pageview'));
check('ai-map: a pick with a bad reference and an empty-name pick are DROPPED (4 valid)', sugs.length === 4 && !sugs.some((s) => /Bad Form/.test(s.tagName)));
check('ai-map: every AI suggestion is a creatable ga4_event with the AI note', sugs.every((s) => s.platform === 'ga4_event' && s.measurementId === '{{GA4 Measurement ID}}' && /AI-suggested/.test(s.note ?? '')));
check('ai-map: tag + trigger names are sanitized (no GTM-invalid ":")', sugs.every((s) => !s.tagName.includes(':') && !s.trigger.name.includes(':')));

// A >60-char button label must NOT be truncated in the EQUALS click-text value (else the runtime
// {{Click Text}} could never equal it). The tag/trigger NAME may still be shortened separately.
const longText = 'Schedule your free personalized 45-minute strategy consultation call today';
const longSugs = aiTagsToSuggestions([{ name: 'Long CTA', event: 'cta_click', kind: 'click', elementIndex: 0 }], '/', [{ tag: 'button', href: '', text: longText, hasDownload: false, region: '' }], []);
check('ai-map: a long CTA label is NOT truncated in the equals click-text value', longSugs.length === 1 && longSugs[0].trigger.clickTextValue === longText && longSugs[0].trigger.clickTextOperator === 'equals');

// ── dropAiSuggestion: drop AI tags that duplicate the engine scan, or are unsafe ──
const trig = (over: Partial<SuggestedTag['trigger']>): SuggestedTag['trigger'] => ({ name: 'n', kind: 'all_clicks', ...over });
const sug = (eventName: string, t: SuggestedTag['trigger']): SuggestedTag =>
  ({ id: 'i', page: '/', label: '', evidence: '', confidence: 'medium', enhancedMeasurementOverlap: false, platform: 'ga4_event', tagName: 'x', measurementId: '{{m}}', eventName, trigger: t } as SuggestedTag);
const engineScan: SuggestedTag[] = [
  sug('get_started_click', trig({ name: 'Get Free Audit Trigger', clickTextValue: '(?i)\\bfree\\s+audit\\b', clickTextOperator: 'matchRegex' })),
  sug('email_click', trig({ name: 'Email Trigger', kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' })),
];
check('dedup: AI CTA dropped when an engine regex already fires on its literal text ("Get Free Audit")',
  dropAiSuggestion(sug('get_free_audit_click', trig({ clickTextValue: 'Get Free Audit', clickTextOperator: 'contains' })), engineScan) === true);
check('dedup: AI global-event tag dropped when the engine already tracks it once (email_click)',
  dropAiSuggestion(sug('email_click', trig({ clickTextValue: 'admin@x.com', clickTextOperator: 'contains' })), engineScan) === true);
check('dedup: AI unscoped all-clicks tag dropped (would fire on EVERY click)',
  dropAiSuggestion(sug('linkedin_click', trig({})), engineScan) === true);
check('dedup: a genuinely NEW AI CTA the engine does not cover is KEPT',
  dropAiSuggestion(sug('pricing_click', trig({ clickTextValue: 'See Pricing', clickTextOperator: 'contains' })), engineScan) === false);
// Cookie-consent-banner CTAs (CMP UI) are dropped — by click text or by snake_case event name.
const cookieDropped = (['Accept All Cookies', 'Decline All', 'Manage Preferences', 'Cookie Settings', 'Reject All', 'Accept Cookies'] as const).every(
  (t) => dropAiSuggestion(sug('cta_click', trig({ name: t, clickTextValue: t, clickTextOperator: 'contains' })), []) === true,
);
check('cookie: banner CTAs dropped by click text', cookieDropped);
check('cookie: banner CTAs dropped by snake_case event name',
  dropAiSuggestion(sug('accept_all_cookies', trig({ clickTextValue: 'X', clickTextOperator: 'contains' })), []) === true &&
    dropAiSuggestion(sug('manage_preferences_click', trig({ clickTextValue: 'X', clickTextOperator: 'contains' })), []) === true);
check('cookie: a normal CTA is NOT mistaken for a cookie banner',
  dropAiSuggestion(sug('book_demo_click', trig({ clickTextValue: 'Manage subscription', clickTextOperator: 'contains' })), []) === false &&
    dropAiSuggestion(sug('signup_click', trig({ clickTextValue: 'Accept terms and continue', clickTextOperator: 'contains' })), []) === false);

// ── openaiVisionSuggest: response parsing with an injected fetch ──────────────
const asResp = (o: Partial<Response> & { json: () => Promise<unknown> }): Response => o as unknown as Response;
async function run(): Promise<void> {
  const okFetch = (async () => asResp({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tags: [{ name: 'A', event: 'a', kind: 'pageview' }] }) } }] }) })) as unknown as typeof fetch;
  const p = await openaiVisionSuggest('k', 'gpt-4o', 'AAAA', 'inv', { fetchImpl: okFetch });
  check('vision: parses {tags:[...]} from the OpenAI choices[0].message.content', p.length === 1 && p[0].event === 'a' && p[0].kind === 'pageview');

  const errFetch = (async () => asResp({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) })) as unknown as typeof fetch;
  let threw = false;
  try { await openaiVisionSuggest('k', 'gpt-4o', 'x', 'i', { fetchImpl: errFetch }); } catch (e) { threw = /bad key/.test(String(e)); }
  check('vision: HTTP error surfaces the OpenAI error message', threw);

  const junkFetch = (async () => asResp({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }) })) as unknown as typeof fetch;
  check('vision: non-JSON model content → [] (no throw)', (await openaiVisionSuggest('k', 'gpt-4o', 'x', 'i', { fetchImpl: junkFetch })).length === 0);

  console.log(`\nai-scan: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
}
void run();
