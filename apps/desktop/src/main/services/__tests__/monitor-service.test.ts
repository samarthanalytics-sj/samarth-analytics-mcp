import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorService } from '../monitor-service';
import { MAX_TIMER_MS, MAX_INTERVAL_MINUTES, MAX_INTERVAL_HOURS, assertTimerMs } from '../timer-limits';
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


  await test('SERVER container: the pair is monitored; a wired web tag losing its server URL raises an alert', async () => {
    // A server container is remembered. Its account also holds one web container whose Google tag
    // points at the tagging host, and the server holds the relay for that tag's id.
    const HOST = 'https://our.example.com';
    const wiredCfg = (url: string) => ({ type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [
      { type: 'template', key: 'parameter', value: 'server_container_url' }, { type: 'template', key: 'parameterValue', value: url },
    ] }] });
    let webUrl: string | undefined = HOST;
    const webSnap = () => ({ tags: [tag({ tagId: 't1', name: 'AUS GA4', type: 'googtag', firingTriggerId: ['1'], parameter: [{ type: 'template', key: 'tagId', value: 'G-AUAUAU1' }, ...(webUrl ? [wiredCfg(webUrl)] : [])] })], triggers: [], variables: [] });
    const serverSnap = { taggingServerUrls: [HOST], clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }], transformations: [], variables: [], triggers: [{ triggerId: '90', name: 'All', type: 'always' }],
      tags: [tag({ tagId: 's1', name: 'AU relay', type: 'sgtmgaaw', firingTriggerId: ['90'], parameter: [{ type: 'template', key: 'measurementId', value: 'G-AUAUAU1' }] })] };
    const calls: string[] = [];
    const data = {
      listGtmContainers: async () => [
        { containerId: 'S', name: 'Server', publicId: 'GTM-S', usageContext: ['server'] },
        { containerId: 'W', name: 'Web', publicId: 'GTM-W', usageContext: ['web'] },
      ],
      listGtmWorkspaces: async () => [{ workspaceId: '3', name: 'Default Workspace', path: '' }],
      getServerContainerSnapshot: async () => { calls.push('server'); return serverSnap; },
      getGtmContainerSnapshot: async (_a: string, c: string) => { calls.push(`web:${c}`); return webSnap(); },
    } as unknown as GoogleDataService;
    const alerts: MonitorAlert[] = [];
    let t = 5000;
    const service = new MonitorService({
      registry: { getActiveView: () => activeView({ gtmContext: { accountId: '1', containerId: 'S', containerName: 'Server', workspaceId: '2' } }) },
      data, history: new AuditHistoryStore(join(dir, 'server-pair.json')), emit: (a) => alerts.push(a), now: () => (t += 1000),
    });
    assert.equal(await service.runOnce(), null, 'baseline: correct pair, no alert');
    assert.ok(calls.includes('server') && calls.includes('web:W'), 'the server engine ran and the paired web container was read');
    assert.ok(!calls.some((c) => c === 'web:S'), 'the server container itself was never audited with the web engine');

    // Regression: someone removes the server container URL from the web tag.
    webUrl = undefined;
    const alert = await service.runOnce();
    assert.ok(alert, 'the pair regression is a NEW finding, so it alerts');
    assert.ok(alert!.newFindings.some((f) => /"AUS GA4"/.test(f.message) && /straight to Google/.test(f.message)), alert!.newFindings.map((f) => f.message).join(' | '));
    assert.equal(alert!.newFindings[0].category, 'coverage');

    // Same state again: no new alert (it is not new any more).
    assert.equal(await service.runOnce(), null);
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

  // Regression: the interval was only floor-clamped. Past 2^31-1 ms (35791 min) Node replaces the delay
  // with 1 ms, so a "monthly" monitor would re-audit the container a thousand times a second.
  await test('configure clamps the interval to the setInterval ceiling, and the armed delay fits', async () => {
    const h = harness('ceiling.json');
    const delays: number[] = [];
    const realSetInterval = globalThis.setInterval;
    // Record the delay; arm a harmless timer so an overflowing delay cannot flood the test.
    globalThis.setInterval = ((fn: () => void, ms?: number) => { delays.push(Number(ms)); return realSetInterval(fn, 3_600_000); }) as typeof setInterval;
    try {
      assert.equal(h.service.configure({ intervalMinutes: 60 * 24 * 30 }).intervalMinutes, MAX_INTERVAL_MINUTES, '30 days is past the timer limit → clamped');
      assert.equal(h.service.configure({ intervalMinutes: Infinity }).intervalMinutes, MAX_INTERVAL_MINUTES, 'Infinity → clamped, not passed through');
      const st = h.service.configure({ enabled: true, intervalMinutes: 1e9 });
      assert.equal(st.intervalMinutes, MAX_INTERVAL_MINUTES);
      assert.equal(st.running, true);
      assert.equal(delays.length, 1, 'one timer armed');
      assert.ok(delays[0] >= 1 && delays[0] <= MAX_TIMER_MS, `armed delay ${delays[0]} must fit in a 32-bit timer`);
    } finally {
      h.service.stop();
      globalThis.setInterval = realSetInterval;
    }
    assert.equal(h.service.configure({ intervalMinutes: 120 }).intervalMinutes, 120, 'a normal interval is untouched');
  });

  await test('assertTimerMs: accepts 1..2^31-1 ms, rejects what Node would turn into 1 ms', () => {
    assert.equal(assertTimerMs(MAX_TIMER_MS), MAX_TIMER_MS);
    assert.equal(assertTimerMs(60_000), 60_000);
    for (const bad of [MAX_TIMER_MS + 1, Infinity, NaN, 0, -5]) assert.throws(() => assertTimerMs(bad), RangeError, String(bad));
    assert.ok(MAX_INTERVAL_MINUTES * 60_000 <= MAX_TIMER_MS && (MAX_INTERVAL_MINUTES + 1) * 60_000 > MAX_TIMER_MS, 'minute ceiling is the largest that fits');
    assert.ok(MAX_INTERVAL_HOURS * 3_600_000 <= MAX_TIMER_MS && (MAX_INTERVAL_HOURS + 1) * 3_600_000 > MAX_TIMER_MS, 'hour ceiling is the largest that fits');
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
