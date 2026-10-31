/** Pure renderer helpers: audit-export formatters (CSV + Markdown) and the state guards that keep
 *  async results on the selection they were requested for (state-guards.ts).
 *  Run: tsx src/renderer/src/__tests__/audit-export.test.ts */
import assert from 'node:assert/strict';
import { auditToCsv, auditToMarkdown, sortFindings } from '../audit-export';
import { gtmScopeKey, LatestRequest, chatThreadToShow, canRunAudit } from '../state-guards';
import type { AuditReportView, AuditFindingView, GtmContext } from '../../../shared/ipc';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}

const f = (o: Partial<AuditFindingView>): AuditFindingView => ({
  severity: 'medium', category: 'firing', message: 'msg', recommendation: 'fix it', autoFixable: false, ...o,
});
const report = (findings: AuditFindingView[]): AuditReportView => ({
  counts: { tags: 5, triggers: 3, variables: 2, findings: findings.length },
  summary: {
    critical: findings.filter((x) => x.severity === 'critical').length,
    high: findings.filter((x) => x.severity === 'high').length,
    medium: findings.filter((x) => x.severity === 'medium').length,
    low: findings.filter((x) => x.severity === 'low').length,
    info: findings.filter((x) => x.severity === 'info').length,
  },
  findings,
});

console.log('\nAudit export:');

test('sortFindings: worst severity first, stable within a severity', () => {
  const out = sortFindings([f({ severity: 'low', message: 'a' }), f({ severity: 'critical', message: 'b' }), f({ severity: 'low', message: 'c' }), f({ severity: 'high', message: 'd' })]);
  assert.deepEqual(out.map((x) => x.severity), ['critical', 'high', 'low', 'low']);
  assert.deepEqual(out.filter((x) => x.severity === 'low').map((x) => x.message), ['a', 'c'], 'stable within severity');
});

test('auditToCsv: header + one row per finding, worst-first', () => {
  const csv = auditToCsv(report([
    f({ severity: 'low', category: 'paused', message: 'Tag paused', recommendation: 'Unpause', autoFixable: true, resource: { kind: 'tag', id: '1', name: 'GA4 Tag', type: 'gaawe' } }),
    f({ severity: 'critical', category: 'consent', message: 'Ungated pixel', recommendation: 'Gate it', confidence: 'certain' }),
  ]));
  const lines = csv.split('\r\n');
  assert.ok(lines[0].startsWith('Severity,Confidence,Category,Resource kind,Resource name,Resource type,Issue,Recommendation,Auto-fixable'));
  assert.equal(lines.length, 3, 'header + 2 rows');
  assert.ok(lines[1].startsWith('critical,certain,consent,'), 'critical sorted first');
  assert.ok(lines[2].startsWith('low,,paused,tag,GA4 Tag,gaawe,Tag paused,Unpause,yes'));
});

test('auditToCsv: escapes commas / quotes / newlines', () => {
  const csv = auditToCsv(report([f({ message: 'has, comma and "quote"', recommendation: 'line1\nline2' })]));
  const row = csv.split('\r\n')[1];
  assert.ok(row.includes('"has, comma and ""quote"""'), 'comma+quote cell quoted, inner quotes doubled');
  assert.ok(row.includes('"line1\nline2"'), 'newline cell quoted');
});

test('auditToMarkdown: header, counts, severity summary, boundary, findings table', () => {
  const md = auditToMarkdown(report([
    f({ severity: 'high', category: 'firing', message: 'No trigger', recommendation: 'Add one', resource: { kind: 'tag', id: '2', name: 'My|Tag', type: 'html' } }),
  ]), { account: 'Acct', container: 'example.com', workspace: 'Default', generatedAt: '2026-07-03' });
  assert.ok(md.startsWith('# GTM Container Audit'));
  assert.ok(md.includes('**Container:** Acct › example.com › Default'));
  assert.ok(md.includes('**Generated:** 2026-07-03'));
  assert.ok(md.includes('5 tags · 3 triggers · 2 variables'));
  assert.ok(md.includes('1 - 0 critical · 1 high · 0 medium · 0 low · 0 info'));
  assert.ok(md.includes('Container-only audit: proves CONFIGURATION'), 'boundary statement present');
  assert.ok(md.includes('| 1 | high |'), 'finding row numbered');
  assert.ok(md.includes('My\\|Tag (html)'), 'pipe in resource name escaped');
});

test('auditToMarkdown: clean container has no table, states it is clean', () => {
  const md = auditToMarkdown(report([]));
  assert.ok(md.includes('No issues found'));
  assert.ok(!md.includes('| # | Severity'), 'no table when there are no findings');
});

console.log('\nRenderer state guards:');

test('gtmScopeKey: a container or workspace switch is a new scope; a rename is not (container audit report)', () => {
  const key = (c: GtmContext): string => gtmScopeKey(c); // the panel passes the account's whole GtmContext
  const a: GtmContext = { accountId: '1', accountName: 'Acct', containerId: '10', containerName: 'A', workspaceId: '4', workspaceName: 'Default' };
  assert.notEqual(key(a), key({ ...a, containerId: '11', containerName: 'B' }), 'other container');
  assert.notEqual(key(a), key({ ...a, workspaceId: '5' }), 'other workspace of the same container');
  assert.equal(key(a), key({ ...a, containerName: 'A (renamed)', workspaceName: 'Renamed' }), 'names are labels, not scope');
  assert.equal(gtmScopeKey(undefined), gtmScopeKey({}), 'no context is one stable scope');
});

test('gtmScopeKey: same small workspace id in two server containers is two scopes (coverage / server audit)', () => {
  // GTM workspace + tag ids are small per-container integers, so the container id must be part of it.
  assert.notEqual(
    gtmScopeKey({ accountId: '1', containerId: 'A', workspaceId: '4' }),
    gtmScopeKey({ accountId: '1', containerId: 'B', workspaceId: '4' })
  );
  assert.notEqual(gtmScopeKey({ accountId: '1', containerId: 'A', workspaceId: '4' }), gtmScopeKey({ accountId: '2', containerId: 'A', workspaceId: '4' }));
});

test('LatestRequest: a slower response for an earlier pick is dropped, the newest one lands', () => {
  const gate = new LatestRequest();
  const forX = gate.begin(); // user picks container X - its workspace list starts loading
  const forY = gate.begin(); // ...then container Y before X's list arrives
  assert.equal(forX(), false, "X's list must not overwrite Y's (nor clear Y's loading flag)");
  assert.equal(forY(), true, "Y's list is the one that lands");
  const forZ = gate.begin();
  assert.equal(forY(), false, 'superseded once another pick starts loading');
  assert.equal(forZ(), true);
});

test('chatThreadToShow: the view stays pinned to the asking thread while a reply streams', () => {
  assert.equal(chatThreadToShow('acct|gtm|A', 'acct|ga4|P', true), null, 'mid-turn switch waits');
  assert.equal(chatThreadToShow('acct|gtm|A', 'acct|ga4|P', false), 'acct|ga4|P', 'applied once the turn ends');
  assert.equal(chatThreadToShow('acct|gtm|A', 'acct|gtm|A', false), null, 'same thread: never reload (would drop unsaved tokens)');
  assert.equal(chatThreadToShow('acct|gtm|A', 'acct|gtm|A', true), null);
});

test('chatThreadToShow: a key flip mid-stream keeps the answer in, and saved under, the thread that asked', () => {
  // Mirrors ChatView: `shown`/`msgs` are the on-screen thread, the stream appends to msgs' last
  // assistant message, and the thread effect runs on every key / busy change.
  const store: Record<string, string[]> = { A: ['old q', 'old a'], B: ['b q', 'b a'] };
  let shown = 'A';
  let msgs = [...store.A];
  const effect = (wanted: string, streaming: boolean): void => {
    const next = chatThreadToShow(shown, wanted, streaming);
    if (next === null) return;
    store[shown] = msgs; // flush the shown thread under its own key
    shown = next;
    msgs = [...(store[next] ?? [])];
  };
  msgs = [...msgs, 'list tags in X', '']; // send() on thread A
  effect('A', true);
  effect('B', true); // set_gtm_container / a product toggle flips threadKey mid-stream
  msgs[msgs.length - 1] += 'X has 12 tags'; // the rest of the reply streams into the SHOWN thread
  effect('B', false); // turn ends
  assert.deepEqual(store.A, ['old q', 'old a', 'list tags in X', 'X has 12 tags'], 'answer kept in the asking thread');
  assert.deepEqual(store.B, ['b q', 'b a'], "the other thread's last reply is untouched");
  assert.equal(shown, 'B', 'the queued switch is applied after the turn');
});

test('canRunAudit: Re-run waits for a batch or row write still in flight', () => {
  const idle = { ready: true, running: false, applyingAll: false, fix: {} };
  assert.equal(canRunAudit(idle), true);
  assert.equal(canRunAudit({ ...idle, applyingAll: true }), false, 'blocked during Apply all / bulk delete');
  assert.equal(canRunAudit({ ...idle, fix: { 3: { state: 'done' }, 7: { state: 'fixing' } } }), false, 'blocked while a row write is in flight');
  assert.equal(canRunAudit({ ...idle, fix: { 3: { state: 'done' }, 7: { state: 'err' }, 9: { state: 'confirm' } } }), true, 'finished rows do not block');
  assert.equal(canRunAudit({ ...idle, running: true }), false);
  assert.equal(canRunAudit({ ...idle, ready: false }), false);
});

console.log(`\naudit-export: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
