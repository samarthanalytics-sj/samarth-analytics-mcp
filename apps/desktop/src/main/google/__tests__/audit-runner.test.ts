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
import { auditWorkspace, auditServerWorkspace, containerKind } from '../audit-runner';
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void main();
