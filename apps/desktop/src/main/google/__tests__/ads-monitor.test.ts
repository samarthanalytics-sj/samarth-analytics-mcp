// Pure tests for the Google Ads monitoring engine (no network, no Electron).
// Run: tsx apps/desktop/src/main/google/__tests__/ads-monitor.test.ts

import { adsAlertId, buildAdsMonitorResult, buildAdsSlackPayload, buildAdsSlackTestPayload } from '../ads-monitor';
import type { HealthFinding } from '../ads-map';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

const f = (severity: HealthFinding['severity'], area: string, finding: string): HealthFinding => ({ severity, area, finding });

// ── stable alert ids ──
{
  const a = adsAlertId(f('warning', 'audience', '3 open audience list(s) have size 0 (List A) - not populating.'));
  const b = adsAlertId(f('warning', 'audience', '4 open audience list(s) have size 0 (List A) - not populating.'));
  check('id: counts changing does NOT re-open the issue', a === b);
  const c = adsAlertId(f('warning', 'audience', '3 open audience list(s) have size 0 (List B) - not populating.'));
  check('id: a DIFFERENT list name is a different issue', a !== c);
  const d = adsAlertId(f('critical', 'audience', '3 open audience list(s) have size 0 (List A) - not populating.'));
  check('id: severity escalation is a new issue (old one closes)', a !== d);
  check('id: bounded length', adsAlertId(f('info', 'x', 'y'.repeat(500))).length < 200);
}

// ── result assembly ──
{
  const result = buildAdsMonitorResult([
    f('critical', 'tagging', 'No tagging at all: auto-tagging is OFF and no manual UTM template exists.'),
    f('warning', 'volume', 'Campaign "Burning" spent 5 units with 0 conversions.'),
    f('info', 'config', 'Conversion tracking is owned by manager 999.'),
    f('info', 'summary', 'No config-level conversion problems detected... verify from the GTM tab.'),
  ]);
  check('all-clear summary finding never becomes an alert', !result.alerts.some((a) => a.area === 'summary'));
  check('alerts worst-first', result.alerts[0].severity === 'critical' && result.alerts[0].area === 'tagging');
  check('health from worst severity', result.health === 'critical');
  check('score: 100 - 30 - 12 - 2 = 56', result.score === 56, String(result.score));
  check('summary counts + areas, no em dash', result.summary.includes('1 critical') && result.summary.includes('1 warning') && result.summary.includes('tagging') && !result.summary.includes('—'));
  const tagging = result.checks.find((c) => c.id === 'tagging');
  const volume = result.checks.find((c) => c.id === 'volume');
  const config = result.checks.find((c) => c.id === 'config');
  const audience = result.checks.find((c) => c.id === 'audience');
  check('checks: critical area fails, warning area warns', tagging?.status === 'fail' && volume?.status === 'warn');
  check('checks: info-only area passes; untouched area passes with the no-issues line', config?.status === 'pass' && audience?.status === 'pass' && audience?.detail.includes('No issues'));
  check('checks: detail carries the worst finding text', tagging?.detail.includes('auto-tagging is OFF') === true);
}
{
  const clean = buildAdsMonitorResult([f('info', 'summary', 'No config-level conversion problems detected.')]);
  check('clean account: healthy, score 100, zero alerts, all checks pass', clean.health === 'healthy' && clean.score === 100 && clean.alerts.length === 0 && clean.checks.every((c) => c.status === 'pass'));
  check('clean summary names the config-plane boundary', clean.summary.includes('config-plane'));
}
{
  const dup = buildAdsMonitorResult([
    f('warning', 'volume', 'Campaign "X" spent 12 units with 0 conversions.'),
    f('warning', 'volume', 'Campaign "X" spent 99 units with 0 conversions.'),
  ]);
  check('identical-modulo-numbers findings dedup to one alert', dup.alerts.length === 1);
}
{
  const floor = buildAdsMonitorResult(Array.from({ length: 10 }, (_, i) => f('critical', 'config', `Broken thing number few (case ${'x'.repeat(i + 1)})`)));
  check('score floors at 0', floor.score === 0);
}

// ── Slack payloads ──
{
  const alerts = Array.from({ length: 11 }, (_, i) => ({ id: `w:${i}`, area: 'volume', severity: 'warning' as const, title: `Issue about campaign ${'Q'.repeat(i + 1)}` }));
  const result = buildAdsMonitorResult([]);
  const p = buildAdsSlackPayload('Acme Ads', result, alerts);
  const body = JSON.stringify(p);
  check('slack: headline counts the new issues', p.text.includes('11 new issues') && p.text.includes('Acme Ads'));
  check('slack: alert sections capped with an "and N more" line', body.includes('and 3 more'));
  check('slack: config-plane boundary in the context line', body.includes('tag verification'));
  check('slack: no em dashes anywhere', !body.includes('—'));
  const single = buildAdsSlackPayload('Acme', result, [alerts[0]]);
  check('slack: singular wording for one issue', single.text.includes('1 new issue') && !single.text.includes('issues'));
}
{
  const t = buildAdsSlackTestPayload('Acme Ads');
  const body = JSON.stringify(t);
  check('slack test: names the account and the alert kinds, no em dashes', body.includes('Acme Ads') && body.includes('silent conversion actions') && !body.includes('—'));
}

console.log(`\nads-monitor: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 15) { console.error(`expected >= 15 checks, got ${passed}`); process.exit(1); }
