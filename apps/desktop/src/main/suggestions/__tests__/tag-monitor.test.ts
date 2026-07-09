// Pure tests for the GTM Monitor data layer — sentinel parse (Simo Ahava's GTM Monitor GET-pixel
// format) + the authoritative per-tag verdict mapping. No browser, no GTM API.
// Run: tsx apps/desktop/src/main/suggestions/__tests__/tag-monitor.test.ts

import { isMonitorHit, parseMonitorHit, monitorVerdicts, MONITOR_SENTINEL_HOST, MONITOR_ENDPOINT, MONITOR_GALLERY, type MonitorEvent } from '../tag-monitor';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A monitor report URL exactly as Simo's imported GTM Monitor template GET-pixels it:
// <endPoint>?eventName=<e>&eventTimestamp=<ts>&tag1id=..&tag1nm=..&tag1st=..&tag1et=..&tag2id=..
const hit = (event: string, tags: Array<{ id: string; nm?: string; st?: string; et?: number }>): string => {
  const p = new URLSearchParams();
  p.set('eventName', event);
  p.set('eventTimestamp', '1700000000000');
  tags.forEach((t, i) => {
    const n = i + 1;
    p.set(`tag${n}id`, t.id);
    if (t.nm !== undefined) p.set(`tag${n}nm`, t.nm);
    if (t.st !== undefined) p.set(`tag${n}st`, t.st);
    if (t.et !== undefined) p.set(`tag${n}et`, String(t.et));
  });
  return `${MONITOR_ENDPOINT}?${p.toString()}`;
};

// ── config constants ──────────────────────────────────────────────────────────────
{
  check('config: endpoint is on the .invalid sentinel host (never resolves; route-aborted)', MONITOR_ENDPOINT.startsWith('https://') && MONITOR_ENDPOINT.includes(MONITOR_SENTINEL_HOST));
  check('config: endpoint passes the GTM Monitor tag validation (^https://.+)', /^https:\/\/.+/.test(MONITOR_ENDPOINT));
  check('config: gallery owner/repo is Simo Ahava\'s GTM Monitor', MONITOR_GALLERY.owner === 'gtm-templates-simo-ahava' && MONITOR_GALLERY.repository === 'google-tag-manager-monitor');
}

// ── isMonitorHit / parseMonitorHit ────────────────────────────────────────────────
{
  check('isMonitorHit: our sentinel matches', isMonitorHit(hit('gtm.load', [])));
  check('isMonitorHit: a GA4 collect hit does not', !isMonitorHit('https://www.google-analytics.com/g/collect?en=page_view'));

  const ev = parseMonitorHit(hit('gtm.load', [{ id: '12', nm: 'GA4 Config', st: 'success', et: 3 }, { id: '7', nm: 'Lead', st: 'failure' }]))!;
  check('parse: event name', ev.event === 'gtm.load');
  check('parse: indexed tag groups → id/name/status/time', ev.tags.length === 2 && ev.tags[0].id === '12' && ev.tags[0].name === 'GA4 Config' && ev.tags[0].status === 'success' && ev.tags[0].executionTime === 3);
  check('parse: second group parsed, missing et → undefined', ev.tags[1].id === '7' && ev.tags[1].status === 'failure' && ev.tags[1].executionTime === undefined);
  check('parse: unknown status normalises', parseMonitorHit(hit('x', [{ id: '1', st: 'weird' }]))!.tags[0].status === 'unknown');
  check('parse: an event with NO fired tags → empty tags (not null)', parseMonitorHit(hit('some_event', []))!.tags.length === 0);
  check('parse: contiguous groups stop at the first gap', parseMonitorHit(hit('e', [{ id: 'a', st: 'success' }, { id: 'b', st: 'success' }]))!.tags.length === 2);
  check('parse: non-monitor URL → null', parseMonitorHit('https://example.com/x?eventName=e&tag1id=1') === null);
  check('parse: empty (no event, no tags) → null', parseMonitorHit(`${MONITOR_ENDPOINT}?foo=bar`) === null);
  check('parse: malformed URL → null, no throw', parseMonitorHit('samarth-verify-monitor::::') === null);
}

// ── monitorVerdicts: authoritative fired / not-fired / status ─────────────────────
{
  const events: MonitorEvent[] = [
    parseMonitorHit(hit('gtm.load', [{ id: 'cfg', st: 'success', et: 2 }]))!,
    parseMonitorHit(hit('form_submit', [{ id: 'cfg', st: 'success' }, { id: 'lead', st: 'success', et: 8 }]))!,
    parseMonitorHit(hit('cta_click', [{ id: 'cta', st: 'failure', et: 40 }]))!,
  ];
  const v = monitorVerdicts(['cfg', 'lead', 'cta', 'never'], events);

  check('verdict: a reported tag → fired', v.get('lead')!.fired === true && v.get('lead')!.status === 'success');
  check('verdict: a tag reported on multiple events lists them all', JSON.stringify(v.get('cfg')!.onEvents) === JSON.stringify(['gtm.load', 'form_submit']));
  check('verdict: a failed tag → fired but status failure', v.get('cta')!.fired === true && v.get('cta')!.status === 'failure');
  check('verdict: a tag NEVER reported → did NOT fire', v.get('never')!.fired === false && v.get('never')!.status === 'unknown');
  check('verdict: executionTime tracked (max)', v.get('cta')!.maxExecutionMs === 40 && v.get('lead')!.maxExecutionMs === 8);
  check('verdict: only inventory tag ids are tracked (site-live/monitor tags never appear)', v.size === 4 && !v.has('site_live_tag'));
}
{
  const events: MonitorEvent[] = [
    parseMonitorHit(hit('e1', [{ id: 't', st: 'success' }]))!,
    parseMonitorHit(hit('e2', [{ id: 't', st: 'exception' }]))!,
  ];
  check('verdict: worst status wins across events (exception > success)', monitorVerdicts(['t'], events).get('t')!.status === 'exception');
}
{
  const ev = parseMonitorHit(hit('e', [{ id: 't' }]))!;
  const v = monitorVerdicts(['t'], [ev]).get('t')!;
  check('verdict: fired with no status → success', v.status === 'success' && v.fired === true);
}

console.log(`\ntag-monitor: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 20) { console.error(`expected >= 20 checks, got ${passed}`); process.exit(1); }
