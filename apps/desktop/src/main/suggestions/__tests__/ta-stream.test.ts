// Pure tests for the Tag Assistant debug-stream parser (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/ta-stream.test.ts
//
// Fixtures mirror REAL frames captured live from tagassistant.google.com connected to
// samarthanalytics.com (2026-07-10 probes): CONTAINER_STARTING/CONTAINER_DETAILS/PING wrappers and
// MEMO.data.memo.sanitized frames (EVENT_STARTED / DATA_LAYER / MACRO_RESOLVED / TAG_STARTED / TAG_STATUS).

import { parseTaFrames, eventsForContainer, containerDebugProblem, mapExecuteStatus, taEventsToMonitorEvents, type TaEventRecord } from '../ta-stream';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── fixture builders (the real frame shapes, minus irrelevant bulk) ───────────────
const memo = (publicId: string, eventId: number, eventName: string, messageType: string, extra: Record<string, unknown> = {}, tagName?: string): string =>
  JSON.stringify({ type: 'MEMO', data: { memo: { sanitized: { containerProduct: 'GTM', key: { publicId, eventId, eventName, ...(tagName ? { tagName } : {}) }, version: '1', messageType, ...extra } } } });
const starting = (id: string, debug: boolean, product = 'GTM'): string =>
  JSON.stringify({ type: 'CONTAINER_STARTING', data: { id, debug, containerProduct: product, scriptSource: `https://www.googletagmanager.com/gtm.js?id=${id}` } });
const details = (id: string, found: boolean): string =>
  JSON.stringify({ type: 'CONTAINER_DETAILS', data: { id, status: found ? 'DETAILS_FOUND' : 'DETAILS_NOT_FOUND' } });

// ── mapExecuteStatus ──────────────────────────────────────────────────────────────
check('status: execute_succeeded → fired', mapExecuteStatus('execute_succeeded') === 'fired');
check('status: execute_running → running', mapExecuteStatus('execute_running') === 'running');
check('status: execute_failure → failed', mapExecuteStatus('execute_failure') === 'failed');
check('status: weird/absent → unknown', mapExecuteStatus('zzz') === 'unknown' && mapExecuteStatus(undefined) === 'unknown');

// ── full capture: the user's screenshot scenario ──────────────────────────────────
{
  const frames: unknown[] = [
    JSON.stringify({ type: 'PING', locale: 'en' }), // junk — skipped
    'not json at all', // junk — skipped
    starting('GTM-NKZD4BVB', false),
    starting('GTM-NKZD4BVB', true), // debug RELOAD — debug:true must win
    details('GTM-NKZD4BVB', true),
    // form_submission event 33: the push, a resolved DLV, two tags firing
    memo('GTM-NKZD4BVB', 33, 'form_submission', 'EVENT_STARTED'),
    memo('GTM-NKZD4BVB', 33, 'form_submission', 'DATA_LAYER', {
      message: { event: 'form_submission', form_name: 'contact_form', form_type: 'main_contact', 'gtm.uniqueEventId': 43 },
      macroInfo: [{ name: 'dlv - form_name', type: 'v', resolvedValue: 'contact_form' }],
    }),
    memo('GTM-NKZD4BVB', 33, 'form_submission', 'TAG_STARTED', {}, 'GA4 - Event - Get In Touch Form Tag'),
    memo('GTM-NKZD4BVB', 33, 'form_submission', 'TAG_STATUS', { tagInfo: [{ name: 'GA4 - Event - Get In Touch Form Tag', execute: 'execute_running' }] }),
    memo('GTM-NKZD4BVB', 33, 'form_submission', 'TAG_STATUS', { tagInfo: [{ name: 'GA4 - Event - Get In Touch Form Tag', execute: 'execute_succeeded' }] }),
    memo('GTM-NKZD4BVB', 33, 'form_submission', 'TAG_STATUS', { tagInfo: [{ name: 'Meta - Event - Get In Touch Form Tag', execute: 'execute_succeeded' }] }),
    // a click event 31 with a failing tag
    memo('GTM-NKZD4BVB', 31, 'gtm.linkClick', 'EVENT_STARTED'),
    memo('GTM-NKZD4BVB', 31, 'gtm.linkClick', 'TAG_STATUS', { tagInfo: [{ name: 'GA4 - Event - Email Click Tag', execute: 'execute_failure' }] }),
    // another container's frames must not bleed in
    memo('G-TDV157MGKV', 16, 'form_submission', 'TAG_STATUS', { tagInfo: [{ name: '_Tagging Activity Tag 4', execute: 'execute_running' }] }),
  ];
  const cap = parseTaFrames(frames);

  const gtm = cap.containers.find((c) => c.id === 'GTM-NKZD4BVB')!;
  check('container: parsed with debug:true (reload wins over first plain load)', gtm.debug === true);
  check('container: detailsFound carried', gtm.detailsFound === true);
  check('container: debug problem is null when debugging', containerDebugProblem(cap, 'GTM-NKZD4BVB') === null);

  const evs = eventsForContainer(cap, 'GTM-NKZD4BVB');
  check('events: two GTM events, chronological by eventId', evs.length === 2 && evs[0].eventId === 31 && evs[1].eventId === 33);
  const form = evs[1];
  check('event: name form_submission', form.eventName === 'form_submission');
  check('event: apiCall is the exact push (TA "API Call" block)', form.apiCall?.form_name === 'contact_form' && form.apiCall?.form_type === 'main_contact');
  check('event: resolved variable captured for DLV suggestions', form.variables?.['dlv - form_name'] === 'contact_form');
  const ga4 = form.tags.find((t) => t.name === 'GA4 - Event - Get In Touch Form Tag')!;
  const meta = form.tags.find((t) => t.name === 'Meta - Event - Get In Touch Form Tag')!;
  check('tags: GA4 tag fired (succeeded beats earlier running)', ga4.status === 'fired');
  check('tags: Meta tag fired', meta.status === 'fired');
  check('tags: click event has the failed tag', evs[0].tags[0]?.name === 'GA4 - Event - Email Click Tag' && evs[0].tags[0]?.status === 'failed');
  check('isolation: the gtag container’s tag never appears under GTM events', evs.every((e) => e.tags.every((t) => !/_Tagging Activity/.test(t.name))));
  check('isolation: gtag container has its own event', eventsForContainer(cap, 'G-TDV157MGKV').length === 1);
}

// ── the signed-out case (what the probe hit): GTM container not enabled for debugging ─────────────
{
  const cap = parseTaFrames([starting('GTM-NKZD4BVB', false), details('GTM-NKZD4BVB', false)]);
  const problem = containerDebugProblem(cap, 'GTM-NKZD4BVB');
  check('signed-out: problem names the sign-in requirement', /signed-in|sign in/i.test(problem ?? ''));
  check('unknown container: problem says TA never saw it', /never saw/.test(containerDebugProblem(cap, 'GTM-MISSING') ?? ''));
}

// ── worst-status-wins: failed is never papered over by a later running frame ───────────────────────
{
  const cap = parseTaFrames([
    memo('GTM-X', 1, 'e', 'TAG_STATUS', { tagInfo: [{ name: 'T', execute: 'execute_failure' }] }),
    memo('GTM-X', 1, 'e', 'TAG_STARTED', {}, 'T'),
  ]);
  check('worst status wins: failed not downgraded by later running', eventsForContainer(cap, 'GTM-X')[0].tags[0].status === 'failed');
}

// ── malformed frames never throw ────────────────────────────────────────────────────
{
  const cap = parseTaFrames([null, 42, {}, { type: 'MEMO' }, { type: 'MEMO', data: { memo: {} } }, JSON.stringify({ type: 'MEMO', data: { memo: { sanitized: { messageType: 'DATA_LAYER' } } } })]);
  check('malformed frames → empty capture, no throw', cap.events.length === 0 && cap.containers.length === 0);
}

// ── taEventsToMonitorEvents: TA names → container tag IDs for the existing verdict pipeline ─────────
{
  const events: TaEventRecord[] = [
    { container: 'GTM-X', eventId: 33, eventName: 'form_submission', tags: [
      { name: 'GA4 - Event - Get In Touch Form Tag', status: 'fired' },
      { name: 'Meta - Event - Get In Touch Form Tag', status: 'failed' },
      { name: 'Some Other Container Tag', status: 'fired' }, // not in inventory — dropped
    ] },
    { container: 'GTM-X', eventId: 34, eventName: 'cta_click', tags: [{ name: 'CTA Tag', status: 'running' }] },
  ];
  const inventory = [
    { id: '12', tagName: 'GA4 - Event - Get In Touch Form Tag' },
    { id: '13', tagName: 'Meta - Event - Get In Touch Form Tag' },
    { id: '20', tagName: 'CTA Tag' },
  ];
  const me = taEventsToMonitorEvents(events, inventory);
  check('map: event names carried', me[0].event === 'form_submission' && me[1].event === 'cta_click');
  check('map: fired → success with the container tag id', me[0].tags.some((t) => t.id === '12' && t.status === 'success'));
  check('map: failed → failure', me[0].tags.some((t) => t.id === '13' && t.status === 'failure'));
  check('map: running → unknown (still fired; treated clean by monitorVerdicts)', me[1].tags[0].status === 'unknown' && me[1].tags[0].id === '20');
  check('map: a tag not in the inventory is DROPPED (no cross-container credit)', me[0].tags.length === 2);
}

console.log(`\nta-stream: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 18) { console.error(`expected >= 18 checks, got ${passed}`); process.exit(1); }
