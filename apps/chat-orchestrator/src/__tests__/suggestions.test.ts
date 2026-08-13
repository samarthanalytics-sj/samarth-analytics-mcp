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

test('no measurement id means the field is left for the container to resolve', () => {
  // Defaulting to a placeholder here would produce a tag that looks created and reports nowhere.
  const list = [{ id: 's1', tagName: 'T', platform: 'ga4_event' }] as unknown as SuggestedTagView[];
  assert.equal(withMeasurementId(list, '')[0].measurementId, undefined);
  assert.equal(withMeasurementId(list, undefined)[0].measurementId, undefined);
  assert.equal(withMeasurementId(list, ' G-ABC123 ')[0].measurementId, 'G-ABC123');
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
