import assert from 'node:assert/strict';
import { buildServerCoverage } from '../server-coverage';
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
const clientTrigger = (id: string): AuditTrigger => ({
  triggerId: id, name: 'All GA4 events', type: 'always', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [],
} as unknown as AuditTrigger);

const web = (over: Partial<ContainerSnapshot> = {}): ContainerSnapshot => ({
  tags: [
    tag({ tagId: 'w1', name: 'GA4 - Config', type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-ABC1234' }] }),
    tag({ tagId: 'w2', name: 'GA4 - Purchase', type: 'gaawe', firingTriggerId: ['10'], parameter: [{ type: 'template', key: 'eventName', value: 'purchase' }, { type: 'template', key: 'measurementIdOverride', value: 'G-ABC1234' }] }),
    tag({ tagId: 'w3', name: 'Meta - Event - Lead Tag', type: 'html', firingTriggerId: ['11'], parameter: [{ type: 'template', key: 'html', value: '<script>fbq("track","Lead")</script>' }] }),
  ],
  triggers: [evTrigger('10', 'purchase'), evTrigger('11', 'generate_lead')],
  variables: [],
  ...over,
});

const server = (over: Partial<ServerContainerSnapshot> = {}): ServerContainerSnapshot => ({
  taggingServerUrls: ['https://sgtm.example.com'],
  clients: [{ clientId: 'c1', name: 'GA4', type: 'gaaw_client' }],
  tags: [
    tag({ tagId: 's1', name: 'GA4 Relay', type: 'sgtmgaaw', firingTriggerId: ['90'], parameter: [{ type: 'template', key: 'measurementId', value: 'G-ABC1234' }] }),
    tag({ tagId: 's2', name: 'Meta CAPI - Lead', type: 'cvt_x_1', firingTriggerId: ['91'], parameter: [{ type: 'template', key: 'pixelId', value: '123456789012345' }, { type: 'template', key: 'accessToken', value: 'EAAx' }] }),
  ],
  triggers: [clientTrigger('90'), evTrigger('91', 'generate_lead')],
  variables: [],
  transformations: [],
  ...over,
});

const AUDIT_OK = { critical: 0, high: 0, medium: 0, low: 0 };

console.log('\nserver-coverage:');

test('healthy pair: GA4 covered via client+relay, Meta covered per event, 100% coverage', () => {
  const r = buildServerCoverage(web(), server(), AUDIT_OK);
  const ga4 = r.rows.find((x) => x.platform === 'ga4')!;
  assert.equal(ga4.status, 'covered');
  assert.ok(/relay/i.test(ga4.by ?? ''), 'relay named');
  const meta = r.rows.find((x) => x.platform === 'meta')!;
  assert.equal(meta.status, 'covered');
  assert.ok(/Meta CAPI - Lead/.test(meta.by ?? ''), 'covering server tag named');
  assert.equal(r.summary.coveragePct, 100);
  assert.equal(r.score.configuration, 100);
  assert.equal(r.score.overall, 100);
  assert.equal(r.ga4.idsMatch, true, 'G-ABC on both sides');
});

test('no GA4 client → every web GA4 event reads missing, with the fix', () => {
  const r = buildServerCoverage(web(), server({ clients: [] }), AUDIT_OK);
  const ga4 = r.rows.find((x) => x.platform === 'ga4')!;
  assert.equal(ga4.status, 'missing');
  assert.ok(/GA4 client/.test(ga4.recommendation ?? ''));
});

test('web Meta event with no matching server trigger → missing with the exact CAPI tool', () => {
  const srv = server({ triggers: [clientTrigger('90'), evTrigger('91', 'some_other_event')] });
  const r = buildServerCoverage(web(), srv, AUDIT_OK);
  const meta = r.rows.find((x) => x.platform === 'meta')!;
  assert.equal(meta.status, 'missing');
  assert.ok(/create_meta_capi_server_tag/.test(meta.recommendation ?? ''), meta.recommendation);
  // ...and the server's unmatched event surfaces as unused.
  assert.deepEqual(r.unusedServer, [{ tag: 'Meta CAPI - Lead', platform: 'meta', event: 'some_other_event' }]);
  assert.equal(r.summary.coveragePct, 50);
});

test('an all-events server tag covers a pixel with no extractable event name', () => {
  const w = web({
    tags: [tag({ tagId: 'w4', name: 'TikTok Pixel', type: 'html', firingTriggerId: ['12'], parameter: [{ type: 'template', key: 'html', value: 'ttq.track' }] })],
    triggers: [{ triggerId: '12', name: 'All clicks', type: 'click', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [] } as never],
  });
  const srv = server({
    tags: [tag({ tagId: 's3', name: 'TikTok Events API', type: 'cvt_x_2', firingTriggerId: ['90'], parameter: [] })],
    triggers: [clientTrigger('90')],
  });
  const r = buildServerCoverage(w, srv, AUDIT_OK);
  assert.equal(r.rows[0].status, 'covered');
  assert.ok(/all-events/.test(r.rows[0].by ?? ''));
});

test('not_matchable pixels are honest: excluded from the coverage % and carry a manual-check note', () => {
  const w = web({
    tags: [tag({ tagId: 'w4', name: 'Pinterest Pixel', type: 'html', firingTriggerId: ['12'], parameter: [{ type: 'template', key: 'html', value: 'pintrk("track")' }] })],
    triggers: [{ triggerId: '12', name: 'All clicks', type: 'click', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [] } as never],
  });
  const r = buildServerCoverage(w, server({ tags: [], triggers: [] }), AUDIT_OK);
  assert.equal(r.rows[0].status, 'not_matchable');
  assert.ok(/verify it manually/i.test(r.rows[0].recommendation ?? ''));
  assert.equal(r.summary.coveragePct, null, 'nothing matchable -> no fake percentage');
  assert.equal(r.score.overall, r.score.configuration, 'overall falls back to configuration alone');
});

test('web wiring: not_wired when the Google tag has no server_container_url; wired when hosts match; mismatch otherwise', () => {
  assert.equal(buildServerCoverage(web(), server(), AUDIT_OK).webWiring.status, 'not_wired');
  const wired = web({
    tags: [
      tag({ tagId: 'w1', name: 'GA4 - Config', type: 'googtag', parameter: [
        { type: 'template', key: 'tagId', value: 'G-ABC1234' },
        { type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [{ type: 'template', key: 'parameter', value: 'server_container_url' }, { type: 'template', key: 'parameterValue', value: 'https://sgtm.example.com' }] }] },
      ] as never }),
    ],
    triggers: [],
  });
  assert.equal(buildServerCoverage(wired, server(), AUDIT_OK).webWiring.status, 'wired');
  assert.equal(buildServerCoverage(wired, server({ taggingServerUrls: ['https://other.example.org'] }), AUDIT_OK).webWiring.status, 'url_mismatch');
});

test('measurement-id mismatch is reported, and the health score reflects audit findings', () => {
  const srv = server({
    tags: [tag({ tagId: 's1', name: 'GA4 Relay', type: 'sgtmgaaw', firingTriggerId: ['90'], parameter: [{ type: 'template', key: 'measurementId', value: 'G-OTHER999' }] })],
    triggers: [clientTrigger('90')],
  });
  const r = buildServerCoverage(web(), srv, { critical: 1, high: 1, medium: 2, low: 3 });
  assert.equal(r.ga4.idsMatch, false, 'web vs server ids differ');
  assert.equal(r.score.configuration, 100 - 25 - 10 - 6 - 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
