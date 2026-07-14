import assert from 'node:assert/strict';
import { serverContainerDocMarkdown, serverContainerDocCsv } from '../server-doc';
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
