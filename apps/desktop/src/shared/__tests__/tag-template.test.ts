// Pure tests for the "GTM Structure - GA4 Events" template mapping (the table view
// + CSV download share this). Run: tsx src/shared/__tests__/tag-template.test.ts

import { suggestionToGroup, suggestionsToTemplateCsv, suggestionsToInstallRunbookMarkdown, installPlanNeedsAction, installPlanStatus, installPlanProgress, triggerWhens, dedupeViewsByGtmName, TEMPLATE_HEADERS, applyTagEdit, applyWhensToTrigger, adsIdentityIssue, conditionToOperator, CONDITION_LABELS , conversionActionNameFromTag } from '../tag-template';
import type { SuggestedTagView } from '../ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const base = (over: Partial<SuggestedTagView>): SuggestedTagView => ({
  id: over.id ?? 'x', page: 'site-wide', label: '', evidence: '', confidence: 'high',
  enhancedMeasurementOverlap: false, platform: 'ga4_event', measurementId: '{{GA4 Measurement ID}}',
  tagName: 'GA4 Event - X Tag', eventName: 'x', trigger: { name: 'X Trigger', kind: 'all_clicks' }, ...over,
});

// ── trigger filter → "when" rows ─────────────────────────────────────────────
const phone = base({
  id: 'p', tagName: 'GA4 Event - Phone Click Tag', eventName: 'phone_click',
  eventParameters: [{ name: 'click_text', value: '{{Click Text}}' }, { name: 'click_url', value: '{{Click URL}}' }, { name: 'page_path', value: '{{Page Path}}' }],
  trigger: { name: 'Phone Click Trigger', kind: 'link_click', clickUrlValue: 'tel:', clickUrlOperator: 'startsWith' },
});
const pw = triggerWhens(phone);
check('when: link_click clickUrl startsWith → {{Click URL}} / "starts with" / value', pw.length === 1 && pw[0].variable === '{{Click URL}}' && pw[0].condition === 'starts with' && pw[0].value === 'tel:');

const form = base({
  id: 'f', tagName: 'GA4 Event - Search Form Tag', eventName: 'search',
  eventParameters: [{ name: 'form_id', value: '{{Form ID}}' }],
  trigger: { name: 'Search Form Trigger', kind: 'form_submit', formIdValue: 'searchForm', formIdOperator: 'equals' },
});
check('when: form_submit formId equals → {{Form ID}} / "equals" / value', triggerWhens(form)[0].condition === 'equals' && triggerWhens(form)[0].variable === '{{Form ID}}');

// FAQ accordion: {{Click Element}} matches CSS selector → the "matches CSS selector" condition row.
const faqTag = base({ id: 'faq', tagName: 'GA4 - Event - FAQ Click Tag', eventName: 'faq_click', trigger: { name: 'FAQ Click Trigger', kind: 'all_clicks', clickElementValue: '.faq-q, .faq-q *', clickElementOperator: 'cssSelector' } });
const fw = triggerWhens(faqTag)[0];
check('when: all_clicks clickElement cssSelector → {{Click Element}} / "matches CSS selector" / value', fw.variable === '{{Click Element}}' && fw.condition === 'matches CSS selector' && fw.value === '.faq-q, .faq-q *');

// A page-scoped form (no id/class, one page) → {{Page Path}} condition, NOT "fires on every form submit".
const pageForm = base({
  id: 'pf', tagName: 'GA4 - Event - Contact Form Tag', eventName: 'contact_form',
  trigger: { name: 'Contact Form Trigger', kind: 'form_submit', pagePathValue: '/en/request-demo', pagePathOperator: 'contains' },
});
const pfw = triggerWhens(pageForm);
check('when: page-scoped form_submit → {{Page Path}} contains "/en/request-demo" (not "every form submit")', pfw.length === 1 && pfw[0].variable === '{{Page Path}}' && pfw[0].value === '/en/request-demo');

// A GET site-search Page View → {{Page URL}} contains the query key.
const searchPv = base({
  id: 'sp', tagName: 'GA4 - Event - Site Search Tag', eventName: 'view_search_results',
  trigger: { name: 'Site Search Trigger', kind: 'pageview', pageUrlValue: 'q=', pageUrlOperator: 'contains' },
});
const spw = triggerWhens(searchPv);
check('when: site-search pageview → {{Page URL}} contains "q="', spw.length === 1 && spw[0].variable === '{{Page URL}}' && spw[0].value === 'q=');

// ── group shape ──────────────────────────────────────────────────────────────
const gp = suggestionToGroup(phone);
check('group: tagType + triggerType mapped (Click - Just Links)', gp.tagType === 'GA4 Event Tag' && gp.triggerType === 'Click - Just Links');
check('group: rowCount = max(params, whens, 1)', gp.rowCount === 3);

const yt = base({
  id: 'y', tagName: 'GA4 Event - YouTube Video Tag', eventName: 'video_{{Video Status}}',
  eventParameters: [
    { name: 'video_title', value: '{{Video Title}}' }, { name: 'video_url', value: '{{Video URL}}' },
    { name: 'video_provider', value: '{{Video Provider}}' }, { name: 'video_percent', value: '{{Video Percent}}' },
  ],
  trigger: { name: 'YouTube Video Trigger', kind: 'youtube_video' },
});
const gyt = suggestionToGroup(yt);
check('group: youtube_video → "YouTube Video" type, no when conditions', gyt.triggerType === 'YouTube Video' && gyt.whens.length === 0 && gyt.rowCount === 4);

// ── the GA4 Configuration (google_tag) base tag ──────────────────────────────
const gtag = base({ id: 'g', platform: 'google_tag', tagName: 'GA4 Configuration', eventName: '', tagId: '{{GA4 Measurement ID}}', trigger: { name: 'All Pages', kind: 'pageview' }, configSettings: [{ name: 'send_page_view', value: 'true' }] });
const gg = suggestionToGroup(gtag);
check('group: google_tag → "Google Tag" tag type', gg.tagType === 'Google Tag');
check('group: google_tag rows use configSettings (not eventParameters) as the params', gg.params.length === 1 && gg.params[0].name === 'send_page_view' && gg.params[0].variable === 'true');
check('csv: google_tag block has Page View trigger + no when conditions', gg.triggerType === 'Page View' && gg.whens.length === 0);

// ── a Meta (Facebook) Pixel tag: shows its tag name, the Meta event, and the trigger condition ──
const metaPixel = base({ id: 'm', platform: 'meta_pixel', tagName: 'Meta - Lead - Contact Form Tag', eventName: 'Lead', measurementId: '{{Meta Pixel ID}}', trigger: { name: 'Contact Form Trigger', kind: 'form_submit', formIdValue: 'lead-form', formIdOperator: 'equals' } });
const mg = suggestionToGroup(metaPixel);
check('group: meta_pixel → "Meta Pixel Tag" tag type, its Meta event, its trigger', mg.tagType === 'Meta Pixel Tag' && mg.eventName === 'Lead' && mg.tagName === 'Meta - Lead - Contact Form Tag' && mg.triggerType === 'Form Submission' && mg.whens[0]?.variable === '{{Form ID}}' && mg.whens[0]?.value === 'lead-form');

// ── CSV layout ───────────────────────────────────────────────────────────────
const csv = suggestionsToTemplateCsv([phone]);
const rows = csv.split('\r\n');
check('csv: header is the template columns', rows[0] === TEMPLATE_HEADERS.join(','));
check('csv: ends with a trailing CRLF', csv.endsWith('\r\n'));
check('csv: tag block first row carries tag + trigger + param[0] + when[0]',
  rows[1] === 'GA4 Event Tag,GA4 Event - Phone Click Tag,phone_click,click_text,{{Click Text}},Phone Click Trigger,Click - Just Links,{{Click URL}},starts with,tel:');
check('csv: subsequent param rows leave tag/trigger/when columns blank', rows[2] === ',,,click_url,{{Click URL}},,,,,' && rows[3] === ',,,page_path,{{Page Path}},,,,,');
check('csv: every data row has exactly 10 columns', rows.slice(1).filter(Boolean).every((r) => r.split(',').length === TEMPLATE_HEADERS.length));

// ── RFC-4180 escaping (comma / quote in a value) ─────────────────────────────
const comma = base({ id: 'c', trigger: { name: 'T', kind: 'all_clicks', clickTextValue: 'play, pause', clickTextOperator: 'equals' }, eventParameters: [{ name: 'a', value: 'b' }] });
const crows = suggestionsToTemplateCsv([comma]).split('\r\n');
check('csv: a value containing a comma is quoted', crows[1].includes('"play, pause"'));

// ── multiple tags → multiple blocks, YouTube event name with {{}} preserved ──
const multi = suggestionsToTemplateCsv([phone, yt]);
check('csv: multiple suggestions produce multiple blocks', multi.includes('GA4 Event - Phone Click Tag') && multi.includes('GA4 Event - YouTube Video Tag') && multi.includes('video_{{Video Status}}'));

// ── dedupeViewsByGtmName: two rows that would create the SAME GTM tag show once ───────────────
// The exact user report: two "GA4 - Event - Free Audit Click Tag" rows (same event + trigger), plus a
// distinct "Contact Us" tag between them. The duplicate collapses; the distinct tag stays; order + the
// FIRST occurrence are preserved.
const fa1 = base({ id: 'fa1', tagName: 'GA4 - Event - Free Audit Click Tag', eventName: 'free_audit_click', trigger: { name: 'Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Free Audit', clickTextOperator: 'equals' } });
const contact = base({ id: 'cu', tagName: 'GA4 - Event - Contact Us Click Tag', eventName: 'contact_us_click', page: '/services/server-side-tracking', trigger: { name: 'Contact Us Click Trigger', kind: 'all_clicks', clickTextValue: 'Contact Us', clickTextOperator: 'equals' } });
const fa2 = base({ id: 'fa2', tagName: 'GA4 - Event - Free Audit Click Tag', eventName: 'free_audit_click', trigger: { name: 'Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Free Audit', clickTextOperator: 'equals' } });
const dd = dedupeViewsByGtmName([fa1, contact, fa2]);
check('dedupe: identical-name Free Audit rows collapse to one, Contact Us kept', dd.length === 2 && dd[0].id === 'fa1' && dd[1].id === 'cu');
check('dedupe: keeps the FIRST occurrence (fa1, not fa2)', dd.some((s) => s.id === 'fa1') && !dd.some((s) => s.id === 'fa2'));

// Same NAME but a slightly different trigger (the AI-vision copy) and case/space differences still
// collapse — GTM tag names are unique, so the second can never be created.
const faVar = base({ id: 'fav', tagName: '  GA4 - Event - FREE AUDIT Click Tag ', eventName: 'free_audit_click', trigger: { name: 'Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Free Audit', clickTextOperator: 'equals', clickElementValue: 'a.cta', clickElementOperator: 'cssSelector' } });
check('dedupe: same name up to case/whitespace + different trigger still collapses', dedupeViewsByGtmName([fa1, faVar]).length === 1);

// A DIFFERENT platform with the same name is a genuinely different tag → both kept.
const faMeta = base({ id: 'fam', platform: 'meta_pixel', tagName: 'GA4 - Event - Free Audit Click Tag' });
check('dedupe: same name on a different platform is NOT collapsed', dedupeViewsByGtmName([fa1, faMeta]).length === 2);
check('dedupe: idempotent (running twice is a no-op)', dedupeViewsByGtmName(dedupeViewsByGtmName([fa1, contact, fa2])).length === 2);

// The REAL bug: punctuation/whitespace-only NAME variants of the SAME CTA (same event) must collapse.
// The old key kept them because `.toLowerCase()` alone left "Free Audit" ≠ "Free  Audit" ≠ "Free-Audit".
const faDbl = base({ id: 'fad', tagName: 'GA4 - Event - Free  Audit Click Tag', eventName: 'free_audit_click', trigger: { name: 'Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Free Audit', clickTextOperator: 'equals' } });
const faHyphen = base({ id: 'fah', tagName: 'GA4 - Event - Free-Audit Click Tag', eventName: 'free_audit_click', trigger: { name: 'Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Free Audit', clickTextOperator: 'equals' } });
check('dedupe: punctuation/whitespace name variants of the same CTA collapse to ONE', dedupeViewsByGtmName([fa1, faDbl, faHyphen]).length === 1);

// Genuinely-different near-dupes (different event AND normalized name) STAY separate — the user's
// "Get a Free Audit" (get_a_free_audit_click) vs "Get Free Audit" (get_free_audit_click).
const getA = base({ id: 'ga', tagName: 'GA4 - Event - Get A Free Audit Click Tag', eventName: 'get_a_free_audit_click', trigger: { name: 'Get A Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Get a free audit', clickTextOperator: 'equals' } });
const getF = base({ id: 'gf', tagName: 'GA4 - Event - Get Free Audit Click Tag', eventName: 'get_free_audit_click', trigger: { name: 'Get Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Get Free Audit', clickTextOperator: 'equals' } });
check('dedupe: near-dupes with different events stay separate', dedupeViewsByGtmName([getA, getF]).length === 2);

// The user's report: FOUR byte-identical "Contact Us Click Tag" rows on ONE page → ONE row.
const cu = (id: string): SuggestedTagView => base({ id, page: '/services/server-side-tracking', tagName: 'GA4 - Event - Contact Us Click Tag', eventName: 'contact_us_click', trigger: { name: 'Contact Us Click Trigger', kind: 'link_click', clickTextValue: 'Contact Us', clickTextOperator: 'equals' } });
check('dedupe: four byte-identical rows on one page collapse to ONE', dedupeViewsByGtmName([cu('a'), cu('b'), cu('c'), cu('d')]).length === 1);

// ── inline editing: applyTagEdit / applyWhensToTrigger / conditionToOperator ──────────────────
check('edit: no edit is identity', applyTagEdit(phone, undefined) === phone);

// Simple field overrides (tag name / event / measurement id / page / trigger name) fall through.
const e1 = applyTagEdit(phone, { tagName: 'Renamed Tag', eventName: 'phone_tap', measurementId: '{{G2}}', page: '/contact', triggerName: 'Tap Trigger' });
check('edit: overrides tagName/eventName/measurementId/page/triggerName', e1.tagName === 'Renamed Tag' && e1.eventName === 'phone_tap' && e1.measurementId === '{{G2}}' && e1.page === '/contact' && e1.trigger.name === 'Tap Trigger');
check('edit: untouched fields are preserved', e1.trigger.clickUrlValue === 'tel:' && e1.eventParameters?.length === 3);

// params override → eventParameters (ga4) with {name,value}; a blank-name row is dropped.
const e2 = applyTagEdit(phone, { params: [{ name: 'click_text', variable: '{{Click Text}}' }, { name: '', variable: 'x' }, { name: 'extra', variable: '{{Page URL}}' }] });
check('edit: params override maps to eventParameters {name,value}, drops blank-name rows',
  JSON.stringify(e2.eventParameters) === JSON.stringify([{ name: 'click_text', value: '{{Click Text}}' }, { name: 'extra', value: '{{Page URL}}' }]));
// params for a google_tag land in configSettings, not eventParameters.
const e2g = applyTagEdit(gtag, { params: [{ name: 'send_page_view', variable: 'false' }] });
check('edit: params for google_tag go to configSettings', JSON.stringify(e2g.configSettings) === JSON.stringify([{ name: 'send_page_view', value: 'false' }]) && (e2g.eventParameters ?? []).length === 0);

// whens override → reverse-maps each row to the trigger field its variable names (value + operator move).
const e3 = applyTagEdit(phone, { whens: [{ variable: '{{Click Text}}', condition: 'contains', value: 'Call us' }] });
check('edit: whens override re-points the value to a different variable + clears the old field',
  e3.trigger.clickTextValue === 'Call us' && e3.trigger.clickTextOperator === 'contains' && e3.trigger.clickUrlValue === undefined);
check('edit: whens override round-trips through triggerWhens', (() => { const w = triggerWhens(e3); return w.length === 1 && w[0].variable === '{{Click Text}}' && w[0].condition === 'contains' && w[0].value === 'Call us'; })());
// A blank-value when row drops that condition entirely (never leaves a fires-on-everything trigger).
const e4 = applyTagEdit(phone, { whens: [{ variable: '{{Click URL}}', condition: 'starts with', value: '   ' }] });
check('edit: a blank-value when row is dropped (no dangling filter)', triggerWhens(e4).length === 0);
// The "(ignore case)" suffix survives an untouched condition; a fresh base operator drops it.
const e5 = applyTagEdit(faqTag, { whens: [{ variable: '{{Click Text}}', condition: 'contains (ignore case)', value: 'x' }] });
check('edit: condition "(ignore case)" suffix maps to ignoreCase=true', e5.trigger.clickTextIgnoreCase === true && e5.trigger.clickTextOperator === 'contains');

// Removing a condition (the row's "×" button) → apply the REDUCED whens: the dropped field is cleared,
// the kept one stays. Mirrors a user undoing an extra condition they'd added to a two-condition tag.
const twoCond = base({
  id: 'tc', tagName: 'GA4 - Event - Contact Form Tag', eventName: 'contact_form',
  trigger: { name: 'Contact Form Trigger', kind: 'custom_event', eventName: 'form_submit', pagePathValue: '/contact', pagePathOperator: 'contains', clickUrlValue: 'x', clickUrlOperator: 'equals' },
});
const removed = applyTagEdit(twoCond, { whens: triggerWhens(twoCond).filter((w) => w.variable !== '{{Click URL}}') });
check('edit: removing a condition clears its field + keeps the other', removed.trigger.clickUrlValue === undefined && removed.trigger.pagePathValue === '/contact' && triggerWhens(removed).length === 1);

// platform + triggerKind overrides.
const e6 = applyTagEdit(phone, { platform: 'meta_pixel', triggerKind: 'all_clicks' });
check('edit: platform + triggerKind override', e6.platform === 'meta_pixel' && e6.trigger.kind === 'all_clicks');

// conditionToOperator inverse of the CONDITION map (+ unknown → equals).
check('conditionToOperator: base labels invert (incl legacy "equals to")', conditionToOperator('starts with').op === 'startsWith' && conditionToOperator('equals').op === 'equals' && conditionToOperator('equals to').op === 'equals' && conditionToOperator('matches RegEx').op === 'matchRegex' && conditionToOperator('matches CSS selector').op === 'cssSelector');
check('conditionToOperator: negations + numeric invert', conditionToOperator('does not equal').op === 'notEquals' && conditionToOperator('does not contain').op === 'notContains' && conditionToOperator('does not start with').op === 'notStartsWith' && conditionToOperator('does not match CSS selector').op === 'notCssSelector' && conditionToOperator('does not match RegEx').op === 'notMatchRegex' && conditionToOperator('less than').op === 'less' && conditionToOperator('less than or equal to').op === 'lessOrEquals' && conditionToOperator('greater than').op === 'greater' && conditionToOperator('greater than or equal to').op === 'greaterOrEquals');
check('conditionToOperator: "does not match RegEx (ignore case)" → notMatchRegex + ignoreCase', conditionToOperator('does not match RegEx (ignore case)').op === 'notMatchRegex' && conditionToOperator('does not match RegEx (ignore case)').ignoreCase === true);
check('conditionToOperator: unknown → equals, ignore-case detected', conditionToOperator('nonsense').op === 'equals' && conditionToOperator('contains (ignore case)').ignoreCase === true && conditionToOperator('contains').ignoreCase === false);
// The Condition dropdown offers GTM's full 18-operator list, in GTM's order.
check('CONDITION_LABELS is the full GTM operator list (18, GTM order)', CONDITION_LABELS.length === 18 && CONDITION_LABELS[0] === 'equals' && CONDITION_LABELS.includes('does not match RegEx (ignore case)') && CONDITION_LABELS.includes('greater than or equal to') && CONDITION_LABELS.includes('does not equal'));
// A negated operator round-trips: edit → operator token → re-projected label.
const neg = applyTagEdit(phone, { whens: [{ variable: '{{Click Text}}', condition: 'does not contain', value: 'spam' }] });
check('edit: negation round-trips (does not contain → notContains → "does not contain")', neg.trigger.clickTextOperator === 'notContains' && triggerWhens(neg)[0].condition === 'does not contain' && neg.trigger.clickUrlValue === undefined);

// A platform switch MIGRATES the existing params to the new platform's field (not orphaned) + clears the other.
const pmig = applyTagEdit(phone, { platform: 'google_tag' });
check('edit: ga4→google_tag migrates eventParameters into configSettings + clears eventParameters',
  JSON.stringify(pmig.configSettings) === JSON.stringify([{ name: 'click_text', value: '{{Click Text}}' }, { name: 'click_url', value: '{{Click URL}}' }, { name: 'page_path', value: '{{Page Path}}' }]) && (pmig.eventParameters ?? []).length === 0);
const gmig = applyTagEdit(gtag, { platform: 'ga4_event' });
check('edit: google_tag→ga4 migrates configSettings into eventParameters + clears configSettings',
  JSON.stringify(gmig.eventParameters) === JSON.stringify([{ name: 'send_page_view', value: 'true' }]) && (gmig.configSettings ?? []).length === 0);

// A trigger KIND change clears the OLD kind's stranded filter fields (else the new kind's builder ignores
// them and the tag fires on everything).
const kmig = applyTagEdit(form, { triggerKind: 'link_click' });
check('edit: kind change clears the old kind filter fields (no fires-on-everything)', kmig.trigger.kind === 'link_click' && kmig.trigger.formIdValue === undefined && triggerWhens(kmig).length === 0);
// An explicit whens edit made alongside a kind change is honored (not wiped).
const kw = applyTagEdit(form, { triggerKind: 'link_click', whens: [{ variable: '{{Click URL}}', condition: 'contains', value: '/x' }] });
check('edit: explicit whens survive a simultaneous kind change', triggerWhens(kw).length === 1 && kw.trigger.clickUrlValue === '/x' && kw.trigger.formIdValue === undefined);

// applyWhensToTrigger clears ALL standard fields before re-applying (an emptied whens = no filter).
const cleared = applyWhensToTrigger(phone.trigger, []);
check('applyWhensToTrigger: empty whens clears every standard filter field', cleared.clickUrlValue === undefined && cleared.clickTextValue === undefined && cleared.formIdValue === undefined && cleared.pageUrlValue === undefined);

// ── install runbook (whole-scan measurement plan Markdown) ────────────────────
// A native click suggestion (nothing to install), a form suggestion with a listener-tag install (the
// same listener appears on TWO suggestions → deduped once), and a site-code ecommerce suggestion.
const nativeClick = base({
  id: 'nc', tagName: 'GA4 - Event - Buy Now Click Tag', eventName: 'buy_now_click', page: '/pricing',
  trigger: { name: 'Buy Now Click Trigger', kind: 'all_clicks', clickTextValue: 'Buy Now', clickTextOperator: 'equals' },
  install: { requires: [{ kind: 'native', detail: "GTM's Click - All Elements trigger fires on the click; no site change needed." }], summary: 'Native All-Elements Click — nothing to install.' },
});
const LISTENER_HTML = '<script>(function(){window.dataLayer=window.dataLayer||[];document.addEventListener("submit",function(e){var f=e.target;window.dataLayer.push({event:"form_submit",form_id:f.id||""});},true);})();</script>';
const formA = base({
  id: 'fa', tagName: 'GA4 - Event - Contact Form Tag', eventName: 'form_submit', page: '/contact',
  trigger: { name: 'Contact Form Trigger', kind: 'custom_event', eventName: 'form_submit' },
  install: { requires: [{ kind: 'listener-tag', event: 'form_submit', tag: { name: 'cust - Form listener (form_submit)', html: LISTENER_HTML, fires: 'all_pages' }, detail: 'A Custom HTML tag firing on All Pages adds a delegated submit listener.' }], summary: 'Auto-create 1 Custom HTML listener tag; no site code needed.' },
});
// A SECOND form suggestion carrying the SAME listener tag name → the consolidated section must list it once.
const formB = base({
  id: 'fb', tagName: 'GA4 - Event - Newsletter Form Tag', eventName: 'form_submit', page: '/newsletter',
  trigger: { name: 'Newsletter Form Trigger', kind: 'custom_event', eventName: 'form_submit' },
  install: { requires: [{ kind: 'listener-tag', event: 'form_submit', tag: { name: 'cust - Form listener (form_submit)', html: LISTENER_HTML, fires: 'all_pages' }, detail: 'A Custom HTML tag firing on All Pages adds a delegated submit listener.' }], summary: 'Auto-create 1 Custom HTML listener tag; no site code needed.' },
});
const PURCHASE_SNIPPET = '<script>window.dataLayer=window.dataLayer||[];dataLayer.push({event:"purchase", ecommerce:{ transaction_id:"…", value:0, currency:"USD", items:[…] }});</script>';
const purchase = base({
  id: 'pu', tagName: 'GA4 - Event - Purchase Tag', eventName: 'purchase', page: '/checkout/success',
  trigger: { name: 'Purchase Trigger', kind: 'custom_event', eventName: 'purchase' },
  install: { requires: [{ kind: 'site-code', snippet: PURCHASE_SNIPPET, where: "your site's ecommerce/dataLayer layer", detail: 'GA4/GTM does not auto-collect the "purchase" event — your site must push it.' }], summary: 'Your site must push the "purchase" dataLayer event (code required).' },
});

const rb = suggestionsToInstallRunbookMarkdown([nativeClick, formA, formB, purchase], { site: 'https://shop.example.com', scannedAt: '2026-07-07T10:00:00Z' });
check('runbook: has the H1 title', rb.startsWith('# Measurement Installation Runbook'));
check('runbook: subtitle carries site + scannedAt + counts', rb.includes('https://shop.example.com') && rb.includes('scanned 2026-07-07T10:00:00Z') && rb.includes('4 tags') && rb.includes('1 native-only') && rb.includes('2 need a listener tag') && rb.includes('1 need site code'));
check('runbook: has Summary, Tags, and Site-side sections', rb.includes('## Summary') && rb.includes('## Tags') && rb.includes('## Site-side work (for your developer)'));
check('runbook: a native click suggestion prints "Nothing to install"', rb.includes('- Nothing to install:'));
check('runbook: each tag block has a numbered ### heading', rb.includes('### 1. GA4 - Event - Buy Now Click Tag') && rb.includes('### 4. GA4 - Event - Purchase Tag'));
check('runbook: a listener suggestion shows the create-listener line + fenced html', rb.includes('Create a Custom HTML tag "cust - Form listener (form_submit)" on all_pages') && rb.includes('```html'));
check('runbook: the purchase site-code snippet + its dataLayer push appear', rb.includes('Add to your site') && rb.includes('dataLayer.push({event:"purchase"'));
check('runbook: consolidated "Listener tags to create in GTM" section present', rb.includes('### Listener tags to create in GTM'));
check('runbook: consolidated "dataLayer events your site must push" section present', rb.includes('### dataLayer events your site must push'));
// Dedup: the listener tag name appears ONCE in the consolidated section (though it's on TWO suggestions).
const consolidated = rb.slice(rb.indexOf('## Site-side work'));
const listenerHits = consolidated.split('cust - Form listener (form_submit)').length - 1;
check('runbook: the shared listener is listed ONCE in the consolidated section (deduped across two tags)', listenerHits === 1, `hits=${listenerHits}`);
// The purchase event appears once in the consolidated dataLayer-events list.
const purchaseEventHits = consolidated.split('- purchase\n').length - 1;
check('runbook: the purchase dataLayer event is listed once', purchaseEventHits === 1, `hits=${purchaseEventHits}`);

// A suggestion with NO install plan → the per-tag "Install: native (nothing to install)" fallback.
const noPlan = base({ id: 'np', tagName: 'GA4 - Event - Bare Tag', eventName: 'bare', trigger: { name: 'Bare Trigger', kind: 'all_clicks' } });
const rbBare = suggestionsToInstallRunbookMarkdown([noPlan], {});
check('runbook: a suggestion with no install plan prints the native fallback line', rbBare.includes('- Install: native (nothing to install)'));
check('runbook: no meta → subtitle omits site/scannedAt but keeps counts', !rbBare.includes('scanned ') && rbBare.includes('1 tag') && rbBare.includes('1 native-only'));

// An ALL-native list → the "No site-side code needed" message, and none of the sub-sections.
const rbAllNative = suggestionsToInstallRunbookMarkdown([nativeClick, noPlan], {});
check('runbook: an all-native list prints "No site-side code needed"', rbAllNative.includes("No site-side code needed - every tag fires on GTM's built-in triggers."));
check('runbook: an all-native list omits the listener/event/attribute sub-sections', !rbAllNative.includes('### Listener tags to create in GTM') && !rbAllNative.includes('### dataLayer events your site must push'));

// An html-attribute requirement (a native form with no id) surfaces in the consolidated attributes list.
const attrForm = base({
  id: 'af', tagName: 'GA4 - Event - Quote Form Tag', eventName: 'generate_lead', page: '/quote',
  trigger: { name: 'Quote Form Trigger', kind: 'form_submit', pagePathValue: '/quote', pagePathOperator: 'contains' },
  install: { requires: [
    { kind: 'native', detail: 'This is a native <form> GTM detects — no site change is needed.' },
    { kind: 'html-attribute', selector: 'form', attribute: 'id', value: '<a-unique-id>', detail: 'Add a stable id for precise {{Form ID}} scoping.' },
  ], summary: 'Native form — nothing to install (add a unique id for precise scoping).' },
});
const rbAttr = suggestionsToInstallRunbookMarkdown([attrForm], {});
check('runbook: an html-attribute requirement shows per-tag + in the consolidated "HTML attributes to add" section', rbAttr.includes('### HTML attributes to add') && rbAttr.includes('Add `id="<a-unique-id>"` to `form`'));

// ── installPlanNeedsAction — drives the review table's "How to install" toggle visibility ──────────
// True ONLY when the plan asks the user to add something site-side (listener-tag / html-attribute /
// site-code). False for native / provider-native / empty / absent — where the affordance is hidden.
check('needsAction: native-only click plan → false', installPlanNeedsAction(nativeClick.install) === false);
check('needsAction: no install plan → false', installPlanNeedsAction(noPlan.install) === false);
check('needsAction: undefined install → false', installPlanNeedsAction(undefined) === false);
check('needsAction: provider-native ("already pushed") → false',
  installPlanNeedsAction({ requires: [{ kind: 'provider-native', provider: 'site', detail: 'Your site already pushes "add_to_cart".' }], summary: 'Already pushed - nothing to install.' }) === false);
check('needsAction: listener-tag plan → true', installPlanNeedsAction(formA.install) === true);
check('needsAction: site-code plan → true', installPlanNeedsAction(purchase.install) === true);
check('needsAction: mixed native + html-attribute → true', installPlanNeedsAction(attrForm.install) === true);
// The predicate must be the exact inverse of the runbook's "native-only" categorisation: a native-only
// plan is exactly the set that prints "No site-side code needed" AND hides the toggle.
check('needsAction: agrees with runbook native-only (nativeClick omitted from site-side work)',
  installPlanNeedsAction(nativeClick.install) === false &&
    suggestionsToInstallRunbookMarkdown([nativeClick], {}).includes("No site-side code needed"));

// ── installPlanStatus — the one-glance status driving the review table's colour-coded chip ──────────
check('status: native-only → ready', installPlanStatus(nativeClick.install).kind === 'ready');
check('status: no plan → ready', installPlanStatus(noPlan.install).kind === 'ready');
check('status: undefined → ready', installPlanStatus(undefined).kind === 'ready');
const attrStatus = installPlanStatus(attrForm.install);
check('status: native + optional html-attribute → ready-tip', attrStatus.kind === 'ready-tip');
check('status: ready-tip counts the optional tips', attrStatus.optionalCount === 1);
const listenerStatus = installPlanStatus(formA.install);
check('status: listener-tag plan → listener', listenerStatus.kind === 'listener');
check('status: listener count is 1', listenerStatus.listenerCount === 1);
check('status: site-code plan → code', installPlanStatus(purchase.install).kind === 'code');
// Precedence for a mixed plan: code beats listener beats ready-tip. A plan needing BOTH a listener tag
// AND site code is a "code" status (the most-demanding ask wins the chip).
const mixed = installPlanStatus({
  requires: [
    { kind: 'html-attribute', selector: 'form', attribute: 'id', value: '<id>', detail: 'x' },
    { kind: 'listener-tag', event: 'form_submit', tag: { name: 'L', html: '<script></script>', fires: 'all_pages' }, detail: 'y' },
    { kind: 'site-code', snippet: '<script></script>', where: 'z', detail: 'w' },
  ],
  summary: 's',
});
check('status: mixed listener+code+optional → code (most-demanding wins)', mixed.kind === 'code');
check('status: mixed still counts every requirement kind', mixed.listenerCount === 1 && mixed.siteCodeCount === 1 && mixed.optionalCount === 1);
// The chip is shown exactly when installPlanNeedsAction is true — i.e. any status except 'ready'.
check('status: needsAction ⇔ status !== ready (ready)', installPlanNeedsAction(nativeClick.install) === (installPlanStatus(nativeClick.install).kind !== 'ready'));
check('status: needsAction ⇔ status !== ready (listener)', installPlanNeedsAction(formA.install) === (installPlanStatus(formA.install).kind !== 'ready'));

// ── installPlanProgress — the chip's "done" progress against a per-requirement check-off set ────────
// A site-code plan (purchase, requires[0] is the site-code): not done → still required outstanding;
// once index 0 is checked off → allRequiredDone + fullyDone.
const codeUndone = installPlanProgress(purchase.install, {});
check('progress: site-code not checked → 1 required, 0 done, not allRequiredDone', codeUndone.requiredTotal === 1 && codeUndone.requiredDone === 0 && codeUndone.allRequiredDone === false);
const codeDone = installPlanProgress(purchase.install, { 0: true });
check('progress: site-code checked → allRequiredDone + fullyDone', codeDone.allRequiredDone === true && codeDone.fullyDone === true);
// A listener plan (formA, requires[0] is the listener): marking index 0 done → fully done.
check('progress: listener not created → not done', installPlanProgress(formA.install, {}).allRequiredDone === false);
check('progress: listener marked done → fully done', installPlanProgress(formA.install, { 0: true }).fullyDone === true);
// attrForm = native (index 0) + OPTIONAL html-attribute (index 1). No required steps, so allRequiredDone
// is vacuously true from the start; fullyDone only once the optional tip is checked off.
const optUndone = installPlanProgress(attrForm.install, {});
check('progress: optional-only → allRequiredDone true but not fullyDone until the tip is applied', optUndone.requiredTotal === 0 && optUndone.allRequiredDone === true && optUndone.fullyDone === false && optUndone.optionalTotal === 1);
check('progress: optional checked off → fullyDone', installPlanProgress(attrForm.install, { 1: true }).fullyDone === true);
// A native-only plan has no actionable steps → everything is vacuously done.
check('progress: native-only → fullyDone (nothing to do)', installPlanProgress(nativeClick.install, {}).fullyDone === true && installPlanProgress(nativeClick.install, {}).requiredTotal === 0);
// Mixed listener + site-code + optional: both required must be checked before allRequiredDone.
const mixedPlan = { requires: [
  { kind: 'listener-tag' as const, event: 'form_submit', tag: { name: 'L', html: '<script></script>', fires: 'all_pages' as const }, detail: 'y' },
  { kind: 'site-code' as const, snippet: '<script></script>', where: 'z', detail: 'w' },
  { kind: 'html-attribute' as const, selector: 'form', attribute: 'id', value: '<id>', detail: 'x' },
], summary: 's' };
check('progress: mixed, only listener done → not allRequiredDone', installPlanProgress(mixedPlan, { 0: true }).allRequiredDone === false);
check('progress: mixed, both required done → allRequiredDone but not fullyDone (optional left)', (() => { const p = installPlanProgress(mixedPlan, { 0: true, 1: true }); return p.allRequiredDone === true && p.fullyDone === false; })());
check('progress: mixed, all three done → fullyDone', installPlanProgress(mixedPlan, { 0: true, 1: true, 2: true }).fullyDone === true);

// ── Google Ads identity rows (Conversion ID / Label) ─────────────────────────
// The suggestion engine seeds these rows with {{Google Ads Conversion ID}} / {{Google Ads Conversion
// Label}}, and NOTHING creates those GTM variables (planGoogleTagVars only handles 'google_tag'), so a
// row left as-is builds an awct tag that references variables that do not exist and can never fire.
const adsPlaceholder = base({
  id: 'ads', platform: 'google_ads_conversion', tagName: 'Google Ads - Conversion - Contact Form',
  eventName: 'contact_form', measurementId: '{{Google Ads Conversion ID}}', conversionLabel: '{{Google Ads Conversion Label}}',
  trigger: { name: 'Contact Form Trigger', kind: 'form_submit', formIdValue: 'contact', formIdOperator: 'equals' },
});
const adsReal = applyTagEdit(adsPlaceholder, { measurementId: 'AW-123456789', conversionLabel: 'AbC-dEfGh12_34' });
const adsRemarketing = base({ id: 'rm', platform: 'google_ads_remarketing', tagName: 'Google Ads - Remarketing', eventName: '', measurementId: 'AW-123456789', trigger: { name: 'All Pages', kind: 'pageview' } });

const ga = suggestionToGroup(adsReal);
check('ads group: conversion projects Conversion ID + Conversion Label identity rows', ga.params.length === 2 && ga.params[0].name === 'Conversion ID' && ga.params[1].name === 'Conversion Label');
check('ads group: identity rows carry the field they write back to', ga.params[0].field === 'measurementId' && ga.params[1].field === 'conversionLabel');
check('ads group: identity rows carry the tag\'s live values', ga.params[0].variable === 'AW-123456789' && ga.params[1].variable === 'AbC-dEfGh12_34');
check('ads group: rowCount spans the identity rows', ga.rowCount === 2);
const grm = suggestionToGroup(adsRemarketing);
check('ads group: remarketing projects ONLY a Conversion ID row (it takes no label)', grm.params.length === 1 && grm.params[0].field === 'measurementId');
check('ads group: a non-Ads platform is unchanged (no identity rows)', suggestionToGroup(phone).params.every((p) => p.field === undefined));
// conversion_linker has no id fields at all, so it must not project an identity row.
check('ads group: conversion_linker projects no identity rows', suggestionToGroup(base({ id: 'cl', platform: 'conversion_linker', tagName: 'Conversion Linker', eventName: '', measurementId: '', trigger: { name: 'All Pages', kind: 'pageview' } })).params.length === 0);

check('ads edit: conversionLabel is overridable (the field TagEdit was missing)', adsReal.conversionLabel === 'AbC-dEfGh12_34' && adsReal.measurementId === 'AW-123456789');
check('ads edit: an untouched conversionLabel is preserved', applyTagEdit(adsPlaceholder, { tagName: 'X' }).conversionLabel === '{{Google Ads Conversion Label}}');

// The CSV export shares suggestionToGroup, so the Ads ids ride along with no column change.
const adsCsv = suggestionsToTemplateCsv([adsReal]).split('\r\n');
check('ads csv: identity rows land in the Parameters columns', adsCsv[1].includes('Conversion ID,AW-123456789') && adsCsv[2].includes('Conversion Label,AbC-dEfGh12_34'));
check('ads csv: still exactly the template column count', adsCsv.slice(1).filter(Boolean).every((r) => r.split(',').length === TEMPLATE_HEADERS.length));

check('ads issue: the engine-seeded placeholder id is BLOCKED', (adsIdentityIssue(adsPlaceholder) ?? '').includes('Conversion ID is still'));
check('ads issue: a resolved id + label passes', adsIdentityIssue(adsReal) === null);
check('ads issue: a bare numeric id passes', adsIdentityIssue(applyTagEdit(adsReal, { measurementId: '123456789' })) === null);
check('ads issue: an empty label is BLOCKED', (adsIdentityIssue(applyTagEdit(adsReal, { conversionLabel: '   ' })) ?? '').includes('Conversion Label is empty'));
check('ads issue: a placeholder label alone is BLOCKED', (adsIdentityIssue(applyTagEdit(adsReal, { conversionLabel: '{{Google Ads Conversion Label}}' })) ?? '').includes('Conversion Label is still'));
check('ads issue: an empty id is BLOCKED', (adsIdentityIssue(applyTagEdit(adsReal, { measurementId: '' })) ?? '').includes('Conversion ID is empty'));
check('ads issue: a non-id string is BLOCKED', (adsIdentityIssue(applyTagEdit(adsReal, { measurementId: 'G-ABC123' })) ?? '').includes('not a Google Ads conversion id'));
// The whole "AW-123456789/AbCdEf" string pasted into the LABEL is the classic copy/paste slip: the
// label alone is wanted, and a slash silently mis-attributes the conversion.
check('ads issue: the combined AW-id/label pasted into the label is BLOCKED', (adsIdentityIssue(applyTagEdit(adsReal, { conversionLabel: 'AW-123456789/AbCdEf' })) ?? '').includes('paste only the label'));
check('ads issue: a label with a stray space is BLOCKED', (adsIdentityIssue(applyTagEdit(adsReal, { conversionLabel: 'AbC dEf' })) ?? '').includes('paste only the label'));
check('ads issue: remarketing needs no label', adsIdentityIssue(adsRemarketing) === null);
check('ads issue: remarketing still validates its id', adsIdentityIssue(applyTagEdit(adsRemarketing, { measurementId: '{{Google Ads Conversion ID}}' })) !== null);
// A user's OWN Constant is a legitimate setup, so it must not be blocked - only the engine's two
// un-provisioned defaults are.
check('ads issue: a user-supplied {{variable}} is allowed through', adsIdentityIssue(applyTagEdit(adsReal, { measurementId: '{{My Ads ID}}', conversionLabel: '{{My Ads Label}}' })) === null);
// The waiver is for a value that is EXACTLY one reference. A substring test used to wave these through,
// and they reach the awct template verbatim because normalizeAdsConversionId passes any {{ through.
check('ads issue: "AW-{{suffix}}" is NOT a variable reference and is blocked', adsIdentityIssue(applyTagEdit(adsReal, { measurementId: 'AW-{{suffix}}' })) !== null);
check('ads issue: "G-ABC123 {{x}}" is blocked', adsIdentityIssue(applyTagEdit(adsReal, { measurementId: 'G-ABC123 {{x}}' })) !== null);
check('ads issue: "not an id {{x}}" is blocked', adsIdentityIssue(applyTagEdit(adsReal, { measurementId: 'not an id {{x}}' })) !== null);
// The combined send_to string with a variable label is exactly what the slash check exists to catch.
check('ads issue: "AW-123456789/{{Label}}" in the label is blocked', (adsIdentityIssue(applyTagEdit(adsReal, { conversionLabel: 'AW-123456789/{{Label}}' })) ?? '').includes('paste only the label'));
check('ads issue: two references in the label are blocked', adsIdentityIssue(applyTagEdit(adsReal, { conversionLabel: '{{A}} {{B}}' })) !== null);
// Switching a GA4 row's Tag Type carries measurementId across (applyTagEdit), so the Ads row would
// otherwise arrive holding a G- measurement id with nothing objecting. Remarketing takes no label, so
// it is the path that needs no further input at all.
const switchedRm = applyTagEdit(base({ id: 'sw', platform: 'ga4_event', measurementId: '{{GA4 Measurement ID}}', tagName: 'GA4 - X', eventName: 'x', trigger: { name: 'T', kind: 'all_clicks' } }), { platform: 'google_ads_remarketing' });
check('ads issue: a GA4 measurement-id variable carried in by a Tag Type switch is BLOCKED', (adsIdentityIssue(switchedRm) ?? '').includes('different platform'));
const switchedConv = applyTagEdit(base({ id: 'sw2', platform: 'ga4_event', measurementId: '{{Meta Pixel ID}}', tagName: 'M', eventName: 'x', trigger: { name: 'T', kind: 'all_clicks' } }), { platform: 'google_ads_conversion', conversionLabel: 'AbCdEf' });
check('ads issue: a Meta pixel variable carried in by a Tag Type switch is BLOCKED', (adsIdentityIssue(switchedConv) ?? '').includes('different platform'));
check('ads issue: a non-Ads platform is never blocked', adsIdentityIssue(phone) === null && adsIdentityIssue(gtag) === null && adsIdentityIssue(metaPixel) === null);
// Repo rule: no em dashes at any output boundary, and these strings surface in the UI.
const adsMessages = [adsPlaceholder, applyTagEdit(adsReal, { conversionLabel: '' }), applyTagEdit(adsReal, { measurementId: 'G-ABC123' })].map((t) => adsIdentityIssue(t) ?? '');
check('ads issue: messages carry no em/en dashes', adsMessages.every((m) => m.length > 0 && !/[—–]/.test(m)));

// ── conversionActionNameFromTag: seed the Ads conversion-action name from the tag name ───────────
// The house shape is "<Vendor> - <Kind> - <Name> Tag"; both ends are GTM bookkeeping and the middle
// is what the conversion action should be called.
check('conv-name: the reported case', conversionActionNameFromTag('Google Ads - Conversion - Get A Free Consultation Form Tag') === 'Get A Free Consultation Form');
check('conv-name: keeps the kind word a human relies on', conversionActionNameFromTag('Google Ads - Conversion - Contact Us Form Tag') === 'Contact Us Form'
  && conversionActionNameFromTag('Google Ads - Conversion - Phone Click Tag') === 'Phone Click');
check('conv-name: works for the other vendors', conversionActionNameFromTag('GA4 - Event - Book A Demo Click Tag') === 'Book A Demo Click'
  && conversionActionNameFromTag('Meta - Event - Newsletter Form Tag') === 'Newsletter Form');
check('conv-name: remarketing prefix too', conversionActionNameFromTag('Google Ads - Remarketing - All Pages Tag') === 'All Pages');
check('conv-name: a name with NO prefix just loses the Tag suffix', conversionActionNameFromTag('Contact Form Tag') === 'Contact Form');
check('conv-name: an INTERNAL " - " is preserved', conversionActionNameFromTag('Google Ads - Conversion - Book A Demo - EU Tag') === 'Book A Demo - EU');
check('conv-name: case-insensitive on the boilerplate', conversionActionNameFromTag('google ads - conversion - Sample Request Form tag') === 'Sample Request Form');
check('conv-name: collapses stray whitespace', conversionActionNameFromTag('Google Ads  -  Conversion  -   Get  Started   Tag') === 'Get Started');
check('conv-name: nothing meaningful left returns empty, so the caller keeps its placeholder',
  conversionActionNameFromTag('Google Ads - Conversion - Tag') === '' && conversionActionNameFromTag('Tag') === '');
check('conv-name: empty / missing input is safe', conversionActionNameFromTag('') === '' && conversionActionNameFromTag(undefined) === '');
check('conv-name: does NOT strip a word that merely contains "tag"', conversionActionNameFromTag('Google Ads - Conversion - Tag Manager Signup Tag') === 'Tag Manager Signup');

// Guard against silently deleting assertions from this file.
if (passed < 100) { console.error(`✗ only ${passed} assertions ran (expected 100+)`); process.exit(1); }
console.log(`\ntag-template: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
