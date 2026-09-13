import assert from 'node:assert/strict';
import { consentReportToSection } from '../consent-section';

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

// A trimmed web-audit ComplianceReport.
const report = {
  score: 60,
  findings: [
    { id: 'engine_x', domain: 'consent', severity: 'critical', finding: 'Tag fires before consent', suggestedFix: 'Gate it' },
    { id: 'banner_y', domain: 'banner', severity: 'high', finding: 'No reject on first layer', suggestedFix: 'Add reject' },
    { id: 'forms_z', domain: 'forms', severity: 'medium', finding: 'PII form without notice' },
  ],
};

console.log('\nConsent section bridge:');

test('builds a Consent Mode v2 section from consent + banner findings (forms excluded)', () => {
  const sec = consentReportToSection(report);
  assert.ok(sec);
  assert.equal(sec!.key, 'consent');
  assert.equal(sec!.label, 'Consent Mode v2');
  assert.equal(sec!.findings.length, 2, 'consent + banner, not forms');
  assert.deepEqual(sec!.findings.map((f) => f.message).sort(), ['No reject on first layer', 'Tag fires before consent']);
});

test('maps critical → high and carries the suggested fix as recommendation', () => {
  const sec = consentReportToSection(report)!;
  const consent = sec.findings.find((f) => f.message === 'Tag fires before consent')!;
  assert.equal(consent.severity, 'high', 'critical downgraded to high');
  assert.equal(consent.recommendation, 'Gate it');
});

test('tolerates the MCP envelope wrapper { report: { findings } }', () => {
  const sec = consentReportToSection({ report });
  assert.ok(sec);
  assert.equal(sec!.findings.length, 2);
});

test('non-string finding/suggestedFix (malformed paste) falls back instead of "[object Object]"', () => {
  const sec = consentReportToSection({ findings: [{ domain: 'banner', severity: { weird: true }, finding: { nested: 'obj' }, suggestedFix: ['x'] }] })!;
  assert.ok(sec);
  assert.equal(sec.findings[0].message, '(unnamed finding)', 'object finding → fallback, not [object Object]');
  assert.equal(sec.findings[0].severity, 'medium', 'object severity → medium');
  assert.equal(sec.findings[0].recommendation, undefined, 'non-string suggestedFix dropped');
});

test('returns null when there are no consent/banner findings', () => {
  assert.equal(consentReportToSection({ findings: [{ domain: 'forms', severity: 'low', finding: 'x' }] }), null);
  assert.equal(consentReportToSection({}), null);
  assert.equal(consentReportToSection(null), null);
  assert.equal(consentReportToSection('nonsense'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
