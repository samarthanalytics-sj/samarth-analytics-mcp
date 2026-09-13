// Pure tests for the review-panel tag-split logic (ONE multi-page form tag into one tag PER page).
// The exact inverse of tag-merge.test.ts. Run: tsx src/shared/__tests__/tag-split.test.ts

import { splittableFormPages, splitFormByPage, pageTagLabel, MAX_SPLIT_PAGES } from '../tag-split';
import { dedupeViewsByGtmName, suggestionDedupKey, triggerWhens } from '../tag-template';
import { findMergeGroups, mergeGroup } from '../tag-merge';
import type { SuggestedTagView } from '../ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' : ' + detail : ''}`); }
}

// The real ChowNow shape: one HubSpot demo form found on seven landing pages, scoped by the engine's
// anchored {{Page Path}} alternation.
const PAGES = ['/demo', '/get-started', '/pricing', '/restaurant-online-ordering', '/contact-sales', '/marketing', '/'];
const pageRegex = (pages: string[]): string => `^(${pages.join('|')})/?$`;

const form = (over: Partial<SuggestedTagView> = {}): SuggestedTagView => ({
  id: 'form-demo',
  page: 'site-wide',
  label: 'Request a demo form (7 pages) -> GA4 "generate_lead"',
  evidence: 'the same demo form was found on 7 pages',
  note: 'This form has no unique id, so it is scoped by {{Page Path}}.',
  confidence: 'medium',
  enhancedMeasurementOverlap: false,
  platform: 'ga4_event',
  measurementId: '{{GA4 Measurement ID}}',
  tagName: 'GA4 - Event - Request A Demo Form Tag',
  eventName: 'generate_lead',
  eventParameters: [{ name: 'form_name', value: 'Request A Demo' }],
  trigger: {
    name: 'Request A Demo Form Submit Trigger',
    kind: 'form_submit',
    pagePathValue: pageRegex(PAGES),
    pagePathOperator: 'matchRegex',
  },
  ...over,
});

// -- splittableFormPages: what qualifies ------------------------------------------------------
const pages = splittableFormPages(form());
check('the 7-page ChowNow RegEx yields its 7 page paths, in regex order',
  pages.length === 7 && JSON.stringify(pages) === JSON.stringify(PAGES), JSON.stringify(pages));

check('a custom_event form tag (shared form_submission dataLayer event) splits too', splittableFormPages(form({
  trigger: { name: 'Form Submission Trigger', kind: 'custom_event', eventName: 'form_submission', pagePathValue: pageRegex(['/demo', '/pricing']), pagePathOperator: 'matchRegex' },
})).length === 2);

check('a ONE member alternation does not split (nothing to separate)',
  splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: pageRegex(['/demo']), pagePathOperator: 'matchRegex' } })).length === 0);

check('a plain (non alternation) page path does not split',
  splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: '/demo', pagePathOperator: 'contains' } })).length === 0);

check('a matchRegex value that is not the anchored alternation shape does not split',
  splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: '/demo|/pricing', pagePathOperator: 'matchRegex' } })).length === 0);

check('a WILDCARD member is refused: an "equals" row built from /blog/.* could never fire',
  splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: '^(/blog/.*|/news)/?$', pagePathOperator: 'matchRegex' } })).length === 0);

check('a member that is not an absolute path is refused (the RegEx was not built from a page list)',
  splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: '^(demo|/news)/?$', pagePathOperator: 'matchRegex' } })).length === 0);

// The engine regex-escapes each path, so a real dot in a path arrives as "\." and must come back out.
check('escaped members are unescaped back to their literal path',
  JSON.stringify(splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: '^(/a\\.b|/c\\-d)/?$', pagePathOperator: 'matchRegex' } }))) === JSON.stringify(['/a.b', '/c-d']));

check('a search bar suggestion NEVER splits: it scopes on {{Page URL}}, not on a page list',
  splittableFormPages(form({ trigger: { name: 'Site Search Trigger', kind: 'pageview', pageUrlValue: '?s=', pageUrlOperator: 'contains' } })).length === 0);

check('even a form_submit row carrying a {{Page URL}} condition is left alone',
  splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: pageRegex(PAGES), pagePathOperator: 'matchRegex', pageUrlValue: '?s=', pageUrlOperator: 'contains' } })).length === 0);

check('a click tag with the same page RegEx does not split (the kind is not form shaped)',
  splittableFormPages(form({ trigger: { name: 'T', kind: 'all_clicks', clickTextValue: 'Demo', clickTextOperator: 'equals', pagePathValue: pageRegex(PAGES), pagePathOperator: 'matchRegex' } })).length === 0);

const many = Array.from({ length: MAX_SPLIT_PAGES + 1 }, (_, i) => `/p${i}`);
check(`more than ${MAX_SPLIT_PAGES} pages stays ONE common tag (a site wide form should not become 26 tags)`,
  splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: pageRegex(many), pagePathOperator: 'matchRegex' } })).length === 0);

check('duplicate members collapse before the count is judged',
  JSON.stringify(splittableFormPages(form({ trigger: { name: 'T', kind: 'form_submit', pagePathValue: pageRegex(['/demo', '/demo', '/pricing']), pagePathOperator: 'matchRegex' } }))) === JSON.stringify(['/demo', '/pricing']));

// -- splitFormByPage: the produced rows --------------------------------------------------------
const rows = splitFormByPage(form(), pages);
check('7 pages produce 7 rows', rows.length === 7, String(rows.length));
check('every row is scoped to its OWN single page with "equals" (no RegEx left behind)',
  rows.every((r, i) => r.trigger.pagePathValue === PAGES[i] && r.trigger.pagePathOperator === 'equals' && r.page === PAGES[i]));
check('every row keeps the tag identity: platform, event, measurement id, parameters',
  rows.every((r) => r.platform === 'ga4_event' && r.eventName === 'generate_lead' && r.measurementId === '{{GA4 Measurement ID}}' && r.eventParameters?.[0]?.name === 'form_name'));
check('every row has a DISTINCT id', new Set(rows.map((r) => r.id)).size === 7);
check('every row has a DISTINCT tag name', new Set(rows.map((r) => r.tagName)).size === 7);
// The create flow reuses TRIGGERS by name: one shared name would wire all 7 tags to whichever page's
// trigger was created first, and 6 of them would fire on the wrong page.
check('every row has a DISTINCT trigger name', new Set(rows.map((r) => r.trigger.name)).size === 7);
check('the tag name is readable and derived from the page path',
  rows[0].tagName === 'GA4 - Event - Request A Demo Form - Demo Tag' && rows[1].tagName === 'GA4 - Event - Request A Demo Form - Get Started Tag',
  rows[1].tagName);
check('the trigger name is derived the same way and keeps the "Trigger" suffix',
  rows[1].trigger.name === 'Request A Demo Form Submit - Get Started Trigger', rows[1].trigger.name);
check('the homepage path gets a readable name instead of an empty one',
  rows[6].tagName === 'GA4 - Event - Request A Demo Form - Home Tag' && pageTagLabel('/') === 'Home', rows[6].tagName);
check('the stale "(7 pages)" claim is dropped from the row label, and the page is named instead',
  !/pages/i.test(rows[0].label) && rows[0].label.includes('(/demo)'), rows[0].label);
check('the evidence says where the row came from and what it now fires on',
  rows[0].evidence.includes('7 pages') && rows[0].evidence.includes('/demo'));
// Never claim a scope is durable without evidence: "equals" will not match a trailing slash, so the
// row says so and names the fix instead of pretending.
check('the note warns that "equals" misses a trailing slash and names the RegEx fix',
  rows[0].note!.includes('matches RegEx') && rows[0].note!.includes('/?$'));
check('the original note is carried, not silently dropped', rows[0].note!.includes('no unique id'));
check('the projected trigger condition reads back as {{Page Path}} equals <path>',
  triggerWhens(rows[3]).some((w) => w.variable === '{{Page Path}}' && w.condition === 'equals' && w.value === PAGES[3]));

// -- names survive the review table's dedup ----------------------------------------------------
check('the 7 rows survive suggestionDedupKey without collapsing', dedupeViewsByGtmName(rows).length === 7);
check('every dedup key is distinct', new Set(rows.map((r) => suggestionDedupKey(r))).size === 7);
// suggestionDedupKey folds every non alphanumeric run to a space, so "/get-started" and
// "/get_started" would normalize onto ONE row without the disambiguation suffix.
const twins = splitFormByPage(form(), ['/get-started', '/get_started']);
check('paths that normalize to the same words still get distinct, non colliding names',
  twins.length === 2 && dedupeViewsByGtmName(twins).length === 2 && suggestionDedupKey(twins[0]) !== suggestionDedupKey(twins[1]),
  twins.map((t) => t.tagName).join(' | '));

// -- safety: never drop a row, always deterministic ---------------------------------------------
check('nothing to split returns the ORIGINAL row untouched (a suggestion is never dropped)',
  splitFormByPage(form(), ['/demo']).length === 1 && splitFormByPage(form(), []).length === 1 && splitFormByPage(form(), [])[0].id === 'form-demo');
check('duplicate pages passed in are collapsed', splitFormByPage(form(), ['/demo', '/demo', '/pricing']).length === 2);
check('the same input produces byte identical output (stable ids and names)',
  JSON.stringify(splitFormByPage(form(), pages)) === JSON.stringify(rows));

// A proof screenshot belongs to ONE page: carrying it onto every row would show evidence from a
// different page than the row claims to track.
const shot = splitFormByPage(form({ page: '/pricing', screenshot: 'data:image/jpeg;base64,AAA' }), ['/demo', '/pricing']);
check('the proof screenshot rides only the row whose page it was taken on',
  shot[0].screenshot === undefined && shot[1].screenshot === 'data:image/jpeg;base64,AAA');

// -- no em dashes anywhere in the produced text -------------------------------------------------
const DASHES = /[\u2010-\u2015\u2212]/;
const emitted = rows.flatMap((r) => [r.tagName, r.trigger.name, r.label, r.evidence, r.note ?? '', r.id, r.page]);
check('no em dash (or any unicode dash) in any produced name, label, evidence or note',
  emitted.every((v) => !DASHES.test(v)), emitted.find((v) => DASHES.test(v)));
const dashy = splitFormByPage(form({ tagName: 'GA4 - Event - Demo \u2014 EU Form Tag', note: 'add an id \u2014 then use {{Form ID}}' }), ['/demo', '/pricing']);
check('a unicode dash arriving from the engine is folded out of the produced name and note',
  dashy.every((r) => !DASHES.test(r.tagName) && !DASHES.test(r.note ?? '')), dashy[0].tagName);

// -- round trip with tag-merge ------------------------------------------------------------------
// Split rows are page scoped form tags; tag-merge only groups pure {{Click Text}} equals click tags.
// The two features must never fight over the same rows.
check('split rows are NOT mergeable by findMergeGroups (different shape entirely)',
  findMergeGroups(rows).length === 0);
const cta = (id: string, text: string): SuggestedTagView => form({
  id, page: '/', label: '', evidence: '', note: undefined, eventName: 'learn_more_click',
  tagName: `GA4 - Event - ${text} Click Tag`,
  trigger: { name: `${text} Click Trigger`, kind: 'all_clicks', clickTextValue: text, clickTextOperator: 'equals' },
});
const merged = mergeGroup(findMergeGroups([cta('a', 'Learn More'), cta('b', 'LEARN MORE')])[0]);
check('a MERGED click tag is not splittable (it has no page list to separate)',
  splittableFormPages(merged).length === 0);

// Guard against silently deleting assertions from this file.
if (passed < 30) { console.error(`x only ${passed} assertions ran (expected 30+)`); process.exit(1); }
console.log(`\ntag-split: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
