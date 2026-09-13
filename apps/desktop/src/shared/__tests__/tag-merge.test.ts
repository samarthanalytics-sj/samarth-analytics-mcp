// Pure tests for the review-panel tag-merge logic (same-event click tags → one merged tag).
// Run: tsx src/shared/__tests__/tag-merge.test.ts

import { findMergeGroups, mergeGroup, mergeLabel } from '../tag-merge';
import type { SuggestedTagView } from '../ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const cta = (id: string, text: string, over: Partial<SuggestedTagView> = {}): SuggestedTagView => ({
  id, page: '/', label: '', evidence: '', confidence: 'medium',
  enhancedMeasurementOverlap: false, platform: 'ga4_event', measurementId: '{{GA4 Measurement ID}}',
  tagName: `GA4 - Event - ${text} Click Tag`, eventName: 'learn_more_click',
  eventParameters: [{ name: 'click_text', value: '{{Click Text}}' }],
  trigger: { name: `${text} Click Trigger`, kind: 'all_clicks', clickTextValue: text, clickTextOperator: 'equals' },
  ...over,
});

// ── findMergeGroups ──────────────────────────────────────────────────────────
const groups = findMergeGroups([cta('a', 'Learn More'), cta('b', 'LEARN MORE'), cta('c', 'Buy now', { eventName: 'buy_now_click' })]);
check('detects ONE group: two same-event click-text tags (the different-event tag stays out)',
  groups.length === 1 && groups[0].eventName === 'learn_more_click' && groups[0].tags.length === 2 && groups[0].texts.length === 2);

check('no group for a single tag per event', findMergeGroups([cta('a', 'Learn More'), cta('c', 'Buy now', { eventName: 'buy_now_click' })]).length === 0);

check('tags with an extra trigger scope are NOT mergeable (clickUrl / clickElement / page conditions)', findMergeGroups([
  cta('a', 'Learn More'),
  cta('b', 'LEARN MORE', { trigger: { name: 'T', kind: 'all_clicks', clickTextValue: 'LEARN MORE', clickTextOperator: 'equals', clickUrlValue: '/x' } }),
]).length === 0);

check('a contains/regex click-text tag is NOT mergeable (only equals)', findMergeGroups([
  cta('a', 'Learn More'),
  cta('b', 'Learn', { trigger: { name: 'T', kind: 'all_clicks', clickTextValue: 'Learn', clickTextOperator: 'contains' } }),
]).length === 0);

check('different trigger kinds are separate groups (not merged across kinds)', findMergeGroups([
  cta('a', 'Download brochure', { eventName: 'file_download', trigger: { name: 'T1', kind: 'link_click', clickTextValue: 'Download brochure', clickTextOperator: 'equals' } }),
  cta('b', 'Download brochure 2', { eventName: 'file_download' }),
]).length === 0);

// ── mergeGroup ───────────────────────────────────────────────────────────────
const merged = mergeGroup(groups[0]);
// The trigger name is deliberately DISTINCT from the per-variant "<Label> Click Trigger" convention:
// the create flow reuses triggers by NAME, and a collision would silently wire the merged tag to a
// pre-existing one-variant equals trigger.
check('merged: common tag name from the shared event; trigger gets the distinct "Variants" name',
  merged.tagName === 'GA4 - Event - Learn More Click Tag' && merged.trigger.name === 'Learn More Variants Click Trigger' && mergeLabel('learn_more_click') === 'Learn More');
// The trigger is the classic GTM LOOKUP TABLE grouping pattern (corpus: "CTA Lookup Variable"): each
// exact variant is its own explicit row (lookup matching is case-sensitive), the condition reads the
// companion variable — no click-text regex at all.
check('merged: trigger fires on the companion Lookup Table ({{Lookup - <Label> Variants}} equals true) with each variant an exact row',
  merged.trigger.lookupTable?.name === 'Lookup - Learn More Variants' &&
  JSON.stringify(merged.trigger.lookupTable?.texts) === JSON.stringify(['Learn More', 'LEARN MORE']) &&
  !merged.trigger.clickTextValue && !merged.trigger.clickTextOperator);
check('merged: keeps the event + kind + a fresh stable id', merged.eventName === 'learn_more_click' && merged.trigger.kind === 'all_clicks' && merged.id === 'merged:learn_more_click:all_clicks');
check('merged: evidence lists the variants; note explains the auto-created lookup variable',
  /"Learn More", "LEARN MORE"/.test(merged.evidence) && /Lookup - Learn More Variants/.test(merged.note ?? ''));

// Genuinely different texts each become their own lookup row, verbatim (no escaping needed).
const diff = findMergeGroups([
  cta('a', 'Learn more'),
  cta('b', 'Find out more? (now)', { trigger: { name: 'T', kind: 'all_clicks', clickTextValue: 'Find out more? (now)', clickTextOperator: 'equals' } }),
]);
const mergedDiff = mergeGroup(diff[0]);
check('merged: different texts → one lookup row per text, verbatim (regex specials stay literal)',
  JSON.stringify(mergedDiff.trigger.lookupTable?.texts) === JSON.stringify(['Learn more', 'Find out more? (now)']));

// Page + confidence + EM semantics.
const cross = mergeGroup(findMergeGroups([cta('a', 'Learn More', { page: '/x' }), cta('b', 'LEARN MORE', { page: '/y', confidence: 'high' })])[0]);
check('merged: different pages → site-wide; confidence = max of the group', cross.page === 'site-wide' && cross.confidence === 'high');
const em = mergeGroup(findMergeGroups([
  cta('a', 'Download brochure', { eventName: 'file_download', enhancedMeasurementOverlap: true }),
  cta('b', 'Download datasheet', { eventName: 'file_download', enhancedMeasurementOverlap: true, trigger: { name: 'T', kind: 'all_clicks', clickTextValue: 'Download datasheet', clickTextOperator: 'equals' } }),
])[0]);
check('merged: EM-overlap carries through (file_download group stays flagged) + label "File Download"',
  em.enhancedMeasurementOverlap === true && em.tagName === 'GA4 - Event - File Download Click Tag');

console.log(failures.join('\n'));
console.log(`\ntag-merge: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
