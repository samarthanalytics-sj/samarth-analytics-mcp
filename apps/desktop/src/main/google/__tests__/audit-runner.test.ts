/**
 * The audit runner picks the engine by CONTAINER TYPE, whatever surface asked.
 *
 * A server container audited by the web engine is pure noise: every reference to a server
 * built-in ({{Client Name}}, {{Request Path}}) reads as an undefined variable. A real 33-tag
 * server container came back with 125 findings and not one true one, because both the Audit tab
 * and the chat's audit_gtm_container reached auditWorkspace without checking the type.
 *
 * Run: tsx src/main/google/__tests__/audit-runner.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditWorkspace, auditServerWorkspace, auditChanges, containerKind, pairFindingsFor } from '../audit-runner';
import { AuditHistoryStore } from '../../storage/audit-history';
import type { GoogleDataService } from '../data-service';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

const ctx = { accountId: 'A', containerId: 'C1', workspaceId: 'W' };

/** A data service that records which snapshot was requested. */
function stub(usageContext: string[] | undefined, opts?: { listFails?: boolean }) {
  const calls: string[] = [];
  const data = {
    listGtmContainers: async () => {
      if (opts?.listFails) throw new Error('quota');
      return [{ containerId: 'C1', name: 'x', publicId: 'GTM-X', usageContext }];
    },
    getGtmContainerSnapshot: async () => {
      calls.push('web');
      // A server-style tag: under the WEB engine its built-in refs would read as undefined.
      return { tags: [{ tagId: '1', name: 'GA4 Relay', type: 'sgtmgaaw', firingTriggerId: ['9'], blockingTriggerId: [], paused: false, parameter: [{ key: 'measurementId', value: '{{Client Name}}' }], consentSettings: null }], triggers: [{ triggerId: '9', name: 'All', type: 'customEvent' }], variables: [] };
    },
    getServerContainerSnapshot: async () => {
      calls.push('server');
      return { taggingServerUrls: [], clients: [], tags: [{ tagId: '1', name: 'GA4 Relay', type: 'sgtmgaaw', firingTriggerId: ['9'], blockingTriggerId: [], paused: false, parameter: [], consentSettings: null }], triggers: [{ triggerId: '9', name: 'All', type: 'customEvent' }], variables: [], transformations: [] };
    },
  };
  return { data: data as unknown as GoogleDataService, calls };
}

async function main(): Promise<void> {
  console.log('\naudit-runner:');

  await test('containerKind reads usageContext case-insensitively, and returns null when it cannot know', async () => {
    assert.equal(await containerKind(stub(['SERVER']).data, ctx), 'server');
    assert.equal(await containerKind(stub(['server']).data, ctx), 'server');
    assert.equal(await containerKind(stub(['web']).data, ctx), 'web');
    assert.equal(await containerKind(stub(undefined).data, ctx), 'web', 'no usageContext at all is a web container');
    assert.equal(await containerKind(stub(['web'], { listFails: true }).data, ctx), null, 'a failed lookup never invents a type');
    assert.equal(await containerKind(stub(['web']).data, { accountId: 'A', containerId: 'NOPE' }), null);
  });

  await test('auditWorkspace on a SERVER container uses the server engine, not the web one', async () => {
    const { data, calls } = stub(['server']);
    const rep = await auditWorkspace(data, ctx);
    assert.deepEqual(calls, ['server'], 'the web snapshot was never fetched');
    assert.ok(rep.findings.some((f) => /NO client/i.test(f.message)), 'server-engine findings');
    assert.ok(!rep.findings.some((f) => /Client Name/.test(f.message)), 'no "undefined built-in" noise');
    assert.equal(rep.inventory, undefined, 'a server container has no web inventory');
  });

  await test('auditWorkspace on a WEB container still uses the web engine', async () => {
    const { data, calls } = stub(['web']);
    await auditWorkspace(data, ctx);
    assert.deepEqual(calls, ['web']);
  });

  await test('when the type cannot be determined, today\'s behaviour is kept (web engine)', async () => {
    const { data, calls } = stub(['server'], { listFails: true });
    await auditWorkspace(data, ctx);
    assert.deepEqual(calls, ['web'], 'falls through rather than guessing');
  });

  await test('auditServerWorkspace on a WEB container refuses and names the right tool', async () => {
    const { data, calls } = stub(['web']);
    await assert.rejects(() => auditServerWorkspace(data, ctx), /WEB container.*audit_gtm_container/);
    assert.deepEqual(calls, [], 'nothing fetched');
  });

  await test('fix arguments carry the validated workspace ids on both routes', async () => {
    const srv = stub(['server']);
    srv.data.getServerContainerSnapshot = (async () => ({
      taggingServerUrls: ['https://s.example.com'], clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
      tags: [{ tagId: '7', name: 'Relay', type: 'sgtmgaaw', firingTriggerId: ['9'], blockingTriggerId: [], paused: true, parameter: [], consentSettings: null }],
      triggers: [{ triggerId: '9', name: 'All', type: 'customEvent' }], variables: [], transformations: [],
    })) as never;
    const rep = await auditWorkspace(srv.data, ctx);
    const paused = rep.findings.find((f) => f.fix);
    assert.ok(paused, 'the paused server tag carries a fix');
    assert.equal(paused!.fix!.args.containerId, 'C1');
    assert.equal(paused!.fix!.args.workspaceId, 'W');
  });

  await test('a failed PAIR read carries last run\'s pair findings forward: no false "resolved", no re-alert', async () => {
    // Run 1 records a critical pair finding. Run 2's web read fails part-way (a quota error on web
    // container 2 of 2): the pair leg used to return [], so the finding was stored as RESOLVED and
    // run 3 re-reported it as NEW, firing a monitor alert for something that never changed.
    const HOST = 'https://our.example.com';
    const wiredGoogleTag = { tagId: 't1', name: 'AUS GA4', type: 'googtag', firingTriggerId: ['1'], blockingTriggerId: [], paused: false, consentSettings: null,
      parameter: [{ type: 'template', key: 'tagId', value: 'G-AUAUAU1' }, { type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [
        { type: 'template', key: 'parameter', value: 'server_container_url' }, { type: 'template', key: 'parameterValue', value: HOST }] }] }] };
    let failSecondWeb = false;
    const reads: string[] = [];
    const data = {
      listGtmContainers: async () => [
        { containerId: 'S1', name: 'server', publicId: 'GTM-S', usageContext: ['server'] },
        { containerId: 'W1', name: 'web one', publicId: 'GTM-W1', usageContext: ['web'] },
        { containerId: 'W2', name: 'web two', publicId: 'GTM-W2', usageContext: ['web'] },
        { containerId: 'M1', name: 'app', publicId: 'GTM-M1', usageContext: ['android'] },
      ],
      getServerContainerSnapshot: async () => ({
        taggingServerUrls: [HOST], clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }],
        tags: [], triggers: [], variables: [], transformations: [], // the relay for G-AUAUAU1 is gone
      }),
      listGtmWorkspaces: async (_a: string, c: string) => { reads.push(`ws:${c}`); return [{ workspaceId: `${c}-ws`, name: 'Default Workspace', path: '' }]; },
      getGtmContainerSnapshot: async (_a: string, c: string) => {
        reads.push(`snap:${c}`);
        if (c === 'W2' && failSecondWeb) throw new Error('GTM read failed: socket hang up');
        return { tags: c === 'W1' ? [wiredGoogleTag] : [], triggers: [], variables: [] };
      },
    } as unknown as GoogleDataService;
    const dir = mkdtempSync(join(tmpdir(), 'samarth-pair-hist-'));
    try {
      const history = new AuditHistoryStore(join(dir, 'h.json'));
      const sctx = { accountId: 'A', containerId: 'S1', workspaceId: 'W' };
      const isPair = (f: { checkId?: string }) => f.checkId === 'pair_wired_but_unforwarded';

      const run1 = await auditChanges(data, history, sctx, 1);
      assert.equal(run1.firstRun, true);
      assert.equal(run1.pairUnavailable, false);
      assert.ok(run1.report.findings.some(isPair), 'run 1 records the critical pair finding');
      assert.ok(!reads.some((r) => r.endsWith(':M1')), 'a mobile container holds no Google tag and is never read');

      failSecondWeb = true;
      const run2 = await auditChanges(data, history, sctx, 2);
      assert.equal(run2.pairUnavailable, true, 'the run says the pair could not be read');
      assert.deepEqual(run2.drift.resolvedFindings.map((f) => f.checkId), [], 'nothing is falsely resolved');
      assert.deepEqual(run2.drift.newFindings.map((f) => f.checkId), []);
      assert.ok(run2.report.findings.some(isPair), 'the stored baseline still carries the pair finding');

      failSecondWeb = false;
      const run3 = await auditChanges(data, history, sctx, 3);
      assert.equal(run3.pairUnavailable, false);
      assert.deepEqual(run3.drift.newFindings.map((f) => f.checkId), [], 'the unchanged finding is NOT re-reported as new (no alert)');
      assert.deepEqual(run3.drift.resolvedFindings.map((f) => f.checkId), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('pairFindingsFor: null (unknown) when the type or the read fails, [] for a web container', async () => {
    const rep = { summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } } as never;
    assert.deepEqual(await pairFindingsFor(stub(['web']).data, ctx, rep), [], 'a web container has no pair leg');
    assert.equal(await pairFindingsFor(stub(['server'], { listFails: true }).data, ctx, rep), null, 'an undeterminable type is unknown, not "no findings"');
    // A server container whose web read throws: unknown, not [].
    const broken = {
      listGtmContainers: async () => [
        { containerId: 'C1', name: 'server', publicId: 'GTM-S', usageContext: ['server'] },
        { containerId: 'W9', name: 'web', publicId: 'GTM-W9', usageContext: ['web'] },
      ],
      getServerContainerSnapshot: async () => ({ taggingServerUrls: ['https://s.example.com'], clients: [], tags: [], triggers: [], variables: [], transformations: [] }),
      listGtmWorkspaces: async () => { throw new Error('boom'); },
    } as unknown as GoogleDataService;
    assert.equal(await pairFindingsFor(broken, ctx, rep), null, 'a failed web read is unknown, not "no findings"');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void main();
