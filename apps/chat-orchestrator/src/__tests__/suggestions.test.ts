/**
 * The server state behind the Tag suggestions page.
 *
 * The rule these tests exist to hold: the browser sends a scan id and row ids, and everything the
 * GTM API is eventually asked to do is rebuilt from this process's own copy of the scan. A test that
 * let a row be created from data in the request would let the endpoint become a write proxy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ScanStore,
  selectRows,
  toRows,
  withMeasurementId,
  createSelected,
  SCAN_TTL_MS,
  type StoredScan,
} from '../suggestions.js';
import type { SuggestedTagView } from '../../../desktop/src/shared/ipc';

const scanResult = (n: number) => ({
  site: 'https://example.com',
  warnings: [],
  suggestions: Array.from({ length: n }, (_, i) => ({
    tagName: `GA4 Event - Tag ${i + 1}`,
    platform: 'ga4_event',
    eventName: `event_${i + 1}`,
    trigger: { type: 'click', name: `Trigger ${i + 1}` },
  })) as Record<string, unknown>[],
});

test('a scan is readable by the user who ran it', () => {
  const store = new ScanStore();
  const scan = store.put('user-a', scanResult(2));
  assert.equal(store.get('user-a', scan.id)?.suggestions.length, 2);
});

test('a scan is not readable by anyone else', () => {
  // The id is a random UUID, but it is handed to a browser, and an unguessable string is not an
  // authorisation model.
  const store = new ScanStore();
  const scan = store.put('user-a', scanResult(2));
  assert.equal(store.get('user-b', scan.id), null);
});

test('an expired scan is gone rather than stale', () => {
  const store = new ScanStore();
  const scan = store.put('user-a', scanResult(1));
  const stored = store.get('user-a', scan.id) as StoredScan;
  stored.createdAt = Date.now() - SCAN_TTL_MS - 1;
  assert.equal(store.get('user-a', scan.id), null);
});

test('every suggestion gets an id, because rows are chosen by id alone', () => {
  const store = new ScanStore();
  const scan = store.put('user-a', scanResult(3));
  assert.deepEqual(
    scan.suggestions.map((s) => s.id),
    ['s1', 's2', 's3'],
  );
  assert.equal(new Set(scan.suggestions.map((s) => s.id)).size, 3, 'ids must be distinct');
});

test('an unknown row id fails the request instead of being skipped', () => {
  // Creating four tags when five were ticked is the kind of wrong that surfaces days later, in a
  // container someone else has to debug.
  const store = new ScanStore();
  const scan = store.put('user-a', scanResult(2));
  const { selected, unknown } = selectRows(scan, ['s1', 's9']);
  assert.deepEqual(unknown, ['s9']);
  assert.equal(selected.length, 1);
});

test('rows keep the order the scan produced, not the order they were ticked', () => {
  const store = new ScanStore();
  const scan = store.put('user-a', scanResult(3));
  const { selected } = selectRows(scan, ['s3', 's1']);
  assert.deepEqual(
    selected.map((s) => s.id),
    ['s1', 's3'],
  );
});

test('rows sent to the browser carry no tool payload', () => {
  const store = new ScanStore();
  const scan = store.put('user-a', scanResult(1));
  const row = toRows(scan.suggestions)[0] as unknown as Record<string, unknown>;
  assert.equal(row.tagName, 'GA4 Event - Tag 1');
  assert.equal(row.measurementId, undefined, 'the create payload stays on the server');
  assert.equal(row.eventParameters, undefined);
});

test('a supplied measurement id is used verbatim', () => {
  const list = [{ id: 's1', tagName: 'T', platform: 'ga4_event' }] as unknown as SuggestedTagView[];
  assert.equal(withMeasurementId(list, ' G-ABC123 ')[0].measurementId, 'G-ABC123');
});

test("the scanner's variable stand-in becomes a lookup, not a live reference", () => {
  // Observed on a real scan: the engine emits measurementId "{{GA4 Measurement ID}}" because it
  // cannot know the id. Sent through as-is, GTM accepts a reference to a variable that may not
  // exist, and the tag reports to nothing while looking created.
  const list = [
    { id: 's1', tagName: 'T', platform: 'ga4_event', measurementId: '{{GA4 Measurement ID}}' },
  ] as unknown as SuggestedTagView[];
  assert.equal(withMeasurementId(list, '')[0].measurementId, 'G-XXXXXXXXXX');
  assert.equal(withMeasurementId(list, undefined)[0].measurementId, 'G-XXXXXXXXXX');
});

test('a real id already on a row is left alone', () => {
  const list = [
    { id: 's1', tagName: 'T', platform: 'ga4_event', measurementId: 'G-REAL123' },
    { id: 's2', tagName: 'U', platform: 'ga4_event' },
  ] as unknown as SuggestedTagView[];
  const out = withMeasurementId(list, undefined);
  assert.equal(out[0].measurementId, 'G-REAL123');
  assert.equal(out[1].measurementId, undefined, 'no id and no stand-in stays absent');
});

test('an explicit id beats the stand-in', () => {
  const list = [
    { id: 's1', tagName: 'T', platform: 'ga4_event', measurementId: '{{GA4 Measurement ID}}' },
  ] as unknown as SuggestedTagView[];
  assert.equal(withMeasurementId(list, 'G-MINE99')[0].measurementId, 'G-MINE99');
});

test('outcomes are counted apart: created, already there, and failed', async () => {
  const tags = [
    { id: 's1', tagName: 'A', platform: 'ga4_event', trigger: {} },
    { id: 's2', tagName: 'B', platform: 'ga4_event', trigger: {} },
    { id: 's3', tagName: 'C', platform: 'ga4_event', trigger: {} },
  ] as unknown as SuggestedTagView[];

  const execute = async (_name: string, args: Record<string, unknown>): Promise<string> => {
    if (args.tagName === 'B') throw new Error('Found entity with duplicate name');
    if (args.tagName === 'C') throw new Error('Request had insufficient authentication scopes');
    return JSON.stringify({ tag: { name: args.tagName, tagId: '1' }, trigger: { reused: false } });
  };

  const result = await createSelected(execute, { accountId: '1', containerId: '2', workspaceId: '3' }, tags);
  assert.equal(result.created, 1);
  assert.equal(result.existing, 1, 'a name that already exists is not a failure and not a creation');
  assert.equal(result.failed, 1);
  assert.equal(result.outcomes.length, 3, 'every selected row reports an outcome');
});

// ── Finding the scanner ──────────────────────────────────────────────────────
//
// This module runs from two depths: apps/chat-orchestrator/src under tsx, and
// apps/chat-orchestrator/dist/chat-orchestrator/src after a build. A fixed number of ".." segments is
// right in exactly one of them, and wrong silently in the other.

test('the built scanner is found from either depth this module runs at', async () => {
  // Against a fake tree rather than the real repo. The first version of this test asserted that the
  // web-audit MCP was built, which is true on a development machine and false on CI, where dist is
  // not checked in and nothing builds that package before these tests. That is an assertion about
  // the environment wearing the costume of an assertion about the code.
  const { findWebAuditEntry } = await import('../scan-client.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const root = mkdtempSync(path.join(tmpdir(), 'scan-entry-'));
  const entry = path.join(root, 'apps/web-audit-mcp/dist/web-audit-mcp/src/index.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '// built scanner\n');

  const fromSrc = path.join(root, 'apps/chat-orchestrator/src');
  const fromDist = path.join(root, 'apps/chat-orchestrator/dist/chat-orchestrator/src');
  mkdirSync(fromDist, { recursive: true });

  assert.equal(findWebAuditEntry(fromSrc), entry, 'must be found from the tsx depth');
  assert.equal(findWebAuditEntry(fromDist), entry, 'must be found from the post-build depth');
});

test('an unbuilt scanner is reported as missing rather than guessed at', async () => {
  const { findWebAuditEntry } = await import('../scan-client.js');
  // The filesystem root: the walk hits the top without finding a build and gives up.
  assert.equal(findWebAuditEntry(path.parse(process.cwd()).root), null);
});

// ── The type column ──────────────────────────────────────────────────────────
//
// The engine writes trigger.kind; create_gtm_tracking_tag's schema calls the same thing type. The
// first version read only `type`, and a live scan came back with every row's type blank.

test('the trigger kind is read from whichever field carries it', () => {
  const rows = toRows([
    { id: 'a', tagName: 'A', platform: 'ga4_event', trigger: { kind: 'link_click' } },
    { id: 'b', tagName: 'B', platform: 'ga4_event', trigger: { type: 'form_submit' } },
    { id: 'c', tagName: 'C', platform: 'ga4_event', trigger: { kind: 'custom_event' } },
  ] as unknown as SuggestedTagView[]);
  assert.deepEqual(
    rows.map((r) => r.triggerKind),
    ['Click', 'Form', 'Custom event'],
  );
});

test('an unrecognised kind is shown, not dropped', () => {
  // A new trigger type in the engine must not silently blank the column.
  const rows = toRows([
    { id: 'a', tagName: 'A', platform: 'ga4_event', trigger: { kind: 'history_change' } },
    { id: 'b', tagName: 'B', platform: 'ga4_event', trigger: {} },
  ] as unknown as SuggestedTagView[]);
  assert.equal(rows[0].triggerKind, 'history change');
  assert.equal(rows[1].triggerKind, undefined, 'no kind at all stays absent rather than guessing');
});

test('only platforms the engine knows survive the request', async () => {
  const { validPlatforms } = await import('../scan-client.js');
  assert.deepEqual(validPlatforms(['ga4', 'meta']), ['ga4', 'meta']);
  assert.deepEqual(validPlatforms(['ga4', 'facebook', 'GA4']), ['ga4'], 'unknown names are dropped');
  assert.deepEqual(validPlatforms(['meta', 'meta']), ['meta'], 'duplicates collapse');
  assert.deepEqual(validPlatforms('ga4'), [], 'a non-array is not a platform list');
  assert.deepEqual(validPlatforms(undefined), []);
});

// ── Screenshots ──────────────────────────────────────────────────────────────

const withImages = (pages: string[]) => ({
  site: 'https://example.com',
  warnings: [],
  suggestions: pages.map((p, i) => ({
    tagName: `Tag ${i + 1}`,
    platform: 'ga4_event',
    page: p,
    trigger: { kind: 'link_click' },
  })) as Record<string, unknown>[],
  pageImages: [{ page: '/contact', image: Buffer.from('jpeg-bytes').toString('base64'), bytes: 10 }],
});

test('a row says it has a picture only when one was actually captured', async () => {
  // A capture can fail while its page still yields suggestions. Offering a View button that 404s is
  // worse than not offering one, so this is a stored fact rather than an inference from `page`.
  const { imageForRow } = await import('../suggestions.js');
  const store = new ScanStore();
  const scan = store.put('u1', withImages(['/contact', '/pricing', 'site-wide']));
  const rows = toRows(scan.suggestions, scan.images);
  assert.deepEqual(
    rows.map((r) => r.hasImage === true),
    [true, false, false],
  );
  assert.ok(imageForRow(scan, rows[0].id), 'the captured page resolves to bytes');
  assert.equal(imageForRow(scan, rows[1].id), null, 'an uncaptured page has none');
  assert.equal(imageForRow(scan, 'nope'), null, 'an unknown row has none');
});

test('an image is reached through a row, never by page path from the request', async () => {
  // Looking it up by a path in the URL would let a caller ask a scan for pages it never scanned, and
  // probe which paths exist on someone else's site.
  const { imageForRow } = await import('../suggestions.js');
  const store = new ScanStore();
  const scan = store.put('u1', withImages(['/contact']));
  const bytes = imageForRow(scan, scan.suggestions[0].id);
  assert.equal(bytes?.toString(), 'jpeg-bytes');
});

test('another user cannot reach the pictures of a scan', () => {
  const store = new ScanStore();
  const scan = store.put('u1', withImages(['/contact']));
  assert.equal(store.get('u2', scan.id), null, 'no scan, so no route to its images');
});


// ── Trigger detail ───────────────────────────────────────────────────────────
//
// The table printed the trigger's NAME and nothing else. A form trigger scoped to one form id and
// one scoped to a page path have the same kind of name and completely different behaviour.

/** Conditions without the operator menu, which is asserted on its own below. */
const shape = (list: unknown): unknown =>
  (list as Array<Record<string, unknown>> | undefined)?.map(({ operators: _drop, ...rest }) => rest);

test('an editable condition carries the operators GTM offers for it', () => {
  // Sent with the condition rather than hardcoded in the page. A dropdown offering an operator the
  // server refuses is a change that reports saved and is not.
  const rows = toRows([
    {
      id: 'a',
      tagName: 'CTA',
      platform: 'ga4_event',
      trigger: { name: 'T', kind: 'all_clicks', clickElementValue: '.cta', clickTextValue: 'Buy' },
    },
  ] as unknown as SuggestedTagView[]);
  const byVar = new Map((rows[0].conditions ?? []).map((c) => [c.variable, c]));
  assert.ok(
    byVar.get('Click Element')?.operators?.some((o) => o.key === 'cssSelector'),
    'an element condition can match a selector',
  );
  assert.ok(
    !byVar.get('Click Text')?.operators?.some((o) => o.key === 'cssSelector'),
    'a text condition cannot',
  );
  assert.deepEqual(byVar.get('Click Text')?.operators?.[0], { key: 'equals', label: 'equals' });
});

test('a click trigger reports the variable, operator and value it filters on', () => {
  const rows = toRows([
    {
      id: 'a',
      tagName: 'Email',
      platform: 'ga4_event',
      trigger: { name: 'Email Click Trigger', kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' },
    },
  ] as unknown as SuggestedTagView[]);
  assert.equal(rows[0].triggerName, 'Email Click Trigger');
  assert.equal(rows[0].triggerType, 'Click - Just Links', "GTM's own wording, not the internal kind");
  assert.deepEqual(shape(rows[0].conditions), [
    { variable: 'Click URL', operator: 'starts with', value: 'mailto:', editable: true, carried: true },
  ]);
});

test('a custom event leads with the event name, then its scope', () => {
  const rows = toRows([
    {
      id: 'a',
      tagName: 'Contact',
      platform: 'ga4_event',
      trigger: {
        name: 'Contact Form Trigger',
        kind: 'custom_event',
        eventName: 'form_submit',
        pagePathValue: '/contact',
        pagePathOperator: 'contains',
        dataLayerConditions: [{ key: 'form_id', value: 'wpcf7-f12', operator: 'equals' }],
      },
    },
  ] as unknown as SuggestedTagView[]);
  assert.deepEqual(shape(rows[0].conditions), [
    // Carried but not editable: the listener tag pushes this exact string.
    { variable: 'Event name', operator: 'equals', value: 'form_submit', carried: true },
    { variable: 'Page Path', operator: 'contains', value: '/contact', editable: true, carried: true },
    // Not carried: it needs a `dlv - form_id` variable that this create path does not provision.
    { variable: 'dlv - form_id', operator: 'equals', value: 'wpcf7-f12', carried: false },
  ]);
});

test('a lookup table names the texts behind it, not just the variable', () => {
  // The variable returning "true" is one GTM condition, but the texts ARE the scope, and hiding them
  // behind a variable name makes the row unreadable.
  const rows = toRows([
    {
      id: 'a',
      tagName: 'CTA',
      platform: 'ga4_event',
      trigger: { name: 'CTA Trigger', kind: 'all_clicks', lookupTable: { name: 'lt - CTA', texts: ['Book a demo', 'Get started'] } },
    },
  ] as unknown as SuggestedTagView[]);
  assert.deepEqual(rows[0].conditions, [
    { variable: 'lt - CTA', operator: 'equals', value: 'true (for: Book a demo, Get started)', carried: false },
  ]);
});

test('a trigger with no filters says so rather than looking like missing data', () => {
  const rows = toRows([
    { id: 'a', tagName: 'All', platform: 'ga4_event', trigger: { name: 'All Forms Trigger', kind: 'form_submit' } },
  ] as unknown as SuggestedTagView[]);
  assert.equal(rows[0].conditions, undefined);
  assert.equal(rows[0].triggerType, 'Form Submission');
});

// ── Install plans ────────────────────────────────────────────────────────────
//
// A row that can never fire looked exactly like one that fires the moment it is created. On a real
// scan the Contact Form row is a Custom Event on form_submit against a Calendly embed: created
// as-is it is correct, permanent and silent, because nothing on the site pushes that event.

test('a native element needs nothing, and says so', async () => {
  const { installSummary } = await import('../suggestions.js');
  const plan = installSummary({
    summary: 'Native Link Click - nothing to install.',
    requires: [{ kind: 'native', detail: "GTM's built-in trigger fires on the link click." }],
  });
  assert.equal(plan?.firesAsIs, true);
  assert.equal(plan?.listenerAvailable, false);
  assert.equal(plan?.needsSiteCode, false);
});

test('a cross-origin form reports that a listener tag is available', async () => {
  const { installSummary } = await import('../suggestions.js');
  const plan = installSummary({
    summary: 'Auto-create 1 Custom HTML listener tag; no site code needed.',
    requires: [{ kind: 'listener-tag', event: 'form_submit', detail: 'Calendly submits in an iframe.' }],
  });
  assert.equal(plan?.firesAsIs, false, 'this cannot fire as things stand');
  assert.equal(plan?.listenerAvailable, true);
  assert.equal(plan?.needsSiteCode, false, 'a listener tag is not site code: GTM can hold it');
});

test('a plan needing a developer is not softened into one that does not', async () => {
  const { installSummary } = await import('../suggestions.js');
  const plan = installSummary({
    summary: 'Your developer must push the event.',
    requires: [
      { kind: 'html-attribute', detail: 'Add id="contact" to the form.' },
      { kind: 'site-code', detail: 'Push form_submit on success.' },
    ],
  });
  assert.equal(plan?.needsSiteCode, true);
  assert.equal(plan?.firesAsIs, false);
});

test('no plan at all stays absent rather than becoming an empty one', async () => {
  const { installSummary } = await import('../suggestions.js');
  assert.equal(installSummary(undefined), undefined);
  assert.equal(installSummary({ summary: 'x', requires: [] }), undefined);
});

// ── What can actually be created, and the listener that makes it fire ────────

test('a platform this deployment cannot build is refused before anything is written', async () => {
  // The MCP's create tool builds GA4 and Custom HTML tags. It had no platform field at all, so zod
  // dropped the key and a Meta row came back "Created" as a GA4 tag carrying a Meta pixel id.
  const { splitCreatable } = await import('../suggestions.js');
  const { supported, unsupported } = splitCreatable([
    { id: 'a', platform: 'ga4_event', tagName: 'A' },
    { id: 'b', platform: 'meta_pixel', tagName: 'B' },
    { id: 'c', platform: 'google_ads_conversion', tagName: 'C' },
  ] as unknown as SuggestedTagView[]);
  assert.deepEqual(supported.map((s) => s.id), ['a']);
  assert.deepEqual(unsupported.map((u) => u.id), ['b', 'c']);
  assert.match(unsupported[0].reason, /desktop app/, 'the reason names where it can be done');
});

test('one listener serves every row that needs it', async () => {
  // A listener is per site behaviour, not per tag. Three forms behind the same embed need one
  // listener between them; creating it three times leaves three copies pushing on every page.
  const { listenerTagsFor } = await import('../suggestions.js');
  const rows = [1, 2, 3].map((n) => ({
    id: `s${n}`,
    platform: 'ga4_event',
    tagName: `Form ${n}`,
    install: {
      requires: [{ kind: 'listener-tag', tag: { name: 'cHTML - Calendly listener', html: '<script></script>', fires: 'all_pages' } }],
    },
  })) as unknown as SuggestedTagView[];
  const listeners = listenerTagsFor(rows);
  assert.equal(listeners.length, 1);
  assert.deepEqual(listeners[0].forRows, ['s1', 's2', 's3']);
});

test('a row with nothing to install asks for no listener', async () => {
  const { listenerTagsFor } = await import('../suggestions.js');
  const rows = [
    { id: 'a', platform: 'ga4_event', tagName: 'A', install: { requires: [{ kind: 'native', detail: 'x' }] } },
    { id: 'b', platform: 'ga4_event', tagName: 'B' },
  ] as unknown as SuggestedTagView[];
  assert.deepEqual(listenerTagsFor(rows), []);
});

test('every write carries confirm, or the MCP refuses it before GTM is reached', async () => {
  // The bug this exists for: nothing on this path sent `confirm`, every guarded write in the MCP
  // requires it, and so EVERY create from the website failed validation with "Required at confirm".
  // The page ticked rows, reported a failure per row, and created nothing. A test on the pure
  // function is the only thing that holds it, because the route that used to be responsible for
  // adding it is not unit-tested.
  const calls: Record<string, unknown>[] = [];
  const execute = async (_n: string, args: Record<string, unknown>): Promise<string> => {
    calls.push(args);
    return JSON.stringify({ tag: { name: args.tagName, tagId: '1' }, trigger: { reused: false } });
  };
  const rows = [
    {
      id: 's1',
      platform: 'ga4_event',
      tagName: 'Contact Form',
      trigger: { name: 'T', kind: 'custom_event', eventName: 'form_submit' },
      install: {
        requires: [
          { kind: 'listener-tag', tag: { name: 'cHTML - listener', html: '<script></script>', fires: 'all_pages' } },
        ],
      },
    },
    { id: 's2', platform: 'ga4_event', tagName: 'Email', trigger: { name: 'E', kind: 'link_click' } },
  ] as unknown as SuggestedTagView[];

  await createSelected(execute, { accountId: '1', containerId: '2', workspaceId: '3' }, rows);
  assert.equal(calls.length, 3, 'one listener and two tags');
  for (const args of calls) {
    assert.equal(args.confirm, true, `"${String(args.tagName)}" was sent without confirm`);
  }
});

test('the listener is created before the tag that depends on it', async () => {
  // A GA4 tag on a Custom Event trigger does nothing until something pushes that event. Creating the
  // listener afterwards leaves a window where the container looks complete and reports nothing.
  const order: string[] = [];
  const execute = async (_n: string, args: Record<string, unknown>): Promise<string> => {
    order.push(String(args.platform ?? 'ga4_event'));
    return JSON.stringify({ tag: { name: args.tagName, tagId: '1' }, trigger: { reused: false } });
  };
  const rows = [
    {
      id: 's1',
      platform: 'ga4_event',
      tagName: 'Contact Form',
      trigger: { name: 'T', kind: 'custom_event', eventName: 'form_submit' },
      install: { requires: [{ kind: 'listener-tag', tag: { name: 'cHTML - listener', html: '<script></script>', fires: 'all_pages' } }] },
    },
  ] as unknown as SuggestedTagView[];

  const result = await createSelected(execute, { accountId: '1', containerId: '2', workspaceId: '3' }, rows);
  assert.deepEqual(order, ['custom_html', 'ga4_event'], 'listener first, then the tag');
  assert.equal(result.listeners.length, 1);
  assert.equal(result.listeners[0].ok, true);
  assert.equal(result.created, 1);
});

test('a failed listener does not stop its tag being created', async () => {
  // The tag is still correct, and a half-built pair someone can finish by hand beats nothing, as
  // long as the failure is reported.
  const execute = async (_n: string, args: Record<string, unknown>): Promise<string> => {
    if (args.platform === 'custom_html') throw new Error('quota exceeded for this container');
    return JSON.stringify({ tag: { name: args.tagName, tagId: '1' }, trigger: { reused: true } });
  };
  const rows = [
    {
      id: 's1',
      platform: 'ga4_event',
      tagName: 'Contact Form',
      trigger: { name: 'T', kind: 'custom_event' },
      install: { requires: [{ kind: 'listener-tag', tag: { name: 'cHTML - listener', html: '<script></script>', fires: 'all_pages' } }] },
    },
  ] as unknown as SuggestedTagView[];

  const result = await createSelected(execute, { accountId: '1', containerId: '2', workspaceId: '3' }, rows);
  assert.equal(result.listeners[0].ok, false);
  assert.match(result.listeners[0].error ?? '', /quota/);
  assert.equal(result.created, 1, 'the tag is still created');
});

test('the trigger a listener fires on follows the plan', async () => {
  const { listenerTrigger } = await import('../suggestions.js');
  assert.deepEqual(listenerTrigger('all_pages'), { name: 'All Pages', kind: 'pageview' });
  assert.deepEqual(listenerTrigger('dom_ready'), { name: 'DOM Ready', kind: 'dom_ready' });
  assert.deepEqual(listenerTrigger('window_loaded'), { name: 'Window Loaded', kind: 'window_loaded' });
  assert.deepEqual(listenerTrigger('anything else'), { name: 'All Pages', kind: 'pageview' });
});

// ── Ringing the element ──────────────────────────────────────────────────────

test('a site-wide row is proved on the page its element was measured on', async () => {
  // It has no page of its own, which is why it had no picture at all. The scan names the page it
  // measured the element on, so a footer email link can be shown where it was found.
  const store = new ScanStore();
  const scan = store.put('u1', {
    site: 'https://example.com',
    warnings: [],
    pageImages: [{ page: '/contact', image: Buffer.from('jpeg').toString('base64'), bytes: 4 }],
    suggestions: [
      { tagName: 'Email', platform: 'ga4_event', page: 'site-wide', proofPage: '/contact', rect: { x: 40, y: 2967, w: 185, h: 20 } },
      { tagName: 'Social', platform: 'ga4_event', page: 'site-wide' },
    ] as Record<string, unknown>[],
  });
  const rows = toRows(scan.suggestions, scan.images);
  const { imageForRow } = await import('../suggestions.js');

  assert.equal(rows[0].hasImage, true, 'the example page has a screenshot');
  assert.deepEqual(rows[0].rect, { x: 40, y: 2967, w: 185, h: 20 });
  assert.equal(rows[0].proofPage, '/contact', 'the row says which page it is showing');
  assert.ok(imageForRow(scan, rows[0].id), 'and that page resolves to bytes');

  assert.equal(rows[1].hasImage, undefined, 'a site-wide row with no example page still has none');
  assert.equal(imageForRow(scan, rows[1].id), null);
});

test('a row with a picture but no rect keeps the picture', () => {
  // The screenshot still answers "what does this page look like" even when the scan could not pin
  // the tag to one element. Dropping it would lose that for no gain.
  const store = new ScanStore();
  const scan = store.put('u1', {
    site: 'https://example.com',
    warnings: [],
    pageImages: [{ page: '/contact', image: Buffer.from('jpeg').toString('base64'), bytes: 4 }],
    suggestions: [{ tagName: 'Address', platform: 'ga4_event', page: '/contact' }] as Record<string, unknown>[],
  });
  const rows = toRows(scan.suggestions, scan.images);
  assert.equal(rows[0].hasImage, true);
  assert.equal(rows[0].rect, undefined);
});

// Editing a scanned row.
//
// The rule these hold: an edit changes NAMED fields of the server's own copy of a scan. It is not a
// second way to hand this endpoint a tag payload, and it must never produce a row that reports
// success and creates something wrong.

const editable = (over: Record<string, unknown> = {}): SuggestedTagView =>
  ({
    id: 'r1',
    tagName: 'GA4 Event - Contact Form',
    platform: 'ga4_event',
    eventName: 'form_submit',
    trigger: {
      name: 'Contact Form Trigger',
      kind: 'all_clicks',
      clickTextValue: 'Get in touch',
      clickTextOperator: 'equals',
    },
    ...over,
  }) as unknown as SuggestedTagView;

test('renaming a tag, its event and its trigger changes all three', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  const { row, changed, rejected } = applyRowEdit(editable(), {
    tagName: 'GA4 - Contact - Submit',
    eventName: 'generate_lead',
    triggerName: 'Form - Contact - Submit',
  });
  assert.equal(row.tagName, 'GA4 - Contact - Submit');
  assert.equal(row.eventName, 'generate_lead');
  assert.equal(row.trigger.name, 'Form - Contact - Submit');
  assert.equal(changed.length, 3);
  assert.deepEqual(rejected, []);
});

test('an edit does not mutate the row it was given', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  const original = editable();
  applyRowEdit(original, {
    tagName: 'Something else',
    conditions: [{ variable: 'Click Text', value: 'Contact us' }],
  });
  assert.equal(original.tagName, 'GA4 Event - Contact Form', 'the caller keeps its own copy');
  assert.equal((original.trigger as unknown as Record<string, unknown>).clickTextValue, 'Get in touch');
});

test('a GA4 event name GA4 would discard is refused, not saved', async () => {
  // GTM creates a tag with any event name at all. GA4 drops what it cannot parse on receipt, so the
  // tag fires, the container looks right, and the report stays empty. This is the only layer that
  // can say no.
  const { applyRowEdit } = await import('../suggestions.js');
  for (const bad of ['generate lead', '2_leads', 'lead!', 'x'.repeat(41)]) {
    const { row, changed, rejected } = applyRowEdit(editable(), { eventName: bad });
    assert.equal(row.eventName, 'form_submit', `"${bad}" must not be saved`);
    assert.deepEqual(changed, []);
    assert.equal(rejected.length, 1, `"${bad}" must say why`);
  }
});

test('a GA4 reserved prefix is refused', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  const { changed, rejected } = applyRowEdit(editable(), { eventName: 'google_signup' });
  assert.deepEqual(changed, []);
  assert.match(rejected[0], /reserves/);
});

test("a pixel platform keeps its own event naming, not GA4's", async () => {
  // "Lead" and "AddToCart" are the correct Meta event names. Running GA4's rules over every platform
  // would refuse the only names Meta accepts.
  const { applyRowEdit } = await import('../suggestions.js');
  const { row, rejected } = applyRowEdit(editable({ platform: 'meta_pixel', eventName: 'Contact' }), {
    eventName: 'Lead',
  });
  assert.equal(row.eventName, 'Lead');
  assert.deepEqual(rejected, []);
});

test('an empty name is refused rather than saved as a blank tag', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  for (const field of ['tagName', 'triggerName'] as const) {
    const { changed, rejected } = applyRowEdit(editable(), { [field]: '   ' });
    assert.deepEqual(changed, []);
    assert.equal(rejected.length, 1);
  }
});

test('a condition value and operator can both be changed', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  const { row, changed } = applyRowEdit(editable(), {
    conditions: [{ variable: 'Click Text', operator: 'contains', value: 'Get in touch' }],
  });
  const t = row.trigger as unknown as Record<string, unknown>;
  assert.equal(t.clickTextOperator, 'contains');
  assert.equal(t.clickTextValue, 'Get in touch');
  assert.equal(changed.length, 1, 'the value was unchanged, so only the operator is reported');
});

test('clearing a condition is reported as a removal, because that is what it does', async () => {
  // A click trigger with its Click Text scope cleared does not fire less. It fires on every click in
  // the container, and "Click Text -> empty" would not tell anyone that.
  const { applyRowEdit } = await import('../suggestions.js');
  const { row, changed } = applyRowEdit(editable(), { conditions: [{ variable: 'Click Text', value: '' }] });
  assert.equal((row.trigger as unknown as Record<string, unknown>).clickTextValue, '');
  assert.match(changed[0], /removed/);
});

test('a condition the scan never put on the trigger cannot be added', async () => {
  // Adding one would mean the row fires on something no page was checked against, which is a
  // suggestion the scan did not make.
  const { applyRowEdit } = await import('../suggestions.js');
  const { row, changed, rejected } = applyRowEdit(editable(), {
    conditions: [{ variable: 'Page Path', value: '/pricing' }],
  });
  assert.equal((row.trigger as unknown as Record<string, unknown>).pagePathValue, undefined);
  assert.deepEqual(changed, []);
  assert.equal(rejected.length, 1);
});

test('an unknown field and a bogus operator are refused and named', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  const { changed, rejected } = applyRowEdit(editable(), {
    conditions: [
      { variable: 'dlv - form_id', value: 'x' },
      { variable: 'Click Text', operator: 'sortOf' },
    ],
  });
  assert.deepEqual(changed, []);
  assert.equal(rejected.length, 2, 'both are reported, neither is silently dropped');
});

test('cssSelector is offered on Click Element and refused on a text condition', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  const onText = applyRowEdit(editable(), { conditions: [{ variable: 'Click Text', operator: 'cssSelector' }] });
  assert.equal(onText.changed.length, 0);
  assert.equal(onText.rejected.length, 1);

  const onElement = applyRowEdit(
    editable({
      trigger: { name: 'T', kind: 'all_clicks', clickElementValue: '.cta', clickElementOperator: 'equals' },
    }),
    { conditions: [{ variable: 'Click Element', operator: 'cssSelector' }] },
  );
  assert.equal(onElement.changed.length, 1);
});

test('an edited row is marked, and an edit that changed nothing is not', async () => {
  const { applyRowEdit } = await import('../suggestions.js');
  const real = applyRowEdit(editable(), { tagName: 'Renamed' });
  assert.equal(toRows([real.row])[0].edited, true);

  const noop = applyRowEdit(editable(), { tagName: 'GA4 Event - Contact Form' });
  assert.deepEqual(noop.changed, []);
  assert.equal(toRows([noop.row])[0].edited, undefined);
});

test('an edit is written into the store, so the create path sees it without being told', () => {
  const store = new ScanStore();
  const scan = store.put('u1', scanResult(2));
  const id = scan.suggestions[0].id;

  const result = store.editRow('u1', scan.id, id, { tagName: 'Renamed by hand' });
  assert.equal(result?.changed.length, 1);
  assert.equal(store.get('u1', scan.id)?.suggestions[0].tagName, 'Renamed by hand');
  assert.equal(store.get('u1', scan.id)?.suggestions[1].tagName, 'GA4 Event - Tag 2', 'only that row');
});

test('a scan cannot be edited by anyone but the user who ran it', () => {
  const store = new ScanStore();
  const scan = store.put('owner', scanResult(1));
  assert.equal(store.editRow('someone-else', scan.id, scan.suggestions[0].id, { tagName: 'x' }), null);
  assert.equal(store.get('owner', scan.id)?.suggestions[0].tagName, 'GA4 Event - Tag 1', 'untouched');
});

test('editing an unknown row reports nothing found rather than creating one', () => {
  const store = new ScanStore();
  const scan = store.put('u1', scanResult(1));
  assert.equal(store.editRow('u1', scan.id, 'not-a-row', { tagName: 'x' }), null);
  assert.equal(store.get('u1', scan.id)?.suggestions.length, 1);
});

test('conditions the create path cannot carry are named before anything is written', async () => {
  const { droppedConditions } = await import('../suggestions.js');
  const dropped = droppedConditions([
    editable({
      id: 'a',
      tagName: 'Contact',
      trigger: {
        name: 'T',
        kind: 'custom_event',
        eventName: 'form_submission',
        dataLayerConditions: [{ key: 'form_id', value: 'wpcf7-f12', operator: 'equals' }],
      },
    }),
    editable({ id: 'b', tagName: 'Email' }),
  ]);
  assert.equal(dropped.length, 1, 'only the row that loses something');
  assert.equal(dropped[0].id, 'a');
  assert.match(dropped[0].conditions[0], /dlv - form_id/);
});
