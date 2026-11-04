import assert from 'node:assert/strict';
import { buildServerPlan, planReadiness, findStapeDataTag, findStapeDataClient, eventTriggerFor, type ListedTrigger, type ServerPlanInput } from '../server-plan';
import { buildStapeDataTag } from '../gtm-builders';
import type { AuditTag, AuditTrigger, ContainerSnapshot, ServerContainerSnapshot } from '../gtm-builders';

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

const tag = (over: Partial<AuditTag>): AuditTag => ({
  tagId: 't', name: 'Tag', type: 'gaawe', firingTriggerId: ['1'], blockingTriggerId: [], paused: false,
  parameter: [], consentSettings: null, ...over,
} as AuditTag);
const evTrigger = (id: string, event: string): AuditTrigger => ({
  triggerId: id, name: `ce - ${event}`, type: 'customEvent',
  customEventFilter: [{ type: 'equals', parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: event }] }],
  filter: [], autoEventFilter: [], parameter: [],
} as unknown as AuditTrigger);

const web = (): ContainerSnapshot => ({
  tags: [
    tag({ tagId: 'w1', name: 'GA4 - Config', type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-ABC1234' }] }),
    tag({ tagId: 'w2', name: 'Meta - Event - Lead Tag', type: 'html', firingTriggerId: ['11'], parameter: [{ type: 'template', key: 'html', value: 'fbq("track")' }] }),
    tag({ tagId: 'w3', name: 'TikTok - Event - Lead Tag', type: 'html', firingTriggerId: ['11'], parameter: [{ type: 'template', key: 'html', value: 'ttq.track' }] }),
    tag({ tagId: 'w4', name: 'Pinterest - Lead', type: 'html', firingTriggerId: ['11'], parameter: [{ type: 'template', key: 'html', value: 'pintrk("track")' }] }),
  ],
  triggers: [evTrigger('11', 'generate_lead')],
  variables: [],
});

const emptyInput = (over: Partial<ServerPlanInput> = {}): ServerPlanInput => ({
  web: web(),
  server: null,
  enabledBuiltIns: [],
  derivedMeasurementId: 'G-ABC1234',
  webGoogleTagServerUrl: '',
  ...over,
});

console.log('\nserver-plan:');

test('blank container: every baseline item missing, sensible categories, relay needs no id when derived', () => {
  const plan = buildServerPlan(emptyInput());
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  assert.equal(byId.get('ga4_client')!.status, 'missing');
  assert.equal(byId.get('ga4_client')!.category, 'critical');
  assert.equal(byId.get('ga4_relay')!.status, 'missing');
  assert.deepEqual(byId.get('ga4_relay')!.requires, [], 'derived Measurement ID -> no input needed');
  assert.ok(byId.get('ga4_relay')!.description.includes('G-ABC1234'));
  assert.deepEqual(byId.get('tagging_url')!.requires, ['serverUrl']);
  assert.equal(byId.get('web_wiring')!.status, 'missing');
  assert.ok(byId.get('ga4_client')!.defaultSelected && byId.get('ga4_relay')!.defaultSelected, 'baseline pre-checked');
});

test('CAPI items: per web pixel event; every platform executable by the app, each gated on its OWN credentials', () => {
  const plan = buildServerPlan(emptyInput());
  // Credentials are namespaced per platform now, so two vendors can both want "accessToken"
  // without colliding.
  const meta = plan.items.find((i) => i.id === 'meta_capi:generate_lead')!;
  assert.deepEqual(meta.requires, ['meta.pixelId', 'meta.accessToken']);
  assert.equal(meta.executable, true);
  assert.equal(meta.defaultSelected, false, 'credential-gated items never pre-checked');
  const tiktok = plan.items.find((i) => i.id === 'tiktok_capi:generate_lead')!;
  assert.equal(tiktok.executable, true);
  const pin = plan.items.find((i) => i.id === 'pinterest_capi:generate_lead')!;
  assert.equal(pin.executable, true, 'Pinterest is applied by the app');
  assert.deepEqual(pin.requires, ['pinterest.advertiserId', 'pinterest.accessToken']);
  assert.equal(pin.defaultSelected, false);
  const capi = plan.items.filter((i) => /_capi:/.test(i.id) && i.status === 'missing');
  assert.ok(capi.length >= 3);
  assert.ok(capi.every((i) => i.executable), 'no CAPI platform is left chat-only');
  assert.ok(capi.every((i) => i.requires.length >= 1), 'every CAPI item names the credentials it needs');
  assert.ok(capi.every((i) => i.requires.every((r) => r.startsWith(`${i.id.slice(0, i.id.indexOf('_capi:'))}.`))),
    'an item only ever asks for its OWN platform credentials');
  const linkedin = plan.items.find((i) => i.id.startsWith('linkedin_capi:'));
  if (linkedin) assert.deepEqual(linkedin.requires, [`linkedin.conversionRuleUrn@${linkedin.id.slice(linkedin.id.indexOf(':') + 1)}`, 'linkedin.accessToken'], 'LinkedIn fires on a conversion rule URN, not the web partner id');
});

test('CAPI items: GTM built-in LinkedIn Insight tag (bzi) is recognised by its native type, not by name', () => {
  const input = emptyInput();
  input.web = {
    ...(input.web ?? { tags: [], triggers: [], variables: [] }),
    tags: [tag({ tagId: 'li', name: 'Insight', type: 'bzi', firingTriggerId: ['9'], parameter: [{ key: 'id', value: '6850978' }] })],
    triggers: [evTrigger('9', 'sign_up')],
  } as ContainerSnapshot;
  const plan = buildServerPlan(input);
  const li = plan.items.find((i) => i.id === 'linkedin_capi:sign_up');
  assert.ok(li, 'a bzi tag named without "linkedin" still plans a LinkedIn CAPI item');
  assert.equal(li!.executable, true);
});

test('complete container: baseline items existing (info) and unchecked; detected values filled', () => {
  const server: ServerContainerSnapshot = {
    taggingServerUrls: ['https://sgtm.example.com'],
    clients: [
      { clientId: 'c1', name: 'GA4', type: 'gaaw_client' },
      { clientId: 'c2', name: 'GTM Web Container', type: 'gtm_client' },
    ],
    tags: [tag({ tagId: 's1', name: 'GA4 - Server', type: 'sgtmgaaw', firingTriggerId: ['90'], parameter: [{ type: 'template', key: 'measurementId', value: 'G-ABC1234' }] })],
    triggers: [{ triggerId: '90', name: 'All Events', type: 'always', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [] } as unknown as AuditTrigger],
    variables: [
      { variableId: 'v1', name: 'ed - event_id', type: 'ed', parameter: [] },
      { variableId: 'v2', name: 'ed - page_location', type: 'ed', parameter: [] },
    ],
    transformations: [],
  };
  const plan = buildServerPlan(emptyInput({ server, enabledBuiltIns: ['clientName'], webGoogleTagServerUrl: 'https://sgtm.example.com' }));
  const missingBaseline = plan.items.filter((i) => i.status === 'missing' && !i.id.includes('_capi:') && !i.id.startsWith('data_'));
  assert.deepEqual(missingBaseline, [], 'nothing baseline missing: ' + missingBaseline.map((i) => i.id).join(','));
  assert.ok(plan.items.filter((i) => i.status === 'existing').every((i) => i.category === 'info' && !i.defaultSelected));
  assert.equal(plan.detected.serverUrl, 'https://sgtm.example.com');
  assert.equal(plan.detected.webWiredUrl, 'https://sgtm.example.com');
  assert.equal(plan.inventory.clients.length, 2);
});

test('a covered CAPI event reads existing; an uncovered one stays missing', () => {
  const server: ServerContainerSnapshot = {
    taggingServerUrls: [],
    clients: [{ clientId: 'c1', name: 'GA4', type: 'gaaw_client' }],
    tags: [tag({ tagId: 's2', name: 'Meta CAPI - Lead', type: 'cvt_x_1', firingTriggerId: ['91'], parameter: [] })],
    triggers: [evTrigger('91', 'generate_lead')],
    variables: [],
    transformations: [],
  };
  const plan = buildServerPlan(emptyInput({ server }));
  assert.equal(plan.items.find((i) => i.id === 'meta_capi:generate_lead')!.status, 'existing');
  assert.equal(plan.items.find((i) => i.id === 'tiktok_capi:generate_lead')!.status, 'missing');
});

test('an X server tag under the tools\' default name "X CAPI Tag" covers its event (no duplicate offered)', () => {
  const xWeb: ContainerSnapshot = {
    tags: [tag({ tagId: 'w1', name: 'X pixel - Purchase', type: 'html', firingTriggerId: ['11'], parameter: [{ type: 'template', key: 'html', value: "twq('event','tw-o1abc-xyz')" }] })],
    triggers: [evTrigger('11', 'purchase')],
    variables: [],
  };
  const xServer = (name: string, keys: string[]): ServerContainerSnapshot => ({
    taggingServerUrls: [],
    clients: [{ clientId: 'c1', name: 'GA4', type: 'gaaw_client' }],
    tags: [tag({ tagId: 's1', name, type: 'cvt_TW1', firingTriggerId: ['91'], parameter: keys.map((key) => ({ type: 'template', key, value: 'v' })) })],
    triggers: [evTrigger('91', 'purchase')],
    variables: [],
    transformations: [],
  });
  const status = (server: ServerContainerSnapshot) =>
    buildServerPlan(emptyInput({ web: xWeb, server })).items.find((i) => i.id === 'x_capi:purchase')?.status;
  assert.equal(status(xServer('X CAPI Tag', ['pixelId', 'pixelAccessToken', 'eventId'])), 'existing', 'the default name with the X template shape');
  assert.equal(status(xServer('Server conversions', ['pixelId', 'pixelAccessToken', 'eventId'])), 'existing', 'recognised by shape under any name');
  assert.equal(status(xServer('X CAPI Tag', [])), 'existing', 'the default name alone is recognised');
  assert.equal(status(xServer('Unrelated', [])), 'missing');
});

test('planReadiness: missing values and unchecked dependencies surface; satisfied ones do not', () => {
  const plan = buildServerPlan(emptyInput({ derivedMeasurementId: null }));
  const items = plan.items;
  // Relay selected without an id and without its trigger -> both problems named.
  let r = planReadiness(items, new Set(['ga4_relay']), {});
  assert.equal(r.length, 1);
  assert.ok(r[0].missingValues.includes('measurementId'));
  assert.ok(r[0].missingDeps.includes('all_events_trigger'));
  // Selecting the deps + providing the value clears it.
  r = planReadiness(items, new Set(['ga4_relay', 'ga4_client', 'all_events_trigger']), { measurementId: 'G-XYZ9999' });
  assert.deepEqual(r, []);
  // Meta CAPI without credentials is flagged.
  r = planReadiness(items, new Set(['meta_capi:generate_lead', 'ga4_client']), {});
  assert.ok(r.some((x) => x.id === 'meta_capi:generate_lead' && x.missingValues.length === 2));
});


// ── Stape Data Tag pipeline ──

const dataClientClient = { clientId: 'c9', name: 'Data Client', type: 'cvt_x_dc', parameter: [{ type: 'boolean', key: 'generateClientId', value: 'true' }] };
const stapeWebTag = (over: Partial<AuditTag> = {}): AuditTag =>
  tag({ tagId: 'w9', name: 'Stape Data Tag', type: 'cvt_abc_dt', firingTriggerId: ['2147479553'], parameter: [
    { type: 'template', key: 'gtm_server_domain', value: 'https://sgtm.example.com' },
    { type: 'template', key: 'request_path', value: '/data' },
  ], ...over });
const serverWith = (clients: unknown[], urls: string[] = ['https://sgtm.example.com']): ServerContainerSnapshot => ({
  taggingServerUrls: urls,
  clients: clients as ServerContainerSnapshot['clients'],
  tags: [], triggers: [], variables: [], transformations: [],
});

test('no Data Tag anywhere: not_installed; optional low items, never pre-checked', () => {
  const plan = buildServerPlan(emptyInput());
  assert.equal(plan.detected.dataTag, 'not_installed');
  const dt = plan.items.find((i) => i.id === 'data_tag')!;
  assert.equal(dt.category, 'low');
  assert.equal(dt.defaultSelected, false);
  assert.deepEqual(dt.requires, ['serverUrl']);
  assert.deepEqual(dt.dependsOn, ['data_client']);
  const dc = plan.items.find((i) => i.id === 'data_client')!;
  assert.equal(dc.category, 'low');
  assert.equal(dc.defaultSelected, false);
  assert.ok(!plan.items.some((i) => i.id === 'data_pipeline'), 'no pipeline row without both pieces');
});

test('Data Tag + Data Client with matching hosts: configured, pipeline row is info', () => {
  const w = web(); w.tags.push(stapeWebTag());
  const plan = buildServerPlan(emptyInput({ web: w, server: serverWith([{ clientId: 'c1', name: 'GA4', type: 'gaaw_client' }, dataClientClient]) }));
  assert.equal(plan.detected.dataTag, 'configured');
  assert.equal(plan.items.find((i) => i.id === 'data_client')!.status, 'existing');
  const pipe = plan.items.find((i) => i.id === 'data_pipeline')!;
  assert.equal(pipe.category, 'info');
  assert.equal(pipe.status, 'existing');
  assert.ok(/Tag Verification/.test(pipe.description), 'runtime proof deferred to Tag Verification');
  assert.ok(!plan.items.some((i) => i.id === 'data_tag_url'), 'no fix item when configured');
});

test('Data Tag pointing at the wrong host: misconfigured, one-click URL fix offered', () => {
  const w = web();
  w.tags.push(stapeWebTag({ parameter: [{ type: 'template', key: 'gtm_server_domain', value: 'https://old-server.example.net' }] }));
  const plan = buildServerPlan(emptyInput({ web: w, server: serverWith([dataClientClient]) }));
  assert.equal(plan.detected.dataTag, 'misconfigured');
  const fix = plan.items.find((i) => i.id === 'data_tag_url')!;
  assert.equal(fix.category, 'high');
  assert.equal(fix.executable, true);
  assert.deepEqual(fix.requires, ['serverUrl']);
  assert.ok(/different host/.test(fix.description));
  assert.equal(plan.items.find((i) => i.id === 'data_pipeline')!.category, 'high');
});

test('paused Data Tag: misconfigured but NOT one-click (a human must decide in GTM)', () => {
  const w = web(); w.tags.push(stapeWebTag({ paused: true }));
  const plan = buildServerPlan(emptyInput({ web: w, server: serverWith([dataClientClient]) }));
  assert.equal(plan.detected.dataTag, 'misconfigured');
  const fix = plan.items.find((i) => i.id === 'data_tag_url')!;
  assert.equal(fix.executable, false);
  assert.ok(/PAUSED/.test(fix.description));
});

test('web Data Tag with NO server Data Client: data_client is high and pre-checked (requests dropped)', () => {
  const w = web(); w.tags.push(stapeWebTag());
  const plan = buildServerPlan(emptyInput({ web: w, server: serverWith([{ clientId: 'c1', name: 'GA4', type: 'gaaw_client' }]) }));
  const dc = plan.items.find((i) => i.id === 'data_client')!;
  assert.equal(dc.category, 'high');
  assert.equal(dc.status, 'missing');
  assert.equal(dc.defaultSelected, true);
  assert.ok(/dropped/.test(dc.description));
});

test('detection is by parameter signature, not name; client falls back to name', () => {
  const w = web();
  w.tags.push(tag({ tagId: 'w8', name: 'Totally Custom Thing', type: 'cvt_zz', firingTriggerId: ['1'], parameter: [{ type: 'template', key: 'gtm_server_domain', value: 'https://sgtm.example.com' }] }));
  assert.ok(findStapeDataTag(w), 'gtm_server_domain param key identifies the Data Tag');
  assert.ok(!findStapeDataTag(web()), 'plain pixels are not Data Tags');
  assert.ok(findStapeDataClient(serverWith([{ clientId: 'c2', name: 'My Data Client', type: 'cvt_q', parameter: [] }])), 'name fallback');
  assert.equal(findStapeDataClient(serverWith([{ clientId: 'c1', name: 'GA4', type: 'gaaw_client' }])), null);
});

test('buildStapeDataTag: verified template field keys, All Pages default trigger', () => {
  const t = buildStapeDataTag('cvt_abc_dt', 'Stape Data Tag', 'https://sgtm.example.com') as unknown as AuditTag;
  const get = (k: string) => (t.parameter ?? []).find((p) => (p as { key?: string }).key === k) as { value?: string } | undefined;
  assert.equal(get('gtm_server_domain')!.value, 'https://sgtm.example.com');
  assert.equal(get('request_path')!.value, '/data');
  assert.equal(get('event_type')!.value, 'standard');
  assert.equal(get('event_name_standard')!.value, 'page_view');
  assert.equal(get('add_data_layer')!.value, 'true');
  assert.equal(get('add_consent_state')!.value, 'true');
  assert.deepEqual(t.firingTriggerId, ['2147479553']);
});

test('CAPI items: platforms beyond the original four are planned, with their own credential shapes', () => {
  const pixel = (tagId: string, name: string, trig: string) =>
    ({ tagId, name, type: 'html', paused: false, firingTriggerId: [trig], blockingTriggerId: [], consentSettings: null,
       parameter: [{ type: 'template', key: 'html', value: '<script>x()</script>' }] });
  const ev = (id: string, event: string) =>
    ({ triggerId: id, name: event, type: 'customEvent', customEventFilter: [
      { type: 'equals', parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: event }] },
    ], filter: [], autoEventFilter: [], parameter: [] });
  const input = {
    ...emptyInput(),
    web: {
      tags: [
        pixel('w1', 'Yelp conversion', '1'),
        pixel('w2', 'Nextdoor', '2'),
        pixel('w3', 'LINE Yahoo', '3'),
        pixel('w4', 'Reddit Pixel', '4'),
      ],
      triggers: [ev('1', 'purchase'), ev('2', 'purchase'), ev('3', 'purchase'), ev('4', 'purchase')],
      variables: [],
    },
  };
  const plan = buildServerPlan(input as never);
  const req = (p: string) => plan.items.find((i) => i.id === `${p}_capi:purchase`)?.requires;

  // Yelp has no public pixel id at all: the token is the whole credential.
  assert.deepEqual(req('yelp'), ['yelp.accessToken']);
  // Nextdoor and LINE Yahoo take three fields, which a two-credential model could never express.
  assert.deepEqual(req('nextdoor'), ['nextdoor.pixelId', 'nextdoor.clientId', 'nextdoor.accessToken']);
  // ...plus, for any event but page_view, Yahoo's per-conversion Event Snippet ID for THIS event.
  assert.deepEqual(req('lineyahoo'), ['lineyahoo.tagId', 'lineyahoo.accessToken', 'lineyahoo.channelId', 'lineyahoo.eventSnippetId@purchase']);
  assert.deepEqual(req('reddit'), ['reddit.accountId', 'reddit.accessToken']);
  for (const p of ['yelp', 'nextdoor', 'lineyahoo', 'reddit']) {
    const item = plan.items.find((i) => i.id === `${p}_capi:purchase`)!;
    assert.equal(item.executable, true, `${p} is applied by the app, not handed to chat`);
    assert.equal(item.defaultSelected, false, `${p} is credential-gated`);
  }
});

test('apply: an existing Custom Event trigger (listGtmTriggers row) is REUSED, not duplicated', () => {
  // applyServerPlan reads triggers through listGtmTriggers, whose rows carry customEventName and
  // conditions but no raw customEventFilter. The old match read customEventFilter, so it never found
  // a trigger from an earlier run and created "ce - purchase (server)" next to "ce - purchase".
  const rows: ListedTrigger[] = [
    { triggerId: '7', name: 'ce - purchase', type: 'customEvent', customEventName: 'purchase', customEventExact: true, conditions: [] },
    { triggerId: '8', name: 'All Pages', type: 'pageview', customEventName: '', conditions: [] },
  ];
  assert.deepEqual(eventTriggerFor(rows, 'purchase'), { reuse: '7' });
  assert.deepEqual(eventTriggerFor(rows, 'lead'), { create: 'ce - lead' }, 'a missing event gets the plain name');
});

test('apply: a regex / contains / negated event trigger is NOT reused as "event equals X"', () => {
  // customEventName drops the operator, so `{{_event}} matches regex purchase` (unanchored: also
  // purchase_refund), `contains purchase` and `NOT equals purchase` all list as "purchase" with no
  // conditions. Reusing one fired the new CAPI tag on other events, sent to the platform as conversions.
  const inexact: ListedTrigger = { triggerId: '7', name: 'ce - purchase', type: 'customEvent', customEventName: 'purchase', customEventExact: false, conditions: [] };
  assert.deepEqual(eventTriggerFor([inexact], 'purchase'), { create: 'ce - purchase (server)' });
  const { customEventExact: _omit, ...unknownOp } = inexact;
  assert.deepEqual(eventTriggerFor([unknownOp], 'purchase'), { create: 'ce - purchase (server)' }, 'a row that does not say it is exact is not reused');
  assert.deepEqual(eventTriggerFor([inexact, { ...inexact, triggerId: '11', name: 'purchase exact', customEventExact: true }], 'purchase'), { reuse: '11' }, 'an exact sibling is still reused');
});

test('apply: a trigger with extra conditions is not reused, and a new one always gets a FREE name', () => {
  // Run 1 left "ce - purchase" with a page condition; run 2 created "ce - purchase (server)". A third
  // create must not re-offer "(server)", which GTM rejects as a duplicate name.
  const rows: ListedTrigger[] = [
    { triggerId: '7', name: 'ce - purchase', type: 'customEvent', customEventName: 'purchase', conditions: ['{{Page Path}} equals /thanks'] },
  ];
  assert.deepEqual(eventTriggerFor(rows, 'purchase'), { create: 'ce - purchase (server)' }, 'a conditioned trigger fires on less than the event');
  rows.push({ triggerId: '9', name: 'CE - Purchase (Server)', type: 'customEvent', customEventName: 'purchase_refund', conditions: [] });
  assert.deepEqual(eventTriggerFor(rows, 'purchase'), { create: 'ce - purchase (server 3)' }, 'taken names are compared case-insensitively');
  rows.push({ triggerId: '10', name: 'ce - purchase (server 3)', type: 'customEvent', customEventName: 'other', conditions: [] });
  assert.deepEqual(eventTriggerFor(rows, 'purchase'), { create: 'ce - purchase (server 4)' });
  // A trigger on a different event with the same base name is not reused either.
  assert.deepEqual(eventTriggerFor([{ triggerId: '1', name: 'ce - lead', type: 'customEvent', customEventName: 'generate_lead', conditions: [] }], 'lead'), { create: 'ce - lead (server)' });
});


test('CAPI items: a per-conversion id is required PER EVENT, so two X / LinkedIn events never share one conversion', () => {
  const pixel = (tagId: string, name: string, type: string, trig: string) =>
    tag({ tagId, name, type, firingTriggerId: [trig], parameter: [{ type: 'template', key: 'html', value: '<script>x()</script>' }] });
  const input = emptyInput();
  input.web = {
    tags: [
      pixel('x1', 'X pixel - purchase', 'html', '1'), pixel('x2', 'X pixel - lead', 'html', '2'),
      pixel('l1', 'Insight', 'bzi', '1'), pixel('l2', 'Insight 2', 'bzi', '2'),
      pixel('y1', 'LINE Yahoo PV', 'html', '3'),
    ],
    triggers: [evTrigger('1', 'purchase'), evTrigger('2', 'generate_lead'), evTrigger('3', 'page_view')],
    variables: [],
  } as ContainerSnapshot;
  const plan = buildServerPlan(input);
  const req = (id: string) => plan.items.find((i) => i.id === id)?.requires;
  assert.deepEqual(req('x_capi:purchase'), ['x.pixelId', 'x.eventId@purchase', 'x.pixelAccessToken']);
  assert.deepEqual(req('x_capi:generate_lead'), ['x.pixelId', 'x.eventId@generate_lead', 'x.pixelAccessToken']);
  assert.deepEqual(req('linkedin_capi:purchase'), ['linkedin.conversionRuleUrn@purchase', 'linkedin.accessToken']);
  assert.deepEqual(req('linkedin_capi:generate_lead'), ['linkedin.conversionRuleUrn@generate_lead', 'linkedin.accessToken']);
  assert.deepEqual(req('lineyahoo_capi:page_view'), ['lineyahoo.tagId', 'lineyahoo.accessToken', 'lineyahoo.channelId'], 'page_view needs no Yahoo snippet');
  // Filling only the purchase X Event ID leaves the lead item not ready rather than reusing it.
  const r = planReadiness(plan.items, new Set(['x_capi:purchase', 'x_capi:generate_lead', 'ga4_client']),
    { 'x.pixelId': 'P', 'x.pixelAccessToken': 'T', 'x.eventId@purchase': 'tw-a' } as never);
  assert.deepEqual(r.map((x) => [x.id, x.missingValues]), [['x_capi:generate_lead', ['x.eventId@generate_lead']]]);
});

// ── applyServerPlan wiring: CAPI match-quality variable provisioning ─────────────────────────────
// Regression: a failure creating the Meta/TikTok `ed - ...` variables was swallowed (.catch(() => null))
// and the platform marked provisioned, so the tag was built on dangling references, the error named
// the reference instead of the cause, and later events never retried. GTM is answered by a fake auth
// client (googleapis sends every request through auth.request); nothing leaves the machine.
async function applyWiring(): Promise<void> {
  const { GoogleDataService } = await import('../data-service');
  type Ctor = ConstructorParameters<typeof GoogleDataService>;
  const gtmCalls: string[] = [];
  let triggerSeq = 0;
  const fakeAuth = {
    request: async (opts: { url?: unknown; method?: unknown }) => {
      gtmCalls.push(`${String(opts.method ?? 'GET')} ${String(opts.url)}`);
      triggerSeq += 1;
      return { data: { triggerId: `T${triggerSeq}` }, status: 200, headers: {}, config: opts };
    },
  };
  const svc = new GoogleDataService(
    { getActiveView: () => ({ id: 'acct', email: 'a@x.com', hasGoogleToken: true }) } as unknown as Ctor[0],
    { getClient: () => fakeAuth } as unknown as Ctor[1],
  );
  const stub = svc as unknown as Record<string, unknown>;
  const varCreates: string[] = [];
  let varListings = 0;
  let failNextVariable = true;
  const tagCreates: string[] = [];
  stub.findServerContainerByName = async () => ({ containerId: '99', publicId: 'GTM-SRV', name: 'Server' });
  stub.defaultWorkspaceId = async () => '5';
  stub.listGtmClients = async () => [];
  stub.listGtmTriggers = async () => [];
  stub.listGtmTags = async () => [];
  stub.listGtmEnabledBuiltInVariables = async () => [];
  stub.listGtmVariables = async () => { varListings += 1; return []; };
  stub.importGalleryTemplate = async () => ({ type: 'cvt_capi' });
  stub.createGtmVariable = async (_a: string, _c: string, _w: string, v: { name?: string }) => {
    if (failNextVariable) { failNextVariable = false; throw new Error(`Found entity with the same name: ${v.name}`); }
    varCreates.push(String(v.name));
    return { variableId: String(varCreates.length), name: String(v.name), type: 'ed' };
  };
  stub.createGtmTag = async (_a: string, _c: string, _w: string, t: { name?: string }) => {
    tagCreates.push(String(t.name));
    return { tagId: String(tagCreates.length), name: String(t.name), type: 'cvt_capi' };
  };
  const out = await svc.applyServerPlan('1', '10', { newName: 'Server' },
    ['meta_capi:purchase', 'meta_capi:generate_lead', 'snapchat_capi:purchase'],
    { capi: { 'meta.pixelId': 'P1', 'meta.accessToken': 'test-token', 'snapchat.pixelId': 'S1', 'snapchat.accessToken': 'test-token' } });

  test('apply: a failed ed - variable provisioning FAILS that CAPI item with the real cause', () => {
    assert.ok(!out.applied.includes('meta_capi:purchase'), 'never reported as applied');
    const f = out.failed.find((x) => x.id === 'meta_capi:purchase');
    assert.ok(f, 'reported as failed');
    assert.match(f!.error, /match-quality variables/);
    assert.match(f!.error, /Found entity with the same name/, 'the variable error, not a dangling-reference one');
    assert.ok(!tagCreates.includes('Meta CAPI - purchase'), 'no tag is built on dangling {{ed - ...}} references');
    assert.equal(gtmCalls.filter((c) => /triggers/.test(c)).length, 2, 'the failed item leaves no stray trigger (only the 2 applied items create one)');
  });
  test('apply: the next event retries the provisioning, and Meta + Snapchat share the one variable set', () => {
    assert.deepEqual(out.applied, ['meta_capi:generate_lead', 'snapchat_capi:purchase']);
    assert.deepEqual(tagCreates, ['Meta CAPI - generate_lead', 'Snapchat CAPI - purchase']);
    // 1 plan-wide listing + the failing item's provisioning + ONE retry; Snapchat reuses the 'meta' set.
    assert.equal(varListings, 3, 'provisioned on the failing item, retried once on the next, then never again');
    assert.ok(varCreates.length > 0);
  });
}

void applyWiring().catch((e) => { failed++; console.error(`  ✗ applyServerPlan wiring: ${(e as Error).message}`); }).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
