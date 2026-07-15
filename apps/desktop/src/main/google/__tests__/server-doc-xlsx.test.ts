import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildServerDocXlsx } from '../server-doc-xlsx';
import type { AuditTag, AuditTrigger, ServerContainerSnapshot } from '../gtm-builders';

let passed = 0;
let failed = 0;
let pending = 0;
function test(name: string, fn: () => Promise<void>): void {
  pending++;
  fn()
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) { console.log(`\n${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); } });
}

const snap = (): ServerContainerSnapshot => ({
  taggingServerUrls: ['https://sgtm.example.com'],
  clients: [{ clientId: 'c1', name: 'GA4 Client', type: 'gaaw_client' }],
  tags: [
    {
      tagId: 's2', name: 'Meta CAPI - Lead', type: 'cvt_x_1', firingTriggerId: ['91'], blockingTriggerId: [], paused: false,
      parameter: [
        { type: 'template', key: 'pixelId', value: '123456789012345' },
        { type: 'template', key: 'accessToken', value: 'EAA-super-secret-token-value' },
      ],
      consentSettings: null,
    } as AuditTag,
  ],
  triggers: [
    { triggerId: '91', name: 'ce - lead', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: 'generate_lead' }] }], filter: [], autoEventFilter: [], parameter: [] } as unknown as AuditTrigger,
  ],
  variables: [{ variableId: 'v1', name: 'ed - email', type: 'ed', parameter: [] }],
  transformations: [],
});

console.log('\nserver-doc-xlsx:');

test('workbook has all six sheets with the documented rows, and NO secret value anywhere', async () => {
  const buf = await buildServerDocXlsx(snap(), { containerName: 'Acme - Server', publicId: 'GTM-SRV1', workspaceName: 'Default' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Overview', 'Clients', 'Tags', 'Triggers', 'Variables', 'Transformations']);
  const tags = wb.getWorksheet('Tags')!;
  assert.equal(tags.getCell('A2').value, 'Meta CAPI - Lead');
  assert.equal(tags.getCell('C2').value, 'pixel 123456789012345', 'destination is the id, not the credential');
  assert.ok(String(tags.getCell('F2').value).includes('credential configured (value not shown)'));
  const clients = wb.getWorksheet('Clients')!;
  assert.equal(clients.getCell('A2').value, 'GA4 Client');
  const triggers = wb.getWorksheet('Triggers')!;
  assert.ok(String(triggers.getCell('C2').value).includes('generate_lead'), 'trigger condition documented');
  // Secret redaction across the WHOLE workbook.
  let all = '';
  for (const ws of wb.worksheets) ws.eachRow((r) => r.eachCell((c) => { all += String(c.value ?? '') + '|'; }));
  assert.ok(!all.includes('EAA-super-secret-token-value'), 'token appears nowhere in the workbook');
  assert.ok(all.includes('Configuration-level documentation'), 'overview note present');
});
