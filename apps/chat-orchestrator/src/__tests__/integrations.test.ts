/**
 * Integration tests.
 *
 * The stakes here are not "does a chip render". A chip decides which tools reach the model, so the
 * failures worth locking are: a connected platform leaking its DESTRUCTIVE or ADMIN surface into a
 * chat that was never meant to administer it, junk off the wire widening the tool set, and the
 * ceiling silently evicting the very tools the chip was turned on to provide.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONNECTED_WRITE_ALLOWLIST,
  INTEGRATION_OPTIONS,
  buildIntegrationPrompt,
  connectedWriteAllowed,
  sanitizeIntegrations,
} from '../integrations.js';
import { scopeTools } from '../tools.js';
import type { ToolDef } from '../types.js';

const tool = (name: string, over: Partial<ToolDef> = {}): ToolDef =>
  ({ name, description: '', inputSchema: {}, isWrite: false, isDelete: false, isDestructive: false, ...over }) as ToolDef;

const CATALOGUE: ToolDef[] = [
  tool('tags_list'),
  tool('tags_create', { isWrite: true }),
  tool('tags_delete', { isWrite: true, isDelete: true }),
  tool('workspace_create_version_and_publish', { isWrite: true, isDestructive: true }),
  tool('ga4_properties_list'),
  tool('ga4_data_streams_list'),
  tool('ga4_create_key_event', { isWrite: true }),
  // A GA4 write that is deliberately NOT on the allowlist: property administration.
  tool('ga4_update_data_retention', { isWrite: true }),
  tool('ga4_archive_custom_dimension', { isWrite: true, isDelete: true }),
];

const names = (list: ToolDef[]): string[] => list.map((t) => t.name);

// ── Sanitizing ───────────────────────────────────────────────────────────────

test('only the platforms a product may connect survive the boundary', () => {
  assert.deepEqual(sanitizeIntegrations('gtm', ['ga4']), ['ga4']);
  assert.deepEqual(sanitizeIntegrations('ga4', ['gtm']), ['gtm']);
});

test('junk, duplicates and self-references are dropped, not trusted', () => {
  assert.deepEqual(sanitizeIntegrations('gtm', ['gtm']), [], 'a product cannot connect itself');
  assert.deepEqual(sanitizeIntegrations('gtm', ['ga4', 'ga4']), ['ga4'], 'deduped');
  assert.deepEqual(sanitizeIntegrations('gtm', ['ads', 'nonsense', 42]), [], 'unknown platforms dropped');
  assert.deepEqual(sanitizeIntegrations('gtm', 'ga4'), [], 'a non-array is not a list');
  assert.deepEqual(sanitizeIntegrations('gtm', null), []);
});

test('Google Ads is not offered here, because this server has no Ads tools', () => {
  // The desktop offers it; porting the chip without the tools would promise a workflow that
  // produces "Unknown tool" mid-task.
  assert.ok(!INTEGRATION_OPTIONS.gtm.includes('ads' as never));
  assert.deepEqual(sanitizeIntegrations('gtm', ['ads']), []);
});

// ── What a connected platform may write ──────────────────────────────────────

test('a connected platform grants its workflow, never its admin surface', () => {
  assert.ok(connectedWriteAllowed('ga4', 'ga4_create_key_event'));
  assert.ok(connectedWriteAllowed('gtm', 'tags_create'));
  assert.ok(!connectedWriteAllowed('ga4', 'ga4_update_data_retention'), 'property admin stays in the GA4 chat');
  assert.ok(!connectedWriteAllowed('ga4', 'unknown_tool'));
});

test('every prompt-named tool is on the allowlist or is a read', () => {
  // The bug this locks: the allowlist was ported from the desktop registry, whose tools are named
  // create_ga4_key_event / create_gtm_tracking_tag. Nothing here is called that, so every connected
  // write was silently withheld while the prompt still told the model to call them.
  const prompts = [
    buildIntegrationPrompt('gtm', ['ga4'], true),
    buildIntegrationPrompt('ga4', ['gtm'], true),
  ].join(' ');
  const allowed = new Set([...CONNECTED_WRITE_ALLOWLIST.gtm, ...CONNECTED_WRITE_ALLOWLIST.ga4]);
  // Any write-shaped tool name the prompt instructs the model to call must actually be grantable.
  for (const name of prompts.match(/\b(?:ga4_(?:create|update)_[a-z_]+|tags_[a-z_]+|triggers_[a-z_]+|variables_[a-z_]+)\b/g) ?? []) {
    assert.ok(allowed.has(name), `the prompt names ${name} but no allowlist grants it`);
  }
});

test('no delete or archive appears on any allowlist', () => {
  for (const [platform, list] of Object.entries(CONNECTED_WRITE_ALLOWLIST)) {
    for (const name of list) {
      assert.ok(
        !/(^|_)(delete|remove|archive)(_|$)/i.test(name),
        `${platform} allowlist must not contain the destructive tool ${name}`,
      );
    }
  }
});

// ── Scoping ──────────────────────────────────────────────────────────────────

test('without a chip, a GTM chat sees no GA4 tools at all', () => {
  const scoped = names(scopeTools(CATALOGUE, { product: 'gtm', includeWrites: true }));
  assert.ok(scoped.includes('tags_list'));
  assert.ok(!scoped.includes('ga4_properties_list'), 'opt-in means opt-in');
  assert.ok(!scoped.includes('ga4_create_key_event'));
});

test('with GA4 connected, its reads and allowlisted writes arrive - and nothing else', () => {
  const scoped = names(
    scopeTools(CATALOGUE, { product: 'gtm', includeWrites: true, integrations: ['ga4'] }),
  );
  assert.ok(scoped.includes('ga4_data_streams_list'), 'reads make the workflow automatic');
  assert.ok(scoped.includes('ga4_create_key_event'), 'the allowlisted write arrives');
  assert.ok(!scoped.includes('ga4_update_data_retention'), 'admin write withheld');
  assert.ok(!scoped.includes('ga4_archive_custom_dimension'), 'archive withheld');
  // And the primary product is untouched.
  assert.ok(scoped.includes('tags_create'));
});

test('a connected platform never brings deletes, even with deletes enabled', () => {
  const scoped = names(
    scopeTools(CATALOGUE, {
      product: 'gtm',
      includeWrites: true,
      includeDeletes: true,
      integrations: ['ga4'],
    }),
  );
  assert.ok(scoped.includes('tags_delete'), 'the PRIMARY product still gets its deletes');
  assert.ok(!scoped.includes('ga4_archive_custom_dimension'), 'the connected one does not');
});

test('destructive tools stay withheld regardless of chips', () => {
  const scoped = names(
    scopeTools(CATALOGUE, {
      product: 'gtm',
      includeWrites: true,
      includeDeletes: true,
      integrations: ['ga4'],
    }),
  );
  assert.ok(!scoped.includes('workspace_create_version_and_publish'));
});

test('read-only sessions gain reads from a chip but no writes', () => {
  const scoped = names(
    scopeTools(CATALOGUE, { product: 'gtm', includeWrites: false, integrations: ['ga4'] }),
  );
  assert.ok(scoped.includes('ga4_data_streams_list'));
  assert.ok(!scoped.includes('ga4_create_key_event'), 'a chip cannot grant what the session forbids');
});

test('the ceiling grows with a chip, so turning one on cannot evict what it added', () => {
  const many: ToolDef[] = [
    ...Array.from({ length: 60 }, (_, i) => tool(`tags_list_thing_${String(i).padStart(2, '0')}`)),
    ...Array.from({ length: 30 }, (_, i) => tool(`ga4_thing_list_${String(i).padStart(2, '0')}`)),
  ];
  const withChip = scopeTools(many, { product: 'gtm', includeWrites: false, integrations: ['ga4'] });
  assert.ok(
    withChip.some((t) => t.name.startsWith('ga4_')),
    'GA4 tools must survive the ceiling when GA4 is connected',
  );
});

// ── Prompt ───────────────────────────────────────────────────────────────────

test('no chip means no prompt block, keeping the cached prefix byte-identical', () => {
  assert.equal(buildIntegrationPrompt('gtm', [], true), '');
  assert.equal(buildIntegrationPrompt('gtm', ['ads' as never], true), '', 'a dropped chip adds nothing');
});

test('the GA4 block names the resolution path and refuses invented ids', () => {
  const p = buildIntegrationPrompt('gtm', ['ga4'], true);
  assert.ok(p.includes('ga4_data_streams_list'), 'the tool that resolves the id is named');
  assert.ok(p.includes('Never invent a Measurement ID'));
  assert.ok(p.includes('DRAFT'), 'the reversibility asymmetry is stated');
  assert.ok(p.includes('ga4_create_key_event'));
});

test('without writes the block promises no creates it cannot perform', () => {
  const p = buildIntegrationPrompt('gtm', ['ga4'], false);
  assert.ok(!p.includes('OFFER to register it as a key event'));
  assert.ok(p.includes('GA4 Admin writes are unavailable'));
});

test('the block warns the model off a connected admin surface it does not have', () => {
  const p = buildIntegrationPrompt('ga4', ['gtm'], true);
  assert.ok(p.includes('NOT ') && p.includes('own chat'), 'says where the missing surface lives');
});
