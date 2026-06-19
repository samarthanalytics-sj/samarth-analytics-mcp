import assert from 'node:assert/strict';
import { buildReport } from '../report';
import type { ScorecardFinding, ScorecardSection } from '../scorecard';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const f = (severity: ScorecardFinding['severity'], category: string, message: string): ScorecardFinding => ({
  severity,
  category,
  message,
  recommendation: `fix ${message}`,
});

const sections: ScorecardSection[] = [
  { key: 'gtm', label: 'GTM container', findings: [f('high', 'firing', 'Tag X has no trigger'), f('low', 'unused', 'Trigger Y unused')] },
  { key: 'ga4', label: 'GA4 property', findings: [f('medium', 'retention', '2-month retention')] },
];

console.log('\nReport builder:');

test('renders title, overall score+grade, and generated timestamp', () => {
  const md = buildReport(sections, { title: 'Client Report', generatedAt: '2026-06-19T00:00:00Z' });
  assert.ok(md.startsWith('# Client Report'));
  assert.ok(/\*\*Overall: \d+\/100 \([A-F]\)\*\*/.test(md));
  assert.ok(md.includes('generated 2026-06-19T00:00:00Z'));
});

test('summary table has a row per section with score/grade/counts', () => {
  const md = buildReport(sections);
  assert.ok(md.includes('## Summary'));
  assert.ok(md.includes('| GTM container |'));
  assert.ok(md.includes('| GA4 property |'));
});

test('top-issues table ranks high severity first', () => {
  const md = buildReport(sections);
  const top = md.slice(md.indexOf('## Top issues'));
  const firstRow = top.split('\n').find((l) => l.startsWith('| 1 |'));
  assert.ok(firstRow && firstRow.includes('high'), 'rank 1 is the high finding');
});

test('per-section findings tables list every finding with its fix', () => {
  const md = buildReport(sections);
  assert.ok(md.includes('## GTM container — findings'));
  assert.ok(md.includes('Tag X has no trigger'));
  assert.ok(md.includes('fix Tag X has no trigger'));
  assert.ok(md.includes('## GA4 property — findings'));
  assert.ok(md.includes('2-month retention'));
});

test('a clean section renders the no-issues line, and a perfect report notes it', () => {
  const clean: ScorecardSection[] = [{ key: 'gtm', label: 'GTM container', findings: [] }];
  const md = buildReport(clean);
  assert.ok(md.includes('No issues found. ✅'));
  assert.ok(md.includes('No issues detected'));
  assert.ok(/\*\*Overall: 100\/100 \(A\)\*\*/.test(md));
});

test('pipes/newlines in finding text are escaped so the table stays intact', () => {
  const md = buildReport([{ key: 'gtm', label: 'GTM container', findings: [f('high', 'x', 'a | b\nc')] }]);
  assert.ok(md.includes('a \\| b c'), 'pipe escaped + newline flattened');
  assert.ok(!md.includes('a | b\nc'));
});

test('a backslash before a pipe (e.g. a path) is escaped so the pipe stays inert', () => {
  // message "path C:\|notes" → backslash doubled then pipe escaped → "path C:\\\|notes".
  const md = buildReport([{ key: 'gtm', label: 'GTM container', findings: [f('high', 'x', 'path C:\\|notes')] }]);
  assert.ok(md.includes('path C:\\\\\\|notes'), 'backslash doubled + pipe escaped');
  assert.ok(!md.includes('path C:\\|notes'), 'no single-backslash live pipe survives');
});

test('info-only findings do NOT trigger the "no issues detected" footer (no self-contradiction)', () => {
  const md = buildReport([{ key: 'ga4', label: 'GA4 property', findings: [f('info', 'integrations', 'No Google Ads links'), f('info', 'benchmarking', 'Industry not set')] }]);
  assert.ok(/\*\*Overall: 100\/100 \(A\)\*\*/.test(md), 'info findings still score 100');
  assert.ok(md.includes('No Google Ads links'), 'info findings are listed');
  assert.ok(!md.includes('No issues detected'), 'footer suppressed because findings exist');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
