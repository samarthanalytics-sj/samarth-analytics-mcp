/** Desktop tag-parameter helpers: read-modify-write merge + eventSettingsTable append.
 *  Run: tsx src/main/google/__tests__/tag-params.test.ts */
import { addEventParameters, mergeParametersByKey, setTemplateParam, addServerGa4Params, serverGa4ParamList, SERVER_PARAM_NAME_KEY, type GtmParam } from '../tag-params';

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

// ── addServerGa4Params: epToAdd / upToAdd on a server GA4 (sgtmgaaw) tag ──
const srv: Record<string, unknown> = {
  name: 'GA4 - Add Payment Info (Server)', type: 'sgtmgaaw', firingTriggerId: ['5'],
  parameter: [
    { type: 'template', key: 'eventName', value: 'add_payment_info' },
    { type: 'template', key: 'measurementId', value: '{{GA4 MID}}' },
    { type: 'template', key: 'epToIncludeDropdown', value: 'all' },
    { type: 'template', key: 'upToIncludeDropdown', value: 'all' },
    { type: 'list', key: 'epToExclude', list: [{ type: 'map', map: [{ type: 'template', key: 'fieldName', value: 'debug_mode' }] }] },
  ],
};
const srvRows = (t: Record<string, unknown>, key: string): Array<[string | undefined, string | undefined]> =>
  (params(t).find((p) => p.key === key)?.list ?? []).map((m) => [
    (m.map ?? []).find((x) => x.key === SERVER_PARAM_NAME_KEY)?.value,
    (m.map ?? []).find((x) => x.key === 'value')?.value,
  ]);
const so = addServerGa4Params(srv, { eventParameters: [{ name: 'country', value: '{{rh - x-geo-country}}' }, { name: '', value: 'drop' }], userProperties: [{ name: 'tier', value: '{{User Tier}}' }] });
check('server: epToAdd created with name/value rows (empty-name dropped)', JSON.stringify(srvRows(so, 'epToAdd')) === JSON.stringify([['country', '{{rh - x-geo-country}}']]));
check('server: upToAdd created', JSON.stringify(srvRows(so, 'upToAdd')) === JSON.stringify([['tier', '{{User Tier}}']]));
check('server: base config + epToExclude preserved (RMW)', params(so).some((p) => p.key === 'measurementId') && params(so).some((p) => p.key === 'epToIncludeDropdown') && params(so).some((p) => p.key === 'epToExclude'));
check('server: name column uses SERVER_PARAM_NAME_KEY', (serverGa4ParamList('epToAdd', [{ name: 'a', value: 'b' }]).list?.[0]?.map ?? []).some((x) => x.key === SERVER_PARAM_NAME_KEY && x.value === 'a'));
const so2 = addServerGa4Params(so, { eventParameters: [{ name: 'country', value: '{{New Country}}' }] });
check('server: existing epToAdd name updates value, not duplicated', srvRows(so2, 'epToAdd').filter(([n]) => n === 'country').length === 1 && srvRows(so2, 'epToAdd')[0][1] === '{{New Country}}');
check('server: input tag not mutated (pure)', params(srv).find((p) => p.key === 'epToAdd') === undefined);

console.log(`\ndesktop tag-params: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
