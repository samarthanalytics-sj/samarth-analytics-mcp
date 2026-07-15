import assert from 'node:assert/strict';
import { serverContainerDocMarkdown, serverContainerDocCsv, buildServerFlowLines, buildDestinationRows, buildServerDocView } from '../server-doc';
import type { AuditTag, AuditTrigger, ServerContainerSnapshot } from '../gtm-builders';

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

const snap = (): ServerContainerSnapshot => ({
  taggingServerUrls: ['https://sgtm.example.com'],
  clients: [{ clientId: 'c1', name: 'GA4 Client', type: 'gaaw_client' }],
  tags: [
    {
      tagId: 's1', name: 'GA4 Relay', type: 'sgtmgaaw', firingTriggerId: ['90'], blockingTriggerId: [], paused: false,
      parameter: [{ type: 'template', key: 'measurementId', value: 'G-ABC1234' }], consentSettings: null,
    } as AuditTag,
    {
      tagId: 's2', name: 'Meta CAPI - Lead', type: 'cvt_x_1', firingTriggerId: ['91'], blockingTriggerId: [], paused: true,
      parameter: [
        { type: 'template', key: 'pixelId', value: '123456789012345' },
        { type: 'template', key: 'accessToken', value: 'EAA-super-secret-token-value' },
        { type: 'template', key: 'userData', value: '{{ed - email}}' },
      ],
      consentSettings: null,
    } as AuditTag,
  ],
  triggers: [
    { triggerId: '90', name: 'All GA4 events', type: 'always', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [] } as unknown as AuditTrigger,
    { triggerId: '91', name: 'ce - lead', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: 'generate_lead' }] }], filter: [], autoEventFilter: [], parameter: [] } as unknown as AuditTrigger,
  ],
  variables: [{ variableId: 'v1', name: 'ed - email', type: 'ed', parameter: [] }],
  transformations: [{ transformationId: 'x1', name: 'Hash email', type: 'hash' }],
});

console.log('\nserver-doc:');

test('markdown: overview counts, clients, tags with destination/trigger/vars, transformations', () => {
  const md = serverContainerDocMarkdown(snap(), { containerName: 'Acme - Server', publicId: 'GTM-SRV1', workspaceName: 'Default' });
  assert.ok(md.startsWith('# Server container documentation: Acme - Server (GTM-SRV1)'));
  assert.ok(md.includes('Clients: 1 · Tags: 2 · Triggers: 2 · Variables: 1 · Transformations: 1'));
  assert.ok(md.includes('| GA4 Client | gaaw_client |'));
  assert.ok(md.includes('G-ABC1234'), 'GA4 destination shown');
  assert.ok(md.includes('pixel 123456789012345'), 'Meta pixel id shown (an id, not a credential)');
  assert.ok(md.includes('ce - lead'), 'firing trigger named');
  assert.ok(md.includes('ed - email'), 'referenced variable listed');
  assert.ok(md.includes('PAUSED'), 'paused noted');
  assert.ok(md.includes('| Hash email | hash |'));
  assert.ok(md.includes('{{_event}} equals "generate_lead"'), 'trigger condition documented');
});

test('SECURITY: secret-shaped values never appear in md or csv - only their presence', () => {
  const md = serverContainerDocMarkdown(snap(), { containerName: 'Acme - Server' });
  const csv = serverContainerDocCsv(snap(), { containerName: 'Acme - Server' });
  assert.ok(!md.includes('EAA-super-secret-token-value'), 'token absent from markdown');
  assert.ok(!csv.includes('EAA-super-secret-token-value'), 'token absent from csv');
  assert.ok(md.includes('credential configured (value not shown)'), 'presence documented');
});

test('csv: one row per entity with RFC-4180 quoting', () => {
  const csv = serverContainerDocCsv(snap(), { containerName: 'Acme, Server' });
  assert.ok(csv.startsWith('Server container documentation,"Acme, Server"'), 'comma-bearing name quoted');
  assert.ok(/Client,GA4 Client,gaaw_client/.test(csv));
  assert.ok(/Tag,GA4 Relay,sgtmgaaw,G-ABC1234,All GA4 events/.test(csv));
  assert.ok(/Trigger,ce - lead,customEvent/.test(csv));
  assert.ok(/Variable,ed - email,ed/.test(csv));
  assert.ok(/Transformation,Hash email,hash/.test(csv));
});

test('empty container documents honestly (no fabricated sections)', () => {
  const md = serverContainerDocMarkdown(
    { taggingServerUrls: [], clients: [], tags: [], triggers: [], variables: [], transformations: [] },
    { containerName: 'Empty' },
  );
  assert.ok(md.includes('(not set - host not wired yet)'));
  assert.ok(md.includes('None - nothing claims incoming requests'));
  assert.ok(md.includes('None configured - events pass through to destinations unmodified.'));
});

test('deliverable sections: configuration issues, destinations, request flow, draft-vs-live caveat', () => {
  const audit = {
    counts: { tags: 2, triggers: 1, variables: 1, findings: 1 },
    summary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    findings: [{ severity: 'high' as const, category: 'firing', message: 'The container has no tagging server URL', recommendation: 'Set it with set_server_container_tagging_url.', autoFixable: false, confidence: 'likely' as const }],
    boundary: '', runtimeRequired: [], hasGa4Config: true,
  };
  const md = serverContainerDocMarkdown(snap(), { containerName: 'Acme - Server', workspaceName: 'Default', liveVersionId: '7' }, audit as never);
  assert.ok(md.includes('Live (published) version: 7.') && md.includes('DRAFT, which may differ'), 'draft-vs-live caveat');
  assert.ok(md.includes('## Configuration issues'), 'issues section present');
  assert.ok(/\| HIGH \| container \| The container has no tagging server URL/.test(md), 'finding row with severity + where');
  assert.ok(md.includes('## Destinations (where data goes)'), 'destinations section');
  assert.ok(/\| G-ABC1234 \| sgtmgaaw \| 1 \|/.test(md), 'GA4 destination row');
  assert.ok(/\| pixel 123456789012345 \|.*\| 1 \| 1 paused \|/.test(md), 'Meta destination with paused note');
  assert.ok(md.includes('## Request flow'), 'flow section');
  assert.ok(md.includes('-> GA4 Relay (G-ABC1234)'), 'flow shows trigger -> tag -> destination');

  const csv = serverContainerDocCsv(snap(), { containerName: 'Acme - Server' }, audit as never);
  assert.ok(/Finding,container,HIGH/.test(csv), 'finding row in csv');
  assert.ok(/Destination,G-ABC1234,sgtmgaaw/.test(csv), 'destination row in csv');
});

test('request flow: orphan tags called out; clean audit says clean; no audit -> no issues section', () => {
  const s2 = snap();
  s2.tags = [{ ...s2.tags[0], firingTriggerId: [] }];
  const flow = buildServerFlowLines(s2).join('\n');
  assert.ok(/tags with NO trigger \(never fire\): "GA4 Relay"/.test(flow), flow);
  const noClients = buildServerFlowLines({ ...snap(), clients: [] }).join('\n');
  assert.ok(/no client - nothing claims requests/.test(noClients));
  const cleanAudit = { counts: { tags: 0, triggers: 0, variables: 0, findings: 0 }, summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], boundary: '', runtimeRequired: [], hasGa4Config: true };
  const md = serverContainerDocMarkdown(snap(), { containerName: 'A' }, cleanAudit as never);
  assert.ok(/None found - the configuration audit came back clean/.test(md));
  const noAudit = serverContainerDocMarkdown(snap(), { containerName: 'A' });
  assert.ok(!noAudit.includes('## Configuration issues'), 'no audit passed -> no issues section');
  assert.equal(buildDestinationRows(snap()).length, 2, 'two distinct destinations');
});


test('on-screen view: same content as the exports (counts, destinations, flow, fires-on, condition)', () => {
  const c = snap();
  const v = buildServerDocView(c, { containerName: 'Acme - Server', publicId: 'GTM-SRV1', workspaceName: 'Default', generatedAt: 'now', liveVersionId: '7' });
  assert.equal(v.meta.liveVersionId, '7');
  assert.deepEqual(v.overview.counts, { clients: 1, tags: 2, triggers: 2, variables: 1, transformations: 1 });
  assert.deepEqual(v.destinations, buildDestinationRows(c), 'destinations identical to the export builder');
  assert.deepEqual(v.flowLines, buildServerFlowLines(c), 'flow identical to the export builder');
  const meta = v.tags.find((t) => t.name === 'Meta CAPI - Lead')!;
  assert.equal(meta.destination, 'pixel 123456789012345');
  assert.equal(meta.firesOn, 'ce - lead');
  assert.ok(meta.vars.includes('ed - email'));
  assert.equal(v.triggers.find((t) => t.name === 'ce - lead')!.condition, '{{_event}} equals "generate_lead"');
});

test('SECURITY: the on-screen view never carries secret values - only the pinned presence note', () => {
  const v = buildServerDocView(snap(), { containerName: 'Acme - Server' });
  const json = JSON.stringify(v);
  assert.ok(!json.includes('EAA-super-secret-token-value'), 'token value must not reach the renderer');
  const meta = v.tags.find((t) => t.name === 'Meta CAPI - Lead')!;
  assert.ok(meta.notes.includes('credential configured (value not shown)'));
  assert.ok(meta.notes.includes('PAUSED'));
});

test('on-screen view: audit findings mapped with a readable where', () => {
  const v = buildServerDocView(snap(), { containerName: 'X' }, {
    findings: [{ severity: 'high', message: 'm', recommendation: 'r', resource: { kind: 'tag', name: 'T' } }],
    summary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  } as never);
  assert.deepEqual(v.findings, [{ severity: 'high', where: 'tag "T"', message: 'm', recommendation: 'r' }]);
  assert.deepEqual(buildServerDocView(snap(), { containerName: 'X' }).findings, [], 'no audit -> no findings, never fabricated');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
