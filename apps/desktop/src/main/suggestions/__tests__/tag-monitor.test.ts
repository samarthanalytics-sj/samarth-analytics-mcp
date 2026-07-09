// Pure tests for the GTM Monitor (addEventCallback) data layer — template source, sentinel parse, and
// the authoritative per-tag verdict mapping. No browser, no GTM API.
// Run: tsx apps/desktop/src/main/suggestions/__tests__/tag-monitor.test.ts

import { buildMonitorTemplateJs, isMonitorHit, parseMonitorHit, monitorVerdicts, MONITOR_SENTINEL_HOST, type MonitorEvent } from '../tag-monitor';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A monitor report URL as our template would emit it (sendPixel with the JSON payload).
const hit = (event: string, tags: Array<{ id: string; status?: string; executionTime?: number }>, ueid = 1): string =>
  `https://${MONITOR_SENTINEL_HOST}/m?e=${encodeURIComponent(JSON.stringify({ event, ueid, tags }))}`;

// ── template source ──────────────────────────────────────────────────────────────
{
  const js = buildMonitorTemplateJs();
  check('template: registers addEventCallback', js.includes("require('addEventCallback')") && js.includes('addEventCallback('));
  check('template: reports per-tag id + status + executionTime', js.includes('src[i].id') && js.includes('src[i].status') && js.includes('src[i].executionTime'));
  check('template: sends to the sentinel host', js.includes(MONITOR_SENTINEL_HOST));
  check('template: signals gtmOnSuccess (template contract)', js.includes('data.gtmOnSuccess()'));
}

// ── isMonitorHit / parseMonitorHit ────────────────────────────────────────────────
{
  check('isMonitorHit: our sentinel matches', isMonitorHit(hit('gtm.load', [])));
  check('isMonitorHit: a GA4 collect hit does not', !isMonitorHit('https://www.google-analytics.com/g/collect?en=page_view'));

  const ev = parseMonitorHit(hit('gtm.load', [{ id: '12', status: 'success', executionTime: 3 }, { id: '7', status: 'failure' }], 5))!;
  check('parse: event + ueid', ev.event === 'gtm.load' && ev.uniqueEventId === 5);
  check('parse: tags with id/status/time', ev.tags.length === 2 && ev.tags[0].id === '12' && ev.tags[0].status === 'success' && ev.tags[0].executionTime === 3);
  check('parse: unknown status normalises', parseMonitorHit(hit('x', [{ id: '1', status: 'weird' }]))!.tags[0].status === 'unknown');
  check('parse: numeric ids are stringified', parseMonitorHit(`https://${MONITOR_SENTINEL_HOST}/m?e=${encodeURIComponent(JSON.stringify({ event: 'e', tags: [{ id: 9, status: 'success' }] }))}`)!.tags[0].id === '9');
  check('parse: non-monitor URL → null', parseMonitorHit('https://example.com/x') === null);
  check('parse: malformed payload → null, no throw', parseMonitorHit(`https://${MONITOR_SENTINEL_HOST}/m?e=not-json`) === null);
  check('parse: tags without ids are dropped', parseMonitorHit(hit('e', [{ id: '', status: 'success' }, { id: '3', status: 'success' }]))!.tags.length === 1);
}

// ── monitorVerdicts: authoritative fired / not-fired / status ─────────────────────
{
  const events: MonitorEvent[] = [
    parseMonitorHit(hit('gtm.load', [{ id: 'cfg', status: 'success', executionTime: 2 }]))!,
    parseMonitorHit(hit('form_submit', [{ id: 'cfg', status: 'success' }, { id: 'lead', status: 'success', executionTime: 8 }]))!,
    parseMonitorHit(hit('cta_click', [{ id: 'cta', status: 'failure', executionTime: 40 }]))!,
  ];
  const v = monitorVerdicts(['cfg', 'lead', 'cta', 'never'], events);

  check('verdict: a reported tag → fired', v.get('lead')!.fired === true && v.get('lead')!.status === 'success');
  check('verdict: a tag reported on multiple events lists them all', JSON.stringify(v.get('cfg')!.onEvents) === JSON.stringify(['gtm.load', 'form_submit']));
  check('verdict: a failed tag → fired but status failure', v.get('cta')!.fired === true && v.get('cta')!.status === 'failure');
  check('verdict: a tag NEVER reported → did NOT fire', v.get('never')!.fired === false && v.get('never')!.status === 'unknown');
  check('verdict: executionTime tracked (max)', v.get('cta')!.maxExecutionMs === 40 && v.get('lead')!.maxExecutionMs === 8);
  check('verdict: only inventory tag ids are tracked (site-live tags never appear)', v.size === 4 && !v.has('site_live_tag'));
}
{
  // Worst-status-wins: a tag that succeeds once and fails once surfaces the failure.
  const events: MonitorEvent[] = [
    parseMonitorHit(hit('e1', [{ id: 't', status: 'success' }]))!,
    parseMonitorHit(hit('e2', [{ id: 't', status: 'exception' }]))!,
  ];
  check('verdict: worst status wins across events (exception > success)', monitorVerdicts(['t'], events).get('t')!.status === 'exception');
}
{
  // A fired tag with no status reported is treated as a clean success (defensive).
  const ev = parseMonitorHit(hit('e', [{ id: 't' }]))!;
  check('verdict: fired with no status → success', monitorVerdicts(['t'], [ev]).get('t')!.status === 'success' && monitorVerdicts(['t'], [ev]).get('t')!.fired === true);
}

console.log(`\ntag-monitor: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 20) { console.error(`expected >= 20 checks, got ${passed}`); process.exit(1); }
