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
