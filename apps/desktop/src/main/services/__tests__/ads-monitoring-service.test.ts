// AdsMonitoringService: scheduler behaviour against a hand-written GoogleAdsService fake (no
// network, no Electron). Run: tsx apps/desktop/src/main/services/__tests__/ads-monitoring-service.test.ts

import assert from 'node:assert/strict';
import { AdsMonitoringService } from '../ads-monitoring-service';
import type { GoogleAdsService } from '../../google/ads-service';
import type { AccountView, AdsMonitorRun } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
let pending = 0;
function done(): void { console.log(`\nads-monitoring-service: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); }
function test(name: string, fn: () => Promise<void>): void {
  pending++;
  Promise.resolve().then(fn)
    .then(() => { console.log(`  ok   ${name}`); passed++; })
    .catch((e) => { console.error(`  x    ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) done(); });
}

const account: AccountView = { id: 'acct1', email: 'a@b.com', createdAt: 0, isActive: true, hasGoogleToken: true } as AccountView;

/** Fake Ads service: one critical UTM finding by default (a stable, dedupable issue), switchable to
 *  clean so alert closing is testable. Only the methods the sweep calls exist. */
function fakeAds(state: { utmCritical: boolean; calls?: string[] }): GoogleAdsService {
  return {
    readiness: async () => ({ ready: true }),
    conversionCustomer: async (cid: string) => {
      state.calls?.push(cid);
      return { conversionCustomerId: null, status: 'OK', trackingId: null, crossAccountTrackingId: null, isCrossAccount: false };
    },
    listConversionActions: async () => ({ actions: [], conversionCustomer: { conversionCustomerId: null, status: 'OK', trackingId: null, crossAccountTrackingId: null, isCrossAccount: false } }),
    conversionVolume: async () => ({ windowLabel: 'last 30 days, excluding today', volume: [] }),
    utmSetup: async () => ({
      findings: state.utmCritical
        ? [{ severity: 'critical', finding: 'No tagging at all: auto-tagging is OFF and no manual UTM template exists, so 100 clicks are unattributable.' }]
        : [],
    }),
    changeHistory: async () => ({ events: [], startDate: '2026-06-23', endDate: '2026-07-23' }),
    campaignPerformance: async () => ({ windowLabel: 'last 30 days, excluding today', custom: false, campaigns: [] }),
    listUserLists: async () => [],
  } as unknown as GoogleAdsService;
}

const makeSecrets = () => {
  const map = new Map<string, string>();
  return { store: map, get: (r: string) => map.get(r) ?? null, has: (r: string) => map.has(r), set: (r: string, v: string) => { map.set(r, v); }, delete: (r: string) => { map.delete(r); }, available: () => true };
};

console.log('\nAds monitoring service:');

test('sweep: produces a run with the finding as an alert, emits it, and persists issue log + history on the target', async () => {
  const emitted: AdsMonitorRun[] = [];
  const svc = new AdsMonitoringService({
    registry: { getActiveView: () => account },
    ads: fakeAds({ utmCritical: true }),
    secrets: makeSecrets(),
    emit: (r) => emitted.push(r),
    now: () => 1_000_000,
  });
  svc.configure({ targets: [{ customerId: '111-222-3333', label: 'Acme Ads', enabled: true }], enabled: false });
  const st0 = svc.status();
  assert.equal(st0.targets[0].customerId, '1112223333', 'dashed id normalized to bare digits');
  const runs = await svc.runOnce();
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.health, 'critical');
  assert.equal(run.alerts.length, 1);
  assert.equal(run.newAlertIds.length, 1, 'first sighting is NEW');
  assert.equal(run.score, 70, '100 - 30 for one critical');
  assert.equal(emitted.length, 1, 'run broadcast to the renderer');
  const t = svc.status().targetStatuses[0];
  assert.equal(t.issueLog?.length, 1, 'issue logged');
  assert.equal(t.issueLog?.[0].closedAt, undefined, 'still open');
  assert.equal(t.history?.length, 1, 'history row appended');
  assert.equal(t.history?.[0].critical, 1);
  assert.ok(t.lastRun, 'lastRun retained for the tab');
});

test('dedup + closing: an ongoing issue never re-alerts; a resolved issue closes in the log', async () => {
  const state = { utmCritical: true };
  const posts: string[] = [];
  const secrets = makeSecrets();
  const svc = new AdsMonitoringService({
    registry: { getActiveView: () => account },
    ads: fakeAds(state),
    secrets,
    emit: () => {},
    now: () => 2_000_000,
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ customerId: '1112223333', label: 'Acme', enabled: true }], enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', '1112223333');
  const [first] = await svc.runOnce();
  assert.equal(first.slackSent, 1, 'new issue posts to Slack');
  const [second] = await svc.runOnce();
  assert.equal(second.newAlertIds.length, 0, 'same issue is not new');
  assert.equal(second.slackSent, 0, 'no repeat ping');
  assert.equal(posts.length, 1, 'exactly one Slack POST');
  assert.equal(JSON.stringify(posts).includes('—'), false, 'no em dashes on the wire');
  // Issue resolves: the open log entry closes; a healthy run has no alerts.
  state.utmCritical = false;
  const [third] = await svc.runOnce();
  assert.equal(third.health, 'healthy');
  assert.equal(third.alerts.length, 0);
  const log = svc.status().targetStatuses[0].issueLog ?? [];
  assert.equal(log.length, 1);
  assert.ok(log[0].closedAt, 'resolved issue stamped closed');
});

test('restart seeding: open issue-log entries suppress the re-alert after the in-memory state is lost', async () => {
  const secrets = makeSecrets();
  const posts: string[] = [];
  const deps = {
    registry: { getActiveView: () => account },
    secrets,
    emit: () => {},
    now: () => 3_000_000,
    slackFetch: async (_u: string, init: { body: string }) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  };
  const svc = new AdsMonitoringService({ ...deps, ads: fakeAds({ utmCritical: true }) });
  svc.configure({ targets: [{ customerId: '1112223333', label: 'Acme', enabled: true }], enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', '1112223333');
  await svc.runOnce();
  assert.equal(posts.length, 1);
  // "Restart": a new service instance built from the SAME persisted targets (config carried over).
  const carried = svc.status().targets;
  const svc2 = new AdsMonitoringService({ ...deps, ads: fakeAds({ utmCritical: true }) });
  svc2.configure({ targets: carried, enabled: false });
  svc2.setWebhook('https://hooks.slack.com/services/T/B/x', '1112223333');
  const [run] = await svc2.runOnce();
  assert.equal(run.newAlertIds.length, 0, 'seeded from the open issue log - not re-treated as new');
  assert.equal(posts.length, 1, 'no duplicate Slack ping after restart');
});

test('per-account scoping: a target added under one mail is invisible and unsweepable under another', async () => {
  const accountB: AccountView = { id: 'acct2', email: 'b@c.com', createdAt: 0, isActive: true, hasGoogleToken: true } as AccountView;
  let current: AccountView = account;
  const calls: string[] = [];
  const svc = new AdsMonitoringService({
    registry: { getActiveView: () => current },
    ads: fakeAds({ utmCritical: false, calls }),
    secrets: makeSecrets(),
    emit: () => {},
    now: () => 4_000_000,
  });
  svc.configure({ targets: [{ customerId: '1111111111', label: 'A', enabled: true }], enabled: false });
  assert.equal(svc.status().targetStatuses.length, 1);
  current = accountB;
  assert.equal(svc.status().targetStatuses.length, 0, 'other mail sees nothing');
  assert.deepEqual(await svc.runOnce(), [], 'other mail sweeps nothing');
  assert.equal(calls.length, 0, 'no API call with the wrong token');
  svc.configure({ targets: [{ customerId: '2222222222', label: 'B', enabled: true }], enabled: false });
  current = account;
  assert.deepEqual(svc.status().targetStatuses.map((t) => t.customerId), ['1111111111'], 'first mail list preserved');
});

test('readiness gate: a missing developer token surfaces one clear error and sweeps nothing', async () => {
  const ads = fakeAds({ utmCritical: true });
  (ads as { readiness: () => Promise<unknown> }).readiness = async () => ({ ready: false, reason: { message: 'No Google Ads developer token is set.', remedy: 'Add it in Settings.' } });
  const svc = new AdsMonitoringService({ registry: { getActiveView: () => account }, ads, secrets: makeSecrets(), emit: () => {}, now: () => 5_000_000 });
  svc.configure({ targets: [{ customerId: '1111111111', label: 'A', enabled: true }], enabled: false });
  assert.deepEqual(await svc.runOnce(), []);
  const err = svc.status().lastError ?? '';
  assert.ok(err.includes('developer token') && err.includes('Settings'), `got: ${err}`);
});

test('normalize: interval floor 60, per-account cap 5, junk ids dropped, days snaps to 7/14/30', async () => {
  const svc = new AdsMonitoringService({ registry: { getActiveView: () => account }, ads: fakeAds({ utmCritical: false }), secrets: makeSecrets(), emit: () => {}, now: () => 6_000_000 });
  const st = svc.configure({
    intervalMinutes: 5,
    days: 12,
    targets: [
      ...Array.from({ length: 7 }, (_, i) => ({ customerId: `${1000000000 + i}`, label: `T${i}`, enabled: true })),
      { customerId: 'not-an-id', label: 'junk', enabled: true },
    ],
    enabled: false,
  });
  assert.equal(st.intervalMinutes, 60, 'floor is one hour (Ads API quota)');
  assert.equal(st.days, 30, 'invalid window falls back to the default');
  assert.equal(st.targets.length, 5, 'capped at 5 per account');
  assert.ok(!st.targets.some((t) => t.customerId === 'not-an-id'), 'junk id dropped');
});

test('webhook: rejects a non-Slack URL; test send reports the missing channel honestly', async () => {
  const svc = new AdsMonitoringService({ registry: { getActiveView: () => account }, ads: fakeAds({ utmCritical: false }), secrets: makeSecrets(), emit: () => {}, now: () => 7_000_000 });
  svc.configure({ targets: [{ customerId: '1111111111', label: 'A', enabled: true }], enabled: false });
  assert.throws(() => svc.setWebhook('https://example.com/hook', '1111111111'), /Incoming Webhook/);
  const r = await svc.sendTest('1111111111');
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').includes('No Slack channel'));
});

test('removing a target drops its runtime state and its channel secret', async () => {
  const secrets = makeSecrets();
  const svc = new AdsMonitoringService({ registry: { getActiveView: () => account }, ads: fakeAds({ utmCritical: true }), secrets, emit: () => {}, now: () => 8_000_000 });
  svc.configure({ targets: [{ customerId: '1111111111', label: 'A', enabled: true }], enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', '1111111111');
  await svc.runOnce();
  assert.equal(secrets.store.size, 1);
  svc.configure({ targets: [] });
  assert.equal(secrets.store.size, 0, 'orphaned webhook removed');
  assert.equal(svc.status().targetStatuses.length, 0);
});

test('snapshot: captured on every sweep, and SURVIVES a configure() from the renderer', async () => {
  // The whole change-detection feature rests on the previous sweep's snapshot still being there on
  // the next one. It is server-owned state that the renderer never sends back, so a configure()
  // call (renaming a target, toggling an account) must not drop it.
  const svc = new AdsMonitoringService({
    registry: { getActiveView: () => account },
    ads: fakeAds({ utmCritical: true }),
    secrets: makeSecrets(),
    emit: () => {},
    now: () => 2_000_000,
  });
  svc.configure({ targets: [{ customerId: '1112223333', label: 'Acme', enabled: true }], enabled: false });

  assert.equal(svc.status().targets[0].snapshot, undefined, 'no snapshot before the first sweep');
  await svc.runOnce();
  const afterSweep = svc.status().targets[0].snapshot as { at: number; windowDays: number } | undefined;
  assert.ok(afterSweep, 'a sweep records a snapshot');
  assert.equal(afterSweep?.at, 2_000_000, 'stamped with the sweep time');

  // The renderer echoes the config back WITHOUT the snapshot, which is exactly how it would be lost.
  svc.configure({ targets: [{ customerId: '1112223333', label: 'Acme renamed', enabled: true }], enabled: false });
  const afterConfigure = svc.status().targets[0].snapshot as { at: number } | undefined;
  assert.ok(afterConfigure, 'the snapshot survives a renderer config echo');
  assert.equal(afterConfigure?.at, 2_000_000, 'and it is the same snapshot, not a fresh empty one');
  assert.equal(svc.status().targets[0].label, 'Acme renamed', 'while the renderer-owned label DID update');
});

test('snapshot: the FIRST sweep reports no change alerts (nothing to compare against)', async () => {
  // Otherwise every existing conversion action and campaign would be announced as new on day one.
  const svc = new AdsMonitoringService({
    registry: { getActiveView: () => account },
    ads: fakeAds({ utmCritical: false }),
    secrets: makeSecrets(),
    emit: () => {},
    now: () => 3_000_000,
  });
  svc.configure({ targets: [{ customerId: '1112223333', label: 'Acme', enabled: true }], enabled: false });
  const runs = await svc.runOnce();
  const changeAlerts = runs[0].alerts.filter((a) => a.area === 'changes');
  assert.equal(changeAlerts.length, 0, 'no change alerts on the very first sweep');
});
