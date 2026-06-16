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
    listGtmWorkspaces: async (a: string, c: string) => {
      calls.push(`gtmWorkspaces:${a}:${c}`);
      return [];
    },
    listGtmTags: async (a: string, c: string, w: string) => {
      calls.push(`gtmTags:${a}:${c}:${w}`);
      return [];
    },
    listGa4DataStreams: async (p: string) => {
      calls.push(`ga4Streams:${p}`);
      return [];
    },
    runGa4Report: async (input: { property: string; metrics: string[] }) => {
      calls.push(`ga4Report:${input.property}:${input.metrics.join(',')}`);
      return { dimensionHeaders: [], metricHeaders: [], rows: [] };
    },
    createGtmWorkspace: async (a: string, c: string, name: string) => {
      calls.push(`createWorkspace:${a}:${c}:${name}`);
      return { workspaceId: 'w9', name, path: 'p' };
    },
    deleteGtmTag: async (a: string, c: string, w: string, t: string) => {
      calls.push(`deleteTag:${a}:${c}:${w}:${t}`);
      return { deleted: true, tagId: t };
    },
  } as unknown as GoogleDataService;
  return { data, calls };
}

// A confirm() that answers a fixed sequence and records each proposal.
function seqConfirm(...answers: boolean[]): {
  fn: (p: { destructive?: boolean }) => Promise<boolean>;
  calls: Array<{ destructive?: boolean }>;
} {
  let i = 0;
  const seen: Array<{ destructive?: boolean }> = [];
  return {
    calls: seen,
    fn: async (p) => {
      seen.push(p);
      return answers[Math.min(i++, answers.length - 1)];
    },
  };
}

async function main(): Promise<void> {
console.log('\nTool registry:');

await test('exposes the read-only tools with schemas', async () => {
  const reg = buildToolRegistry(fakeData().data);
  const names = reg.list().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'list_ga4_accounts',
    'list_ga4_data_streams',
    'list_ga4_properties',
    'list_gtm_accounts',
    'list_gtm_containers',
    'list_gtm_tags',
    'list_gtm_workspaces',
    'run_ga4_report',
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
  await reg.execute('list_gtm_tags', { accountId: '1', containerId: '2', workspaceId: '3' });
  await reg.execute('run_ga4_report', {
    property: 'properties/5',
    startDate: '7daysAgo',
    endDate: 'today',
    metrics: ['activeUsers'],
  });
  assert.ok(calls.includes('gtmContainers:9'));
  assert.ok(calls.includes('ga4Properties:accounts/7'));
  assert.ok(calls.includes('gtmTags:1:2:3'));
  assert.ok(calls.includes('ga4Report:properties/5:activeUsers'));
});

await test('unknown tool rejects', async () => {
  const reg = buildToolRegistry(fakeData().data);
  await assert.rejects(() => reg.execute('nope', {}), /Unknown tool/);
});

await test('write tools appear ONLY when a confirm function is provided', async () => {
  const readOnly = buildToolRegistry(fakeData().data);
  assert.equal(readOnly.list().length, 8, 'read-only registry has 8 tools');
  assert.equal(readOnly.list().some((t) => t.name === 'create_gtm_tag'), false);

  const withWrites = buildToolRegistry(fakeData().data, async () => true);
  assert.equal(withWrites.list().length, 14, 'read + write registry has 14 tools');
  assert.equal(withWrites.list().some((t) => t.name === 'create_gtm_tag'), true);
  assert.equal(withWrites.list().some((t) => t.name === 'delete_gtm_tag'), true);
});

await test('delete_gtm_tag requires TWO confirmations; applies only after both', async () => {
  const fd = fakeData();
  const c = seqConfirm(true, true);
  const reg = buildToolRegistry(fd.data, c.fn);
  await reg.execute('delete_gtm_tag', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '9' });
  assert.equal(c.calls.length, 2, 'asked twice');
  assert.equal(c.calls[1].destructive, true, 'second prompt is the destructive final confirm');
  assert.ok(fd.calls.includes('deleteTag:1:2:3:9'), 'deleted after both approvals');
});

await test('delete declines on the 2nd confirmation → no API call', async () => {
  const fd = fakeData();
  const c = seqConfirm(true, false);
  const reg = buildToolRegistry(fd.data, c.fn);
  const out = await reg.execute('delete_gtm_tag', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '9' });
  assert.equal(JSON.parse(out).declined, true);
  assert.equal(c.calls.length, 2);
  assert.equal(fd.calls.length, 0, 'nothing deleted');
});

await test('delete declines on the 1st confirmation → only one prompt, no API call', async () => {
  const fd = fakeData();
  const c = seqConfirm(false);
  const reg = buildToolRegistry(fd.data, c.fn);
  await reg.execute('delete_gtm_tag', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '9' });
  assert.equal(c.calls.length, 1, 'no second prompt after first rejection');
  assert.equal(fd.calls.length, 0);
});

await test('write executes on approval, declines (no API call) on rejection', async () => {
  const approve = fakeData();
  const regYes = buildToolRegistry(approve.data, async () => true);
  await regYes.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'Draft' });
  assert.ok(approve.calls.includes('createWorkspace:1:2:Draft'), 'applied on approval');

  const reject = fakeData();
  const regNo = buildToolRegistry(reject.data, async () => false);
  const out = await regNo.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'Draft' });
  assert.equal(JSON.parse(out).declined, true);
  assert.equal(reject.calls.length, 0, 'no API call when the user declines');
});

await test('write tool is unavailable without confirm (not registered, no API call)', async () => {
  const fd = fakeData();
  const reg = buildToolRegistry(fd.data);
  await assert.rejects(
    () => reg.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'X' }),
    /Unknown tool/
  );
  assert.equal(fd.calls.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
