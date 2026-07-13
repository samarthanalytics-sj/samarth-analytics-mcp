// Pure tests for the Tag Assistant debug-stream parser (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/ta-stream.test.ts
//
// Fixtures mirror REAL frames captured live from tagassistant.google.com connected to
// samarthanalytics.com (2026-07-10 probes): CONTAINER_STARTING/CONTAINER_DETAILS/PING wrappers and
// MEMO.data.memo.sanitized frames (EVENT_STARTED / DATA_LAYER / MACRO_RESOLVED / TAG_STARTED / TAG_STATUS).

import { parseTaFrames, eventsForContainer, containerDebugProblem, mapExecuteStatus, taEventsToMonitorEvents, toTaEventViews, buildTriggerSuggestions, pageScopeToPath, type TaEventRecord } from '../ta-stream';

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
    { container: 'GTM-X', epoch: 0, eventId: 33, eventName: 'form_submission', tags: [
      { name: 'GA4 - Event - Get In Touch Form Tag', status: 'fired' },
      { name: 'Meta - Event - Get In Touch Form Tag', status: 'failed' },
      { name: 'Some Other Container Tag', status: 'fired' }, // not in inventory — dropped
    ] },
    { container: 'GTM-X', epoch: 0, eventId: 34, eventName: 'cta_click', tags: [{ name: 'CTA Tag', status: 'running' }] },
    // The KEY case: an event where a click tag was EVALUATED but did NOT fire (unknown). It must NOT be
    // credited to this event — that was the bug that labelled click tags with the synthetic form_submission.
    { container: 'GTM-X', epoch: 0, eventId: 35, eventName: 'form_submission', tags: [
      { name: 'GA4 - Event - Get In Touch Form Tag', status: 'fired' }, // the form tag really fired here
      { name: 'Email Click Tag', status: 'unknown' },                    // evaluated, NOT fired → excluded
    ] },
  ];
  const inventory = [
    { id: '12', tagName: 'GA4 - Event - Get In Touch Form Tag' },
    { id: '13', tagName: 'Meta - Event - Get In Touch Form Tag' },
    { id: '20', tagName: 'CTA Tag' },
    { id: '30', tagName: 'Email Click Tag' },
  ];
  const me = taEventsToMonitorEvents(events, inventory);
  check('map: event names carried', me[0].event === 'form_submission' && me[1].event === 'cta_click');
  check('map: fired → success with the container tag id', me[0].tags.some((t) => t.id === '12' && t.status === 'success'));
  check('map: failed → failure', me[0].tags.some((t) => t.id === '13' && t.status === 'failure'));
  check('map: running → success (TAG_STARTED means it fired)', me[1].tags[0].status === 'success' && me[1].tags[0].id === '20');
  check('map: a tag not in the inventory is DROPPED (no cross-container credit)', me[0].tags.length === 2);
  check('map: an EVALUATED-but-not-fired (unknown) tag is EXCLUDED from the event', !me[2].tags.some((t) => t.id === '30') && me[2].tags.some((t) => t.id === '12'));
}

// ── the eventName bug: a MISLABELED key.eventName must be overridden by the real dataLayer push event ──
{
  // key.eventName lies "form_submission" for an event whose actual push is gtm.linkClick (the exact bug
  // seen live: timeline header said form_submission while the API Call said gtm.linkClick).
  const cap = parseTaFrames([
    memo('GTM-X', 50, 'form_submission', 'DATA_LAYER', { message: { event: 'gtm.linkClick', 'gtm.elementUrl': 'https://x.com' } }),
    memo('GTM-X', 50, 'form_submission', 'TAG_STATUS', { tagInfo: [{ name: 'Email Click Tag', execute: 'execute_succeeded' }] }),
  ]);
  const ev = eventsForContainer(cap, 'GTM-X')[0];
  check('eventName: the real push event (gtm.linkClick) overrides the mislabeled key.eventName', ev.eventName === 'gtm.linkClick');
  check('eventName: the apiCall push is still carried', ev.apiCall?.['gtm.elementUrl'] === 'https://x.com');
  const me2 = taEventsToMonitorEvents([ev], [{ id: '99', tagName: 'Email Click Tag' }]);
  check('eventName: the corrected name flows to the verdict pipeline', me2[0].event === 'gtm.linkClick');
}

// ── Phase 3: toTaEventViews (timeline) ──────────────────────────────────────────────────────────────
{
  const events: TaEventRecord[] = [
    { container: 'GTM-X', epoch: 0, eventId: 33, eventName: 'form_submission', apiCall: { event: 'form_submission', form_name: 'contact_form' }, variables: { 'dlv - form_name': 'contact_form' }, tags: [{ name: 'GA4 Form', status: 'fired' }, { name: 'Meta Form', status: 'failed' }] },
    { container: 'GTM-X', epoch: 0, eventId: 30, eventName: 'gtm.init', tags: [] },
  ];
  const views = toTaEventViews(events);
  check('timeline: carries eventName + apiCall push', views[0].eventName === 'form_submission' && views[0].apiCall?.form_name === 'contact_form');
  check('timeline: carries resolved variables', views[0].variables?.['dlv - form_name'] === 'contact_form');
  check('timeline: tagsFired = name+status per tag', views[0].tagsFired.length === 2 && views[0].tagsFired[0].status === 'fired' && views[0].tagsFired[1].status === 'failed');
  check('timeline: an event with no push/vars omits those keys', views[1].apiCall === undefined && views[1].variables === undefined && views[1].tagsFired.length === 0);
}

// ── Phase 3: buildTriggerSuggestions (DLV suggestions for not-fired tags) ────────────────────────────
{
  const views = toTaEventViews([
    { container: 'GTM-X', epoch: 0, eventId: 1, eventName: 'gtm.js', tags: [] },
    { container: 'GTM-X', epoch: 0, eventId: 2, eventName: 'form_submission', apiCall: { event: 'form_submission', form_name: 'contact_form', form_type: 'main' }, tags: [] },
  ]);
  // A tag that expected form_submission (which WAS captured) → suggest a trigger on it + DLV conditions.
  const s1 = buildTriggerSuggestions([{ tagName: 'Meta Form', expectedEvent: 'form_submission' }], views);
  check('suggest: uses the captured expected event', s1[0].event === 'form_submission');
  check('suggest: proposes DLV conditions from the real push (not the event key / gtm.*)', s1[0].conditions.some((c) => c.key === 'form_name' && c.value === 'contact_form') && !s1[0].conditions.some((c) => c.key === 'event'));
  check('suggest: how-text names the event + a DLV variable', /Custom Event trigger on "form_submission"/.test(s1[0].how) && /\{\{dlv - form_name\}\}/.test(s1[0].how));
  // A tag whose expected event NEVER occurred → say so, no conditions.
  const s2 = buildTriggerSuggestions([{ tagName: 'Purchase', expectedEvent: 'purchase' }], views);
  check('suggest: expected event never seen → explains it and offers no conditions', s2[0].conditions.length === 0 && /No "purchase" event was seen/.test(s2[0].how));
  // A tag with no expected event → point at the best real interaction event (not gtm.*).
  const s3 = buildTriggerSuggestions([{ tagName: 'Mystery' }], views);
  check('suggest: no expected event → picks the real interaction event (skips gtm.*)', s3[0].event === 'form_submission');
  check('suggest: empty in = empty out', buildTriggerSuggestions([], views).length === 0);

  // VOLATILE params (timestamp/nonce/uuid) must be DROPPED — a trigger scoped on them never matches again.
  const volViews = toTaEventViews([
    { container: 'GTM-X', epoch: 0, eventId: 3, eventName: 'form_submission', apiCall: { event: 'form_submission', form_name: 'solution_contact_form', form_type: 'service_request', timestamp: '2026-07-13T12:47:07.892Z', nonce: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', event_id: '1699999999999' }, tags: [] },
  ]);
  const sv = buildTriggerSuggestions([{ tagName: 'GA4 Form', expectedEvent: 'form_submission', page: '/services/custom-dashboards' }], volViews)[0];
  check('suggest: drops the volatile timestamp condition', !sv.conditions.some((c) => c.key === 'timestamp') && !/timestamp/.test(sv.how));
  check('suggest: drops nonce/uuid + event_id', !sv.conditions.some((c) => c.key === 'nonce' || c.key === 'event_id'));
  check('suggest: keeps the stable form_name / form_type', sv.conditions.some((c) => c.key === 'form_name') && sv.conditions.some((c) => c.key === 'form_type'));
  // Page Path is added as a BUILT-IN (rendered {{Page Path}}, not {{dlv - Page Path}}).
  const pp = sv.conditions.find((c) => c.key === 'Page Path');
  check('suggest: adds a {{Page Path}} built-in condition from the tag scope', !!pp && pp!.builtin === true && pp!.value === '/services/custom-dashboards');
  check('suggest: how-text renders Page Path as a built-in, not a dlv', /\{\{Page Path\}\} = "\/services\/custom-dashboards"/.test(sv.how) && !/dlv - Page Path/.test(sv.how));
  // At most 2 DLV conditions (+ Page Path) — specific but simple.
  check('suggest: caps DLV conditions at 2 (form_name, form_type) + Page Path', sv.conditions.filter((c) => !c.builtin).length === 2 && sv.conditions.length === 3);
  // Site-wide scope → no Page Path condition (nothing to filter on).
  const swide = buildTriggerSuggestions([{ tagName: 'GA4 Form', expectedEvent: 'form_submission', page: 'site-wide' }], volViews)[0];
  check('suggest: site-wide scope adds no Page Path condition', !swide.conditions.some((c) => c.key === 'Page Path'));
  // pageScopeToPath: URL / bare host / path / site-wide.
  check('pageScopeToPath: full URL → pathname', pageScopeToPath('https://www.example.com/contact?x=1') === '/contact');
  check('pageScopeToPath: bare host/path → path', pageScopeToPath('www.example.com/services/x') === '/services/x');
  check('pageScopeToPath: already a path → unchanged', pageScopeToPath('/careers') === '/careers');
  check('pageScopeToPath: site-wide / empty → null', pageScopeToPath('site-wide') === null && pageScopeToPath('') === null && pageScopeToPath(undefined) === null);
}

// ── the MULTI-PAGE collision bug: gtm.uniqueEventId resets per page, so a drive across pages must NOT
//    merge page-B's event N onto page-A's event N (that mislabeled click tags as gtm.formInteract). ──────
{
  const dl = (id: number, name: string, extra: Record<string, unknown> = {}): string =>
    memo('GTM-NKZD4BVB', id, name, 'DATA_LAYER', { message: { event: name, ...extra } });
  const tag = (id: number, name: string, tagName: string): string =>
    memo('GTM-NKZD4BVB', id, name, 'TAG_STATUS', { tagInfo: [{ name: tagName, execute: 'execute_succeeded' }] });
  const frames: unknown[] = [
    starting('GTM-NKZD4BVB', true),
    details('GTM-NKZD4BVB', true),
    // PAGE 1: an email link click fires the Email Click tags (uniqueEventId 0,1,5).
    dl(0, 'gtm.init'), dl(1, 'gtm.js'),
    dl(5, 'gtm.linkClick', { 'gtm.elementUrl': 'mailto:hi@x.com' }),
    tag(5, 'gtm.linkClick', 'GA4 - Event - Email Click Tag'),
    tag(5, 'gtm.linkClick', 'Meta - Event - Email Click Tag'),
    // PAGE 2 (navigation → uniqueEventId RESTARTS at 0): a form interaction fires the CTA tag, also at
    // eventId 5. Pre-fix this collided with page 1's event 5 and the later push (gtm.formInteract) won,
    // so the Email Click tags were wrongly shown under gtm.formInteract.
    dl(0, 'gtm.init'), dl(1, 'gtm.js'),
    dl(5, 'gtm.formInteract', { 'gtm.elementId': 'contact' }),
    tag(5, 'gtm.formInteract', 'GA4 - Event - CTA Click Tag'),
  ];
  const cap = parseTaFrames(frames);
  const evs = eventsForContainer(cap, 'GTM-NKZD4BVB');
  check('multi-page: the two same-eventId events are kept SEPARATE (not merged)', evs.filter((e) => e.eventId === 5).length === 2);
  check('multi-page: they carry distinct page epochs', new Set(evs.filter((e) => e.eventId === 5).map((e) => e.epoch)).size === 2);
  check('multi-page: page-1 order (epoch,eventId) comes before page-2', evs[0].epoch === 0 && evs[evs.length - 1].epoch === 1);
  const lc = evs.find((e) => e.eventName === 'gtm.linkClick')!;
  const fi = evs.find((e) => e.eventName === 'gtm.formInteract')!;
  check('multi-page: Email Click tags are attributed to gtm.linkClick (the actual bug)', lc.tags.some((t) => t.name === 'GA4 - Event - Email Click Tag' && t.status === 'fired'));
  check('multi-page: the click event does NOT carry the other page’s CTA tag', !lc.tags.some((t) => t.name === 'GA4 - Event - CTA Click Tag'));
  check('multi-page: CTA tag stays on gtm.formInteract, uncontaminated by the click tags', fi.tags.some((t) => t.name === 'GA4 - Event - CTA Click Tag') && !fi.tags.some((t) => /Email Click/.test(t.name)));
  const views = toTaEventViews(evs);
  check('multi-page: every timeline view gets a unique seq (stable identity despite repeated eventId)', new Set(views.map((v) => v.seq)).size === views.length && views.length === evs.length);
  check('multi-page: seq is 1-based chronological', views[0].seq === 1 && views[views.length - 1].seq === views.length);
}

// ── a DUPLICATE DATA_LAYER frame (same eventId) must NOT be mistaken for a new page ─────────────────────
{
  const cap = parseTaFrames([
    memo('GTM-Y', 0, 'gtm.init', 'DATA_LAYER', { message: { event: 'gtm.init' } }),
    memo('GTM-Y', 1, 'gtm.js', 'DATA_LAYER', { message: { event: 'gtm.js' } }),
    memo('GTM-Y', 2, 'purchase', 'DATA_LAYER', { message: { event: 'purchase' } }),
    memo('GTM-Y', 2, 'purchase', 'DATA_LAYER', { message: { event: 'purchase' } }), // re-emit, same id
    memo('GTM-Y', 2, 'purchase', 'TAG_STATUS', { tagInfo: [{ name: 'GA4 Purchase', execute: 'execute_succeeded' }] }),
  ]);
  const evs = eventsForContainer(cap, 'GTM-Y');
  check('duplicate push: no phantom epoch split (one purchase event, tag intact)', evs.filter((e) => e.eventName === 'purchase').length === 1 && evs.find((e) => e.eventName === 'purchase')!.tags[0]?.status === 'fired');
}

console.log(`\nta-stream: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 37) { console.error(`expected >= 37 checks, got ${passed}`); process.exit(1); }
