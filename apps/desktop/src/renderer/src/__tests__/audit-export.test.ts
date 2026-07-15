/** Pure audit-export formatters (CSV + Markdown). Run: tsx src/renderer/src/__tests__/audit-export.test.ts */
import assert from 'node:assert/strict';
import { auditToCsv, auditToMarkdown, sortFindings } from '../audit-export';
import type { AuditReportView, AuditFindingView } from '../../../shared/ipc';

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

console.log(`\naudit-export: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
