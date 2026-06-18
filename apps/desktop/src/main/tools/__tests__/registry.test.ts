import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolRegistry } from '../registry';
import { AuditHistoryStore } from '../../storage/audit-history';
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

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

// Records calls so we can assert the registry routes args correctly.
function fakeData(
  opts: {
    existingTriggers?: Array<{ triggerId: string; name: string; type: string }>;
    snapshot?: {
      tags: Array<Record<string, unknown>>;
      triggers: Array<Record<string, unknown>>;
      variables: Array<Record<string, unknown>>;
    };
    liveSnapshot?: {
      tags: Array<Record<string, unknown>>;
      triggers: Array<Record<string, unknown>>;
      variables: Array<Record<string, unknown>>;
    } | null;
  } = {}
): { data: GoogleDataService; calls: string[] } {
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
    listGtmTriggers: async (a: string, c: string, w: string) => {
      calls.push(`listTriggers:${a}:${c}:${w}`);
      return opts.existingTriggers ?? [];
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
    setGtmTagPaused: async (a: string, c: string, w: string, t: string, paused: boolean) => {
      calls.push(`setPaused:${a}:${c}:${w}:${t}:${paused}`);
      return { tagId: t, name: '', type: '' };
    },
    deleteGtmTrigger: async (a: string, c: string, w: string, t: string) => {
      calls.push(`deleteTrigger:${a}:${c}:${w}:${t}`);
      return { deleted: true, triggerId: t };
    },
    deleteGtmVariable: async (a: string, c: string, w: string, v: string) => {
      calls.push(`deleteVar:${a}:${c}:${w}:${v}`);
      return { deleted: true, variableId: v };
    },
    createGtmTrigger: async (a: string, c: string, w: string, trig: Record<string, unknown>) => {
      calls.push(`createTrigger:${a}:${c}:${w}:${String(trig.name ?? '')}`);
      return { triggerId: 'NEW1', name: String(trig.name ?? ''), type: String(trig.type ?? '') };
    },
    createGtmTag: async (a: string, c: string, w: string, tag: Record<string, unknown>) => {
      calls.push(`createTag:${a}:${c}:${w}:${JSON.stringify(tag.firingTriggerId ?? [])}`);
      return { tagId: 'TAG1', name: String(tag.name ?? ''), type: String(tag.type ?? '') };
    },
    enableGtmBuiltInVariables: async (a: string, c: string, w: string, types: string[]) => {
      calls.push(`enableVars:${a}:${c}:${w}:${types.join(',')}`);
      return types;
    },
    createGtmVariable: async (a: string, c: string, w: string, v: Record<string, unknown>) => {
      calls.push(`createVar:${a}:${c}:${w}:${String(v.type)}:${String(v.name)}`);
      return { variableId: 'V1', name: String(v.name ?? ''), type: String(v.type ?? '') };
    },
    getGtmContainerSnapshot: async (a: string, c: string, w: string) => {
      calls.push(`snapshot:${a}:${c}:${w}`);
      return (
        opts.snapshot ?? {
          tags: [{ tagId: '1', name: 'Orphan', type: 'html', firingTriggerId: [], paused: false, parameter: [] }],
          triggers: [],
          variables: [],
        }
      );
    },
    getGtmLiveVersionSnapshot: async (a: string, c: string) => {
      calls.push(`live:${a}:${c}`);
      return opts.liveSnapshot === undefined ? null : opts.liveSnapshot;
    },
  } as unknown as GoogleDataService;
  return { data, calls };
}

// Approve unchanged: returns the proposal args as-is.
const approveAsIs = async (p: { details: Record<string, unknown> }) => p.details;
const reject = async () => null;

// A confirm() answering a fixed yes/no sequence; records each proposal.
function seqConfirm(...answers: boolean[]): {
  fn: (p: { details: Record<string, unknown>; destructive?: boolean }) => Promise<Record<string, unknown> | null>;
  calls: Array<{ destructive?: boolean }>;
} {
  let i = 0;
  const seen: Array<{ destructive?: boolean }> = [];
  return {
    calls: seen,
    fn: async (p) => {
      seen.push(p);
      return answers[Math.min(i++, answers.length - 1)] ? p.details : null;
    },
  };
}

async function main(): Promise<void> {
  console.log('\nTool registry:');

  await test('exposes the read-only tools with schemas', async () => {
    const reg = buildToolRegistry(fakeData().data);
    const names = reg.list().map((t) => t.name).sort();
    assert.deepEqual(names, [
      'audit_gtm_container',
      'audit_gtm_container_changes',
      'diff_gtm_workspace_vs_live',
      'list_ga4_accounts',
      'list_ga4_data_streams',
      'list_ga4_properties',
      'list_gtm_accounts',
      'list_gtm_containers',
      'list_gtm_tags',
      'list_gtm_triggers',
      'list_gtm_workspaces',
      'run_ga4_report',
    ]);
  });

  await test('execute routes args and returns JSON', async () => {
    const { data, calls } = fakeData();
    const reg = buildToolRegistry(data);
    const out = await reg.execute('list_gtm_accounts', {});
    assert.equal(JSON.parse(out)[0].accountId, '1');
    await reg.execute('list_gtm_tags', { accountId: '1', containerId: '2', workspaceId: '3' });
    await reg.execute('run_ga4_report', { property: 'properties/5', startDate: '7daysAgo', endDate: 'today', metrics: ['activeUsers'] });
    assert.ok(calls.includes('gtmTags:1:2:3'));
    assert.ok(calls.includes('ga4Report:properties/5:activeUsers'));
  });

  await test('unknown tool rejects', async () => {
    await assert.rejects(() => buildToolRegistry(fakeData().data).execute('nope', {}), /Unknown tool/);
  });

  await test('write tools appear ONLY when a confirm function is provided', async () => {
    const readOnly = buildToolRegistry(fakeData().data);
    assert.equal(readOnly.list().length, 12, 'read-only registry has 12 tools');
    assert.equal(readOnly.list().some((t) => t.name === 'create_gtm_tag'), false);

    const withWrites = buildToolRegistry(fakeData().data, approveAsIs);
    assert.equal(withWrites.list().length, 25, 'read + write registry has 25 tools');
    assert.equal(withWrites.list().some((t) => t.name === 'create_gtm_tracking_tag'), true);
    assert.equal(withWrites.list().some((t) => t.name === 'create_gtm_variable_typed'), true);
    for (const fixTool of ['set_gtm_tag_paused', 'delete_gtm_trigger', 'delete_gtm_variable']) {
      assert.equal(withWrites.list().some((t) => t.name === fixTool), true, `${fixTool} is registered`);
    }
  });

  await test('audit_gtm_container returns counts + findings', async () => {
    const reg = buildToolRegistry(fakeData().data);
    const out = JSON.parse(await reg.execute('audit_gtm_container', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(out.counts.tags, 1);
    assert.ok(out.findings.some((f: { message: string }) => f.message.includes('no firing trigger')));
  });

  await test('audit injects workspace ids into auto-fixes (paused + unused trigger)', async () => {
    const fd = fakeData({
      snapshot: {
        tags: [
          {
            tagId: '7', name: 'Paused GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: true,
            parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'purchase' }],
            consentSettings: { consentStatus: 'needed' },
          },
        ],
        triggers: [
          { triggerId: 'T1', name: 'Used', type: 'pageview' },
          { triggerId: 'T2', name: 'Lonely', type: 'pageview' },
        ],
        variables: [],
      },
    });
    const reg = buildToolRegistry(fd.data); // audit is read-only
    const out = JSON.parse(await reg.execute('audit_gtm_container', { accountId: '1', containerId: '2', workspaceId: '3' }));

    const paused = out.findings.find((f: { category: string }) => f.category === 'paused');
    assert.ok(paused?.fix, 'paused finding carries a fix');
    assert.equal(paused.fix.tool, 'set_gtm_tag_paused');
    assert.deepEqual(paused.fix.args, { accountId: '1', containerId: '2', workspaceId: '3', tagId: '7', paused: false, name: 'Paused GA4' });

    const unused = out.findings.find(
      (f: { category: string; resource?: { kind: string } }) => f.category === 'unused' && f.resource?.kind === 'trigger'
    );
    assert.equal(unused.fix.tool, 'delete_gtm_trigger');
    assert.deepEqual(unused.fix.args, { accountId: '1', containerId: '2', workspaceId: '3', triggerId: 'T2', name: 'Lonely' });
    // The healthy GA4 tag (mid + eventName + consent needed) raises no GA4/consent finding.
    assert.equal(out.findings.some((f: { category: string }) => f.category === 'ga4' || f.category === 'consent'), false);
  });

  await test('fix tools apply: unpause (one confirm), delete trigger/variable (two confirms)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    await reg.execute('set_gtm_tag_paused', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '7', paused: false });
    assert.ok(fd.calls.includes('setPaused:1:2:3:7:false'), 'unpaused the tag');

    const ct = seqConfirm(true, true);
    await buildToolRegistry(fd.data, ct.fn).execute('delete_gtm_trigger', { accountId: '1', containerId: '2', workspaceId: '3', triggerId: 'T2' });
    assert.equal(ct.calls.length, 2, 'delete trigger asked twice');
    assert.ok(fd.calls.includes('deleteTrigger:1:2:3:T2'), 'deleted the trigger after both approvals');

    const cv = seqConfirm(true, false);
    const out = await buildToolRegistry(fd.data, cv.fn).execute('delete_gtm_variable', { accountId: '1', containerId: '2', workspaceId: '3', variableId: 'V5' });
    assert.equal(JSON.parse(out).declined, true, 'declining the 2nd confirm cancels the variable delete');
    assert.ok(!fd.calls.includes('deleteVar:1:2:3:V5'), 'variable NOT deleted when 2nd confirm declined');
  });

  await test('diff_gtm_workspace_vs_live: no published version → pending note', async () => {
    const fd = fakeData(); // liveSnapshot undefined → getGtmLiveVersionSnapshot returns null
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('diff_gtm_workspace_vs_live', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(out.publishedVersion, null);
    assert.ok(String(out.note).includes('No published version'));
    assert.ok(fd.calls.includes('live:1:2'), 'fetched the live version');
  });

  await test('diff_gtm_workspace_vs_live: reports config drift vs the live version', async () => {
    const fd = fakeData({
      liveSnapshot: { tags: [{ tagId: '1', name: 'A', type: 'html', firingTriggerId: ['T1'], paused: false, parameter: [] }], triggers: [], variables: [] },
      snapshot: { tags: [{ tagId: '1', name: 'A', type: 'html', firingTriggerId: ['T1'], paused: true, parameter: [] }], triggers: [], variables: [] }, // paused flipped
    });
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('diff_gtm_workspace_vs_live', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(out.publishedVersion, 'live');
    assert.deepEqual(out.drift.tags.modified.map((t: { id: string }) => t.id), ['1']);
    assert.equal(out.drift.changeCount, 1);
  });

  await test('audit_gtm_container_changes: baseline first, NEW issues on second run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samarth-reg-hist-'));
    const history = new AuditHistoryStore(join(dir, 'h.json'));
    let snap: { tags: Array<Record<string, unknown>>; triggers: never[]; variables: never[] } = { tags: [], triggers: [], variables: [] };
    const data = { getGtmContainerSnapshot: async () => snap } as unknown as GoogleDataService;
    const reg = buildToolRegistry(data, undefined, undefined, history);

    const first = JSON.parse(await reg.execute('audit_gtm_container_changes', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(first.firstRun, true);
    assert.equal(first.since, null);

    snap = { tags: [{ tagId: '9', name: 'Orphan', type: 'html', firingTriggerId: [], paused: false, parameter: [] }], triggers: [], variables: [] };
    const second = JSON.parse(await reg.execute('audit_gtm_container_changes', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(second.firstRun, false);
    assert.ok(second.drift.newFindings.some((f: { message: string }) => f.message.includes('no firing trigger')), 'reports the new orphan-tag issue');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('audit_gtm_container_changes without history degrades gracefully', async () => {
    const reg = buildToolRegistry(fakeData().data); // no history store
    const out = JSON.parse(await reg.execute('audit_gtm_container_changes', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.ok(String(out.error).includes('unavailable'));
  });

  await test('create_tracking_tag (ga4_event) builds correct tag + reuses trigger', async () => {
    const fd = fakeData({ existingTriggers: [{ triggerId: 'T9', name: 'Email link click', type: 'linkClick' }] });
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'ga4_event', tagName: 'GA4 - email', measurementId: 'G-XYZ', eventName: 'email_click',
        eventParameters: [{ name: 'link_url', value: '{{Click URL}}' }],
        trigger: { name: 'Email link click', kind: 'link_click', clickUrlValue: 'mailto:' },
      })
    );
    assert.equal(out.trigger.reused, true);
    assert.ok(fd.calls.includes('enableVars:1:2:3:clickUrl'), 'auto-enabled clickUrl');
    assert.ok(!fd.calls.some((c) => c.startsWith('createTrigger')), 'reused, did not create trigger');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag') && c.includes('T9')), 'tag linked to existing trigger');
  });

  await test('create_gtm_variable_typed builds a Custom JS variable', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    await reg.execute('create_gtm_variable_typed', {
      accountId: '1', containerId: '2', workspaceId: '3',
      kind: 'javascript', name: 'JS - Page Title', javascript: 'function(){return document.title;}',
    });
    assert.ok(fd.calls.some((c) => c.startsWith('createVar:1:2:3:jsm:JS - Page Title')), 'created a jsm variable');
  });

  await test('product scopes the toolset (gtm vs ga4)', async () => {
    const gtm = buildToolRegistry(fakeData().data, approveAsIs, 'gtm');
    const gtmNames = gtm.list().map((t) => t.name);
    assert.ok(gtmNames.every((n) => n.includes('gtm')), 'gtm mode lists only gtm tools');
    assert.ok(gtmNames.includes('create_gtm_tag_with_trigger'));
    assert.ok(!gtmNames.some((n) => n.includes('ga4')));

    const ga4 = buildToolRegistry(fakeData().data, undefined, 'ga4');
    const ga4Names = ga4.list().map((t) => t.name);
    assert.ok(ga4Names.every((n) => n.includes('ga4')), 'ga4 mode lists only ga4 tools');
  });

  await test('confirm can edit args before they are applied', async () => {
    const { data, calls } = fakeData();
    // Approve but rename the workspace.
    const reg = buildToolRegistry(data, async (p) => ({ ...p.details, name: 'Edited Name' }));
    await reg.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'Original' });
    assert.ok(calls.includes('createWorkspace:1:2:Edited Name'), 'applied the edited value');
  });

  await test('create_gtm_tag_with_trigger REUSES an existing trigger + enables vars + links tag', async () => {
    const fd = fakeData({ existingTriggers: [{ triggerId: 'T1', name: 'Email link click', type: 'linkClick' }] });
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = await reg.execute('create_gtm_tag_with_trigger', {
      accountId: '1',
      containerId: '2',
      workspaceId: '3',
      tag: { name: 'GA4 - email', type: 'gaawe' },
      trigger: { name: 'Email link click', type: 'linkClick' },
      builtInVariables: ['clickUrl'],
    });
    const res = rec(JSON.parse(out));
    assert.equal(rec(res.trigger).reused, true);
    assert.equal(rec(res.trigger).triggerId, 'T1');
    assert.ok(fd.calls.includes('enableVars:1:2:3:clickUrl'), 'enabled the built-in variable');
    assert.ok(!fd.calls.some((c) => c.startsWith('createTrigger')), 'did NOT create a duplicate trigger');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag') && c.includes('T1')), 'tag linked to existing trigger');
  });

  await test('create_gtm_tag_with_trigger creates the trigger when none exists', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    await reg.execute('create_gtm_tag_with_trigger', {
      accountId: '1',
      containerId: '2',
      workspaceId: '3',
      tag: { name: 't', type: 'gaawe' },
      trigger: { name: 'New trigger', type: 'linkClick' },
    });
    assert.ok(fd.calls.some((c) => c.startsWith('createTrigger:1:2:3:New trigger')), 'created the trigger');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag')), 'created the tag');
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

  await test('write declines (no API call) on rejection', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, reject);
    const out = await reg.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'Draft' });
    assert.equal(JSON.parse(out).declined, true);
    assert.equal(fd.calls.length, 0, 'no API call when declined');
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
