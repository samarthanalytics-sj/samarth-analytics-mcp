/** Report roll-up + audit_brain scorecard adapter + human formatter tests. */

import { rollupOverall } from '../assert/engine.js';
import { buildReport } from '../report/report.js';
import { toScorecardInput } from '../report/scorecard-adapter.js';
import { formatHuman } from '../report/human.js';
import type { CheckResult, VerifyReport, VerifySpec } from '../types.js';
import { harness, capture } from './_helpers.js';

const { check, done } = harness('report');

const r = (id: string, type: CheckResult['type'], status: CheckResult['status'], reason?: string): CheckResult =>
  reason ? { id, type, status, reason } : { id, type, status };

// ── rollupOverall ────────────────────────────────────────────────────────────
check('rollup: any Fail → Fail', rollupOverall([r('a', 'event_fired', 'Pass'), r('b', 'consent_mode', 'Fail', 'x')]) === 'Fail');
check('rollup: Partial (no Fail)', rollupOverall([r('a', 'event_fired', 'Pass'), r('b', 'param_validation', 'Partial', 'x')]) === 'Partial');
check('rollup: Pass + Not Verified → Pass', rollupOverall([r('a', 'event_fired', 'Pass'), r('b', 'cross_domain_linker', 'Not Verified', 'x')]) === 'Pass');
check('rollup: all Not Verified → Not Verified', rollupOverall([r('a', 'event_fired', 'Not Verified', 'x'), r('b', 'tracker_present', 'Not Verified', 'y')]) === 'Not Verified');
check('rollup: all Pass → Pass', rollupOverall([r('a', 'event_fired', 'Pass')]) === 'Pass');
check('rollup: empty → Not Verified', rollupOverall([]) === 'Not Verified');

// ── buildReport shape ──────────────────────────────────────────────────────────
const spec: VerifySpec = { url: 'https://example.test/', checks: [{ id: 'a', type: 'event_fired', event: 'page_view' }] };
const results = [r('a', 'event_fired', 'Fail', 'no hit')];
const report = buildReport(spec, 'deadbeef', capture({ notes: ['nav slow'] }), results);
check('buildReport: url', report.url === 'https://example.test/');
check('buildReport: engineVersion set', typeof report.engineVersion === 'string' && report.engineVersion.length > 0);
check('buildReport: specHash passthrough', report.specHash === 'deadbeef');
check('buildReport: overall', report.overall === 'Fail');
check('buildReport: checks', report.checks.length === 1);
check('buildReport: notes surfaced', Array.isArray(report.notes) && report.notes[0] === 'nav slow');
check('buildReport: notes omitted when none', buildReport(spec, 'x', capture({ notes: [] }), results).notes === undefined);

// ── scorecard adapter (audit_brain shape) ──────────────────────────────────────
const mixed: VerifyReport = {
  url: 'https://example.test/',
  engineVersion: '0.1.0',
  specHash: 'x',
  overall: 'Fail',
  checks: [
    r('pv', 'event_fired', 'Pass'),
    r('pval', 'param_validation', 'Partial', 'wrong'),
    r('cm', 'consent_mode', 'Fail', 'pre-consent'),
    r('ln', 'cross_domain_linker', 'Not Verified', 'no link'),
  ],
};
const sc = toScorecardInput(mixed);
check('adapter: one area per check', sc.areas.length === 4);
check('adapter: statusKey lowercase mapping', sc.areas.find((a) => a.area === 'pv')?.statusKey === 'pass' && sc.areas.find((a) => a.area === 'cm')?.statusKey === 'fail' && sc.areas.find((a) => a.area === 'ln')?.statusKey === 'not_verified');
check('adapter: findings only for Fail/Partial', sc.findings.length === 2);
check('adapter: consent_mode Fail → critical', sc.findings.some((f) => f.severity === 'critical' && f.category === 'privacy'));
check('adapter: Partial → medium', sc.findings.some((f) => f.severity === 'medium' && f.category === 'measurement'));

// ── human formatter ──────────────────────────────────────────────────────────
const human = formatHuman(mixed);
check('human: shows OVERALL', human.includes('OVERALL: Fail'));
check('human: lists a check id', human.includes('cm') && human.includes('consent_mode'));
check('human: shows reason', human.includes('pre-consent'));

done(20);
