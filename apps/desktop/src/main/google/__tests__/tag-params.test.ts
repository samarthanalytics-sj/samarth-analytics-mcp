/** Desktop tag-parameter helpers: read-modify-write merge + eventSettingsTable append.
 *  Run: tsx src/main/google/__tests__/tag-params.test.ts */
import { addEventParameters, addUserProperties, mergeParametersByKey, setTemplateParam, type GtmParam } from '../tag-params';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean): void => {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}`); }
};

const params = (t: Record<string, unknown>): GtmParam[] => (t.parameter as GtmParam[] | undefined) ?? [];
const est = (t: Record<string, unknown>): GtmParam | undefined => params(t).find((p) => p.key === 'eventSettingsTable');
const names = (t: Record<string, unknown>): (string | undefined)[] =>
  (est(t)?.list ?? []).map((m) => (m.map ?? []).find((x) => x.key === 'parameter')?.value);
const valueOf = (t: Record<string, unknown>, n: string): string | undefined => {
  const row = (est(t)?.list ?? []).find((m) => (m.map ?? []).find((x) => x.key === 'parameter')?.value === n);
  return (row?.map ?? []).find((x) => x.key === 'parameterValue')?.value;
};

// A realistic gaawe tag, like the desktop create path produces.
const ga4: Record<string, unknown> = {
  name: 'GA4 Event - Email Click', type: 'gaawe', firingTriggerId: ['10'],
  parameter: [
    { type: 'tagReference', key: 'measurementId', value: '' },
    { type: 'template', key: 'measurementIdOverride', value: '{{GA4 Measurement ID}}' },
    { type: 'template', key: 'eventName', value: 'email_click' },
    { type: 'list', key: 'eventSettingsTable', list: [
      { type: 'map', map: [{ type: 'template', key: 'parameter', value: 'click_text' }, { type: 'template', key: 'parameterValue', value: '{{Click Text}}' }] },
    ] },
  ],
};

const out = addEventParameters(ga4, [{ name: 'session_id', value: '{{session_id}}' }, { name: 'user_id', value: '{{user_id}}' }]);
check('measurementIdOverride preserved (the "must not be empty" bug)', params(out).find((p) => p.key === 'measurementIdOverride')?.value === '{{GA4 Measurement ID}}');
check('eventName preserved', params(out).find((p) => p.key === 'eventName')?.value === 'email_click');
check('firingTriggerId + name preserved', JSON.stringify((out.firingTriggerId as string[])) === JSON.stringify(['10']) && out.name === 'GA4 Event - Email Click');
check('event params appended to existing table', (() => { const n = names(out); return n.includes('click_text') && n.includes('session_id') && n.includes('user_id') && n.length === 3; })());
check('new param value as given', valueOf(out, 'user_id') === '{{user_id}}');

const bare: Record<string, unknown> = { name: 't', type: 'gaawe', parameter: [{ type: 'template', key: 'eventName', value: 'x' }] };
const out2 = addEventParameters(bare, [{ name: 'page_path', value: '{{Page Path}}' }]);
check('creates eventSettingsTable when absent, keeps eventName', !!est(out2) && (est(out2)?.list ?? []).length === 1 && params(out2).some((p) => p.key === 'eventName'));

const out3 = addEventParameters(out, [{ name: 'click_text', value: '{{New}}' }]);
check('existing param name updates value, not duplicated', names(out3).filter((n) => n === 'click_text').length === 1 && valueOf(out3, 'click_text') === '{{New}}');

check('input tag not mutated (pure)', (est(ga4)?.list ?? []).length === 1 && names(ga4).length === 1);

const existing: GtmParam[] = [
  { type: 'tagReference', key: 'measurementId', value: '' },
  { type: 'template', key: 'eventName', value: 'e' },
];
const m = mergeParametersByKey(existing, [{ type: 'template', key: 'eventName', value: 'NEW' }, { type: 'template', key: 'addedKey', value: 'v' }]);
check('merge: same key replaced, new key added, untouched kept', m.length === 3 && m.find((p) => p.key === 'eventName')?.value === 'NEW' && m.some((p) => p.key === 'measurementId') && m.some((p) => p.key === 'addedKey'));

// ── setTemplateParam: point measurementIdOverride at a {{Variable}}, preserve rest ──
const sm = setTemplateParam(ga4, 'measurementIdOverride', '{{GA4 Variable}}');
check('setTemplateParam: measurementIdOverride updated to the variable', params(sm).find((p) => p.key === 'measurementIdOverride')?.value === '{{GA4 Variable}}' && params(sm).find((p) => p.key === 'measurementIdOverride')?.type === 'template');
check('setTemplateParam: eventName + measurementId tagReference + event table preserved', params(sm).some((p) => p.key === 'eventName' && p.value === 'email_click') && params(sm).some((p) => p.key === 'measurementId' && p.type === 'tagReference') && !!est(sm));
check('setTemplateParam: adds the key when absent (googtag tagId)', (() => { const g = setTemplateParam({ type: 'googtag', parameter: [] }, 'tagId', '{{GA4 Variable}}'); return (g.parameter as GtmParam[])[0]?.key === 'tagId' && (g.parameter as GtmParam[])[0]?.value === '{{GA4 Variable}}'; })());
check('setTemplateParam: input not mutated (pure)', params(ga4).find((p) => p.key === 'measurementIdOverride')?.value === '{{GA4 Measurement ID}}');

// ── addUserProperties: user-SCOPED, separate `userProperties` list keyed name/value ──
const up = (t: Record<string, unknown>): GtmParam | undefined => params(t).find((p) => p.key === 'userProperties');
const upNames = (t: Record<string, unknown>): (string | undefined)[] =>
  (up(t)?.list ?? []).map((m) => (m.map ?? []).find((x) => x.key === 'name')?.value);
const upValue = (t: Record<string, unknown>, n: string): string | undefined => {
  const row = (up(t)?.list ?? []).find((m) => (m.map ?? []).find((x) => x.key === 'name')?.value === n);
  return (row?.map ?? []).find((x) => x.key === 'value')?.value;
};

const wp = addUserProperties(ga4, [{ name: 'user_id', value: '{{User ID}}' }, { name: 'membership_tier', value: '{{Tier}}' }]);
check('user properties added to a NEW userProperties list (name/value shape)', upNames(wp).includes('user_id') && upNames(wp).includes('membership_tier') && (up(wp)?.list ?? []).length === 2);
check('user-property map uses name/value keys (NOT parameter/parameterValue)', (up(wp)?.list?.[0]?.map ?? []).some((x) => x.key === 'name') && (up(wp)?.list?.[0]?.map ?? []).some((x) => x.key === 'value'));
check('user property value as given', upValue(wp, 'user_id') === '{{User ID}}');
check('event params + measurementIdOverride untouched by user-property add', !!est(wp) && names(wp).length === 1 && params(wp).find((p) => p.key === 'measurementIdOverride')?.value === '{{GA4 Measurement ID}}');
check('event params and user properties are SEPARATE lists', est(wp)?.key === 'eventSettingsTable' && up(wp)?.key === 'userProperties' && est(wp) !== up(wp));
const wp2 = addUserProperties(wp, [{ name: 'user_id', value: '{{New ID}}' }]);
check('existing user property name updates value, not duplicated', upNames(wp2).filter((n) => n === 'user_id').length === 1 && upValue(wp2, 'user_id') === '{{New ID}}');
check('addUserProperties is pure (input untouched)', up(ga4) === undefined);

console.log(`\ndesktop tag-params: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
