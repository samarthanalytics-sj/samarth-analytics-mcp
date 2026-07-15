import assert from 'node:assert/strict';
import { buildServerPlan, planReadiness, type ServerPlanInput } from '../server-plan';
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

test('CAPI items: per web pixel event; Meta/TikTok executable with credential requires; Pinterest chat-only', () => {
  const plan = buildServerPlan(emptyInput());
  const meta = plan.items.find((i) => i.id === 'meta_capi:generate_lead')!;
  assert.deepEqual(meta.requires, ['metaPixelId', 'metaAccessToken']);
  assert.equal(meta.executable, true);
  assert.equal(meta.defaultSelected, false, 'credential-gated items never pre-checked');
  const tiktok = plan.items.find((i) => i.id === 'tiktok_capi:generate_lead')!;
  assert.equal(tiktok.executable, true);
  const pin = plan.items.find((i) => i.id === 'pinterest_capi:generate_lead')!;
  assert.equal(pin.executable, false, 'Pinterest planned but chat-only');
  assert.ok(/create_pinterest_capi_server_tag/.test(pin.description));
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
  const missingBaseline = plan.items.filter((i) => i.status === 'missing' && !i.id.includes('_capi:'));
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
