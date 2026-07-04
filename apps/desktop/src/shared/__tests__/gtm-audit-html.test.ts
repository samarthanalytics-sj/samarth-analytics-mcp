import assert from 'node:assert/strict';
import { gtmAuditHtml } from '../gtm-audit-html';
import { detectTagBrand } from '../tag-brand';
import type { AuditReportView } from '../ipc';

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

const report = (over: Partial<AuditReportView> = {}): AuditReportView => ({
  counts: { tags: 12, triggers: 5, variables: 7, findings: 2 },
  summary: { critical: 1, high: 1, medium: 0, low: 0, info: 0 },
  findings: [
    {
      severity: 'critical',
      category: 'consent',
      message: 'Meta pixel fires without a consent gate.',
      resource: { kind: 'tag', id: '1', name: 'Social - Meta | PageView', type: 'html' },
      recommendation: 'Replace with a consent-aware template.',
      autoFixable: true,
    },
    {
      severity: 'high',
      category: 'consent',
      message: 'Tag has no Consent Mode v2 settings.',
      resource: { kind: 'tag', id: '2', name: 'Analytics - Google | Google Tag', type: 'googtag' },
      recommendation: 'Declare the consent types it requires.',
      autoFixable: true,
    },
  ],
  ...over,
});

console.log('\nGTM audit HTML:');

test('renders header, scope meta, severity summary and scan counts', () => {
  const h = gtmAuditHtml(report(), { account: 'Acme', container: 'Scratchee-Web', workspace: 'Default', generatedAt: '7/4/2026, 8:00 PM' });
  assert.ok(h.includes('GTM Container Audit — Scratchee-Web'), 'title carries the container');
  assert.ok(h.includes('<b>Account:</b> Acme') && h.includes('<b>Workspace:</b> Default'), 'scope meta line');
  assert.ok(h.includes('2 findings') && h.includes('1 critical') && h.includes('1 high'), 'summary pills');
  assert.ok(h.includes('Scanned 12 tags · 5 triggers · 7 variables'), 'scan counts');
});

test('each finding renders as a severity card mirroring the panel (badge, icon, name, blue type, fix box)', () => {
  const h = gtmAuditHtml(report());
  assert.ok(h.includes('CRITICAL') && h.includes('HIGH'), 'severity badges');
  assert.ok(h.includes('Social - Meta | PageView'), 'tag name');
  assert.ok(h.includes('color:#2563eb') && h.includes('(Custom HTML)') && h.includes('(Google Tag)'), 'blue bold type labels');
  assert.ok(h.includes('<svg'), 'vendor icons inline');
  assert.ok(h.includes('Replace with a consent-aware template.'), 'recommendation box');
  // The Meta tag is Custom HTML by type but branded by NAME — same detection the panel uses.
  assert.equal(detectTagBrand('html', 'Social - Meta | PageView'), 'meta');
});

test('escapes user-controlled names/messages (no raw HTML injection into the PDF)', () => {
  const h = gtmAuditHtml(
    report({
      findings: [
        {
          severity: 'low',
          category: 'x',
          message: 'msg <script>alert(1)</script>',
          resource: { kind: 'tag', id: '1', name: '<img onerror=x>', type: 'html' },
          recommendation: 'a & b',
          autoFixable: false,
        },
      ],
    })
  );
  assert.ok(!h.includes('<script>') && !h.includes('<img onerror'), 'tags escaped');
  assert.ok(h.includes('&lt;script&gt;') && h.includes('a &amp; b'), 'entities present');
});

test('a clean report renders the no-findings note', () => {
  const h = gtmAuditHtml(report({ findings: [], counts: { tags: 3, triggers: 1, variables: 2, findings: 0 }, summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }));
  assert.ok(h.includes('No findings'), 'clean note');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
