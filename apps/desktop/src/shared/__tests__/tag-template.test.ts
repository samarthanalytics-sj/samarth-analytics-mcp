// Pure tests for the "GTM Structure - GA4 Events" template mapping (the table view
// + CSV download share this). Run: tsx src/shared/__tests__/tag-template.test.ts

import { suggestionToGroup, suggestionsToTemplateCsv, triggerWhens, TEMPLATE_HEADERS } from '../tag-template';
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
check('when: link_click clickUrl startsWith → {{Click URL}} / "Starts with" / value', pw.length === 1 && pw[0].variable === '{{Click URL}}' && pw[0].condition === 'Starts with' && pw[0].value === 'tel:');

const form = base({
  id: 'f', tagName: 'GA4 Event - Search Form Tag', eventName: 'search',
  eventParameters: [{ name: 'form_id', value: '{{Form ID}}' }],
  trigger: { name: 'Search Form Trigger', kind: 'form_submit', formIdValue: 'searchForm', formIdOperator: 'equals' },
});
check('when: form_submit formId equals → {{Form ID}} / "equals to" / value', triggerWhens(form)[0].condition === 'equals to' && triggerWhens(form)[0].variable === '{{Form ID}}');

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

// ── CSV layout ───────────────────────────────────────────────────────────────
const csv = suggestionsToTemplateCsv([phone]);
const rows = csv.split('\r\n');
check('csv: header is the template columns', rows[0] === TEMPLATE_HEADERS.join(','));
check('csv: ends with a trailing CRLF', csv.endsWith('\r\n'));
check('csv: tag block first row carries tag + trigger + param[0] + when[0]',
  rows[1] === 'GA4 Event Tag,GA4 Event - Phone Click Tag,phone_click,click_text,{{Click Text}},Phone Click Trigger,Click - Just Links,{{Click URL}},Starts with,tel:');
check('csv: subsequent param rows leave tag/trigger/when columns blank', rows[2] === ',,,click_url,{{Click URL}},,,,,' && rows[3] === ',,,page_path,{{Page Path}},,,,,');
check('csv: every data row has exactly 10 columns', rows.slice(1).filter(Boolean).every((r) => r.split(',').length === TEMPLATE_HEADERS.length));

// ── RFC-4180 escaping (comma / quote in a value) ─────────────────────────────
const comma = base({ id: 'c', trigger: { name: 'T', kind: 'all_clicks', clickTextValue: 'play, pause', clickTextOperator: 'equals' }, eventParameters: [{ name: 'a', value: 'b' }] });
const crows = suggestionsToTemplateCsv([comma]).split('\r\n');
check('csv: a value containing a comma is quoted', crows[1].includes('"play, pause"'));

// ── multiple tags → multiple blocks, YouTube event name with {{}} preserved ──
const multi = suggestionsToTemplateCsv([phone, yt]);
check('csv: multiple suggestions produce multiple blocks', multi.includes('GA4 Event - Phone Click Tag') && multi.includes('GA4 Event - YouTube Video Tag') && multi.includes('video_{{Video Status}}'));

console.log(`\ntag-template: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
