import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorService } from '../monitor-service';
import { AuditHistoryStore } from '../../storage/audit-history';
import type { GoogleDataService } from '../../google/data-service';
import type { AccountView, MonitorAlert } from '../../../shared/ipc';
import type { ContainerSnapshot } from '../../google/gtm-builders';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'samarth-monitor-'));

const tag = (over: Record<string, unknown>) => ({
  tagId: '', name: '', type: 'html', firingTriggerId: [] as string[], paused: false,
  parameter: [] as Array<Record<string, unknown>>, ...over,
});
const emptySnap = (): ContainerSnapshot => ({ tags: [], triggers: [], variables: [] });

const activeView = (over: Partial<AccountView> = {}): AccountView => ({
  id: 'a1', email: 'x@y.com', createdAt: 0, isActive: true, hasGoogleToken: true,
  gtmContext: { accountId: '1', containerId: '2', containerName: 'Web', workspaceId: '3' },
  ...over,
});

// Harness: a MonitorService wired to fakes, with the snapshot the audit sees
// swappable between runs and a settable active view.
function harness(file: string) {
  let snapshot: ContainerSnapshot = emptySnap();
  let view: AccountView | null = activeView();
  let t = 1000;
  const alerts: MonitorAlert[] = [];
  const data = {
    getGtmContainerSnapshot: async () => snapshot,
  } as unknown as GoogleDataService;
  const service = new MonitorService({
    registry: { getActiveView: () => view },
    data,
    history: new AuditHistoryStore(join(dir, file)),
    emit: (a) => alerts.push(a),
    now: () => (t += 1000),
  });
  return {
    service,
    alerts,
    setSnapshot: (s: ContainerSnapshot) => { snapshot = s; },
    setView: (v: AccountView | null) => { view = v; },
  };
}

async function main(): Promise<void> {
  console.log('\nMonitorService:');

  await test('runOnce returns null when nothing is selected/signed-in', async () => {
    const h = harness('a.json');
    h.setView(null);
    assert.equal(await h.service.runOnce(), null);
    h.setView(activeView({ hasGoogleToken: false }));
    assert.equal(await h.service.runOnce(), null);
    h.setView(activeView({ gtmContext: { accountId: '1' } })); // no container/workspace
    assert.equal(await h.service.runOnce(), null);
    assert.equal(h.alerts.length, 0, 'never emitted');
  });

  await test('first run establishes a baseline (no alert) even with findings', async () => {
    const h = harness('b.json');
    h.setSnapshot({ ...emptySnap(), tags: [tag({ tagId: '1', name: 'Paused', paused: true })] });
    const out = await h.service.runOnce();
    assert.equal(out, null, 'baseline run does not alert');
    assert.equal(h.alerts.length, 0);
  });

  await test('second run alerts on NEW findings only', async () => {
    const h = harness('c.json');
    // Baseline: one paused tag.
    h.setSnapshot({ ...emptySnap(), tags: [tag({ tagId: '1', name: 'Paused', paused: true })] });
    await h.service.runOnce();
    // Now an orphan tag (no trigger) appears → one NEW finding.
    h.setSnapshot({
      ...emptySnap(),
      tags: [tag({ tagId: '1', name: 'Paused', paused: true }), tag({ tagId: '2', name: 'Orphan', firingTriggerId: [] })],
    });
    const out = await h.service.runOnce();
    assert.ok(out, 'emitted an alert');
    assert.equal(h.alerts.length, 1);
    assert.ok(out!.newFindings.some((f) => f.message.includes('no firing trigger')), 'reports the new issue');
    assert.ok(out!.newFindings.every((f) => !f.message.includes('is paused')), 'unchanged paused issue is NOT re-reported');
    assert.equal(out!.containerName, 'Web');
  });

  await test('no alert when nothing changed since last run', async () => {
    const h = harness('d.json');
    const snap = { ...emptySnap(), tags: [tag({ tagId: '1', name: 'Paused', paused: true })] };
    h.setSnapshot(snap);
    await h.service.runOnce(); // baseline
    const out = await h.service.runOnce(); // identical
    assert.equal(out, null);
    assert.equal(h.alerts.length, 0);
  });

  await test('records lastError on failure, returns null', async () => {
    const data = { getGtmContainerSnapshot: async () => { throw new Error('boom'); } } as unknown as GoogleDataService;
    const service = new MonitorService({
      registry: { getActiveView: () => activeView() },
      data,
      history: new AuditHistoryStore(join(dir, 'e.json')),
      emit: () => undefined,
      now: () => 1,
    });
    assert.equal(await service.runOnce(), null);
    assert.equal(service.status().lastError, 'boom');
  });

  await test('configure clamps the interval to >= 5 min and persists', async () => {
    const file = join(dir, 'cfg.json');
    const make = () =>
      new MonitorService({
        registry: { getActiveView: () => null },
        data: {} as GoogleDataService,
        history: new AuditHistoryStore(join(dir, 'h.json')),
        emit: () => undefined,
        configPath: file,
      });
    const s1 = make();
    const st = s1.configure({ intervalMinutes: 1 });
    assert.equal(st.intervalMinutes, 5, 'clamped to minimum');
    assert.equal(st.enabled, false);
    assert.ok(existsSync(file), 'persisted config to disk');
    // A fresh instance loads the persisted config.
    const s2 = make();
    assert.equal(s2.status().intervalMinutes, 5);
  });

  await test('configure({enabled:true}) reports running, then stop() clears it', async () => {
    const h = harness('run.json');
    const st = h.service.configure({ enabled: true });
    assert.equal(st.running, true);
    h.service.stop();
    assert.equal(h.service.status().running, false);
  });

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
