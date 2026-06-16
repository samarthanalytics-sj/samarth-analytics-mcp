import assert from 'node:assert/strict';
import { buildToolRegistry } from '../registry';
import type { GoogleDataService } from '../../google/data-service';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// Records calls so we can assert the registry routes args correctly.
function fakeData(): { data: GoogleDataService; calls: string[] } {
  const calls: string[] = [];
  const data = {
    listGtmAccounts: async () => {
      calls.push('gtmAccounts');
      return [{ accountId: '1', name: 'A', path: 'accounts/1' }];
    },
    listGtmContainers: async (id: string) => {
      calls.push(`gtmContainers:${id}`);
      return [];
    },
    listGa4Accounts: async () => {
      calls.push('ga4Accounts');
      return [];
    },
    listGa4Properties: async (account: string) => {
      calls.push(`ga4Properties:${account}`);
      return [];
    },
  } as unknown as GoogleDataService;
  return { data, calls };
}

async function main(): Promise<void> {
console.log('\nTool registry:');

await test('exposes the four read-only tools with schemas', async () => {
  const reg = buildToolRegistry(fakeData().data);
  const names = reg.list().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'list_ga4_accounts',
    'list_ga4_properties',
    'list_gtm_accounts',
    'list_gtm_containers',
  ]);
  const containers = reg.list().find((t) => t.name === 'list_gtm_containers');
  assert.deepEqual((containers?.inputSchema as { required?: string[] }).required, ['accountId']);
});

await test('execute routes args and returns JSON', async () => {
  const { data, calls } = fakeData();
  const reg = buildToolRegistry(data);
  const out = await reg.execute('list_gtm_accounts', {});
  assert.equal(JSON.parse(out)[0].accountId, '1');
  await reg.execute('list_gtm_containers', { accountId: '9' });
  await reg.execute('list_ga4_properties', { account: 'accounts/7' });
  assert.ok(calls.includes('gtmContainers:9'));
  assert.ok(calls.includes('ga4Properties:accounts/7'));
});

await test('unknown tool rejects', async () => {
  const reg = buildToolRegistry(fakeData().data);
  await assert.rejects(() => reg.execute('nope', {}), /Unknown tool/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
