/**
 * Write tiering tests.
 *
 * Two questions decide whether write access is safe to expose at all, and both are answered here
 * rather than in prose:
 *
 *   1. Does a write stop for the user when it needs to, and run without asking when it does not?
 *   2. Is the user told the truth about whether it can be undone?
 *
 * The second is the one that bit. Every write used to be described to the user as landing in a draft
 * workspace. That is true of a tag and false of a GA4 property setting, a container merge, and a
 * permission grant, none of which have a draft to discard.
 */
import assert from 'node:assert/strict';
import { classifyWriteSurface, approvalGate } from '../writeTiers.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const WS = { workspaceId: {}, confirm: {} };
const NO_WS = { containerId: {}, confirm: {} };

console.log('surface is read off the schema, not a name list');

test('a workspace-scoped GTM tool is a draft', () => {
  assert.equal(classifyWriteSurface('tags_create', WS), 'gtm_draft');
  assert.equal(classifyWriteSurface('triggers_update', WS), 'gtm_draft');
  assert.equal(classifyWriteSurface('variables_delete', WS), 'gtm_draft');
});

test('a GTM tool with no workspace is live', () => {
  for (const name of [
    'containers_create',
    'containers_combine',
    'versions_delete',
    'environments_update',
    'user_permissions_create',
  ]) {
    assert.equal(classifyWriteSurface(name, NO_WS), 'gtm_live', name);
  }
});

test('every GA4 write is live, even one that happens to carry a workspaceId', () => {
  assert.equal(classifyWriteSurface('ga4_create_custom_dimension', NO_WS), 'ga4_live');
  // GA4 has no workspace concept, so if the key ever appears it must not be read as a draft.
  assert.equal(classifyWriteSurface('ga4_update_property', WS), 'ga4_live');
});

test('a tool invented tomorrow is classified without being added to a list', () => {
  assert.equal(classifyWriteSurface('zones_create', WS), 'gtm_draft');
  assert.equal(classifyWriteSurface('ga4_create_whatever_comes_next', {}), 'ga4_live');
  // Unknown and not workspace-scoped defaults to live, which is the cautious direction: it asks.
  assert.equal(classifyWriteSurface('some_new_account_tool', {}), 'gtm_live');
});

console.log('who stops, and how hard');

const gate = (t: { isDelete: boolean; surface?: string }, approveLive = true) =>
  approvalGate(t, approveLive);

test('a tag create runs without asking', () => {
  assert.equal(gate({ isDelete: false, surface: 'gtm_draft' }), null);
});

test('a delete always demands the typed word', () => {
  assert.deepEqual(gate({ isDelete: true, surface: 'gtm_draft' }), { confirmWord: 'DELETE' });
  assert.deepEqual(gate({ isDelete: true, surface: 'gtm_live' }), { confirmWord: 'DELETE' });
});

test('a delete is still gated when live approvals are switched off', () => {
  // The opt-out relaxes live writes only. It must never reach deletes.
  assert.deepEqual(gate({ isDelete: true, surface: 'gtm_draft' }, false), { confirmWord: 'DELETE' });
  assert.deepEqual(gate({ isDelete: true, surface: 'ga4_live' }, false), { confirmWord: 'DELETE' });
});

test('a live write asks, without a typed word', () => {
  assert.deepEqual(gate({ isDelete: false, surface: 'ga4_live' }), {});
  assert.deepEqual(gate({ isDelete: false, surface: 'gtm_live' }), {});
});

test('the opt-out lets live writes through', () => {
  assert.equal(gate({ isDelete: false, surface: 'ga4_live' }, false), null);
  assert.equal(gate({ isDelete: false, surface: 'gtm_live' }, false), null);
});

test('a write with no surface is treated as live, not as a draft', () => {
  // Defaulting the unknown case to "draft" would describe it to the user as reversible.
  assert.deepEqual(gate({ isDelete: false, surface: undefined }), {});
});

console.log(`\n${passed} write-tier test(s) passed`);
