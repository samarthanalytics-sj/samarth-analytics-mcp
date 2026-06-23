/**
 * Tests the safe tag-parameter editing helpers (read-modify-write merge +
 * eventSettingsTable append). Run: tsx src/__tests__/tag-params.test.ts
 */
import { addEventParameters, mergeParametersByKey } from '../utils/tagParams.js';
import type { tagmanager_v2 } from 'googleapis';

type Tag = tagmanager_v2.Schema$Tag;
type Param = tagmanager_v2.Schema$Parameter;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const estOf = (t: Tag): Param | undefined => (t.parameter ?? []).find((p) => p.key === 'eventSettingsTable');
const paramNames = (t: Tag): (string | null | undefined)[] => (estOf(t)?.list ?? []).map((m) => (m.map ?? []).find((x) => x.key === 'parameter')?.value);
const valueOf = (t: Tag, name: string): string | null | undefined => {
  const row = (estOf(t)?.list ?? []).find((m) => (m.map ?? []).find((x) => x.key === 'parameter')?.value === name);
  return (row?.map ?? []).find((x) => x.key === 'parameterValue')?.value;
};

// A realistic gaawe tag (matches what the create path produces).
const ga4Tag: Tag = {
  name: 'GA4 Event - Email Click Tag',
  type: 'gaawe',
  fingerprint: 'fp1',
  firingTriggerId: ['10'],
  parameter: [
    { type: 'tagReference', key: 'measurementId', value: '' },
    { type: 'template', key: 'measurementIdOverride', value: '{{GA4 Measurement ID}}' },
    { type: 'template', key: 'eventName', value: 'email_click' },
    { type: 'boolean', key: 'sendEcommerceData', value: 'false' },
    { type: 'list', key: 'eventSettingsTable', list: [
      { type: 'map', map: [{ type: 'template', key: 'parameter', value: 'click_text' }, { type: 'template', key: 'parameterValue', value: '{{Click Text}}' }] },
    ] },
  ],
};

// ── addEventParameters: append, preserve the rest ────────────────────────────
const out = addEventParameters(ga4Tag, [{ name: 'page_path', value: '{{Page Path}}' }, { name: 'previous_page', value: '{{Referrer}}' }]);
check('addEvent: eventName preserved (the bug — must NOT be wiped)', (out.parameter ?? []).find((p) => p.key === 'eventName')?.value === 'email_click');
check('addEvent: measurementIdOverride preserved', (out.parameter ?? []).find((p) => p.key === 'measurementIdOverride')?.value === '{{GA4 Measurement ID}}');
check('addEvent: measurementId tagReference + sendEcommerceData preserved', (out.parameter ?? []).some((p) => p.key === 'measurementId' && p.type === 'tagReference') && (out.parameter ?? []).some((p) => p.key === 'sendEcommerceData'));
check('addEvent: firingTriggerId + name preserved', JSON.stringify(out.firingTriggerId) === JSON.stringify(['10']) && out.name === 'GA4 Event - Email Click Tag');
check('addEvent: eventSettingsTable now has click_text + page_path + previous_page', (() => { const n = paramNames(out); return n.includes('click_text') && n.includes('page_path') && n.includes('previous_page') && n.length === 3; })());
check('addEvent: new param value is the GTM variable as given', valueOf(out, 'page_path') === '{{Page Path}}');

// ── creates eventSettingsTable when the tag has none ─────────────────────────
const bare: Tag = { name: 't', type: 'gaawe', parameter: [{ type: 'template', key: 'eventName', value: 'x' }] };
const out2 = addEventParameters(bare, [{ name: 'user_id', value: '{{user_id}}' }]);
check('addEvent: creates eventSettingsTable when absent + keeps eventName', !!estOf(out2) && (estOf(out2)?.list ?? []).length === 1 && (out2.parameter ?? []).some((p) => p.key === 'eventName'));

// ── a param name that already exists has its VALUE updated (no duplicate) ─────
const out3 = addEventParameters(out, [{ name: 'click_text', value: '{{New Click Text}}' }]);
check('addEvent: existing param name updates value, not duplicated', paramNames(out3).filter((n) => n === 'click_text').length === 1 && valueOf(out3, 'click_text') === '{{New Click Text}}');

// ── purity: the input tag is never mutated ───────────────────────────────────
check('addEvent: input tag is NOT mutated (pure)', (estOf(ga4Tag)?.list ?? []).length === 1 && paramNames(ga4Tag).length === 1);

// ── mergeParametersByKey ─────────────────────────────────────────────────────
const existing: Param[] = [
  { type: 'tagReference', key: 'measurementId', value: '' },
  { type: 'template', key: 'eventName', value: 'e' },
  { type: 'list', key: 'eventSettingsTable', list: [] },
];
const m = mergeParametersByKey(existing, [{ type: 'list', key: 'eventSettingsTable', list: [{ type: 'map', map: [] }] }]);
check('merge: a same-key param REPLACES, the rest are KEPT', m.length === 3 && m.find((p) => p.key === 'eventName')?.value === 'e' && (m.find((p) => p.key === 'eventSettingsTable')?.list ?? []).length === 1);
const m2 = mergeParametersByKey(existing, [{ type: 'template', key: 'newKey', value: 'v' }]);
check('merge: a new key is ADDED, every existing key kept (nothing wiped)', m2.length === 4 && m2.some((p) => p.key === 'newKey') && m2.some((p) => p.key === 'measurementId') && m2.some((p) => p.key === 'eventName'));

console.log(`\ntag-params: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
