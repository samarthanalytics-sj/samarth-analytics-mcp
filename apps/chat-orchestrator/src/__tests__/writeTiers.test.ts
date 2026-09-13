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
import { classifyWriteSurface, approvalGate, confirmWordFor, describeReversibility } from '../writeTiers.js';

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

const gate = (t: { isDelete: boolean; surface?: string; name?: string }, approveLive = false) =>
  approvalGate(t, approveLive);

/* Ordinary CRUD runs. A confirmation is only worth asking for when it is not routine, and
   prompting on every create spends the attention the one irreversible prompt needs. */
test('a create or update runs without asking, on either product', () => {
  assert.equal(gate({ isDelete: false, surface: 'gtm_draft', name: 'tags_create' }), null);
  assert.equal(gate({ isDelete: false, surface: 'ga4_live', name: 'ga4_create_custom_dimension' }), null);
  assert.equal(gate({ isDelete: false, surface: 'ga4_live', name: 'ga4_update_data_retention' }), null);
  assert.equal(gate({ isDelete: false, surface: 'gtm_live', name: 'containers_create' }), null);
});

test('a delete always stops, whatever product or surface it is on', () => {
  for (const t of [
    { isDelete: true, surface: 'gtm_draft', name: 'tags_delete' },
    { isDelete: true, surface: 'gtm_live', name: 'versions_delete' },
    { isDelete: true, surface: 'ga4_live', name: 'ga4_delete_property' },
  ]) {
    assert.deepEqual(gate(t), { confirmWord: 'DELETE' }, t.name);
  }
});

/* The word has to match the operation. An archive confirmed with the word DELETE both misstates
   what happens and turns the prompt into muscle memory. */
test('an archive asks for ARCHIVE, not DELETE', () => {
  assert.deepEqual(gate({ isDelete: true, surface: 'ga4_live', name: 'ga4_archive_custom_dimension' }), {
    confirmWord: 'ARCHIVE',
  });
  assert.equal(confirmWordFor('ga4_archive_audience'), 'ARCHIVE');
  assert.equal(confirmWordFor('ga4_delete_key_event'), 'DELETE');
  assert.equal(confirmWordFor('tags_delete'), 'DELETE');
  // "archived" inside a longer word is not an archive operation.
  assert.equal(confirmWordFor('list_archived_things'), 'DELETE');
});

test('no configuration can let a removal through silently', () => {
  for (const approveLive of [true, false]) {
    assert.deepEqual(gate({ isDelete: true, surface: 'gtm_draft', name: 'tags_delete' }, approveLive), {
      confirmWord: 'DELETE',
    });
    assert.deepEqual(
      gate({ isDelete: true, surface: 'ga4_live', name: 'ga4_archive_audience' }, approveLive),
      { confirmWord: 'ARCHIVE' },
    );
  }
});

test('the opt-in flag re-adds a card for live creates and updates only', () => {
  assert.deepEqual(gate({ isDelete: false, surface: 'ga4_live', name: 'ga4_create_property' }, true), {});
  assert.deepEqual(gate({ isDelete: false, surface: 'gtm_live', name: 'containers_create' }, true), {});
  // A draft write is unaffected by it.
  assert.equal(gate({ isDelete: false, surface: 'gtm_draft', name: 'tags_create' }, true), null);
});

test('a write with no surface is still treated as live under the strict flag', () => {
  assert.deepEqual(gate({ isDelete: false, surface: undefined, name: 'mystery_create' }, true), {});
});

console.log('the card tells the truth about undo');

test('an archive is described as permanent, not as a draft or a trash', () => {
  const text = describeReversibility('ga4_live', true, 'ga4_archive_custom_dimension');
  assert.match(text, /permanent/i);
  assert.match(text, /no un-archive/i);
  assert.equal(/draft/i.test(text), false);
});

test('a GA4 delete is not described as landing in a draft workspace', () => {
  const text = describeReversibility('ga4_live', true, 'ga4_delete_property');
  assert.equal(/draft workspace/i.test(text), false);
  assert.match(text, /GA4 has no draft/i);
});

test('a GTM draft write is still described as discardable', () => {
  const text = describeReversibility('gtm_draft', false, 'tags_create');
  assert.match(text, /draft workspace/i);
  assert.match(text, /not published/i);
});

console.log(`
${passed} write-tier test(s) passed`);
