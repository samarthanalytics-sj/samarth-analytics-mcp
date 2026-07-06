// Pure tests for the "GTM Structure - GA4 Events" template mapping (the table view
// + CSV download share this). Run: tsx src/shared/__tests__/tag-template.test.ts

import { suggestionToGroup, suggestionsToTemplateCsv, triggerWhens, dedupeViewsByGtmName, TEMPLATE_HEADERS, applyTagEdit, applyWhensToTrigger, conditionToOperator, CONDITION_LABELS } from '../tag-template';
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

console.log(`\ntag-template: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
