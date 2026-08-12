/**
 * Progressive-disclosure tests.
 *
 * The fixture is the REAL inventory of this MCP server (178 tools, dumped from a live connection),
 * so these assertions are about the actual product rather than a hand-written sample that agrees
 * with the classifier by construction.
 *
 * The failure this suite exists to prevent: a tool the model can never see and never learn about,
 * which presents to the user as "the assistant says it cannot do that" for a capability that
 * shipped months ago.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ENABLE_TOOL_GROUP,
  GROUP_SUMMARIES,
  REQUESTABLE_GROUPS,
  availableGroups,
  buildToolGroupPrompt,
  describeRevealedGroup,
  enableToolGroupDef,
  filterToolsByGroup,
  groupCounts,
  groupOf,
  selectToolGroups,
} from '../tool-groups.js';
import type { ToolDef } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(join(here, 'real-tool-inventory.json'), 'utf8')) as {
  n: string;
  w: boolean;
  d: boolean;
  x: boolean;
}[];

/** The real inventory, in the shape the orchestrator uses. */
const ALL: ToolDef[] = RAW.map(
  (t) => ({ name: t.n, description: '', inputSchema: {}, isWrite: t.w, isDelete: t.d, isDestructive: t.x }) as ToolDef,
);

// ── The classification cannot rot ────────────────────────────────────────────

test('the fixture is the real server inventory, not a sample', () => {
  assert.equal(ALL.length, 179, 'refresh the fixture if the server tool count changed');
});

test('every real tool is classified: nothing falls through to always-sent', () => {
  // Unclassified is FAIL-OPEN at runtime by design, which is safe but silently restores the
  // original cost. This is the fail-loud half of that bargain.
  const unclassified = ALL.filter((t) => groupOf(t.name) === undefined).map((t) => t.name);
  assert.deepEqual(unclassified, [], `unclassified tools would always be sent: ${unclassified.join(', ')}`);
});

test('an unknown future tool still reaches the model rather than disappearing', () => {
  assert.equal(groupOf('some_tool_added_next_year'), undefined);
  const withNew = [...ALL, { name: 'some_tool_added_next_year' } as ToolDef];
  const sent = filterToolsByGroup(withNew, new Set(['core']));
  assert.ok(sent.some((t) => t.name === 'some_tool_added_next_year'), 'fail-open must hold');
});

// ── Core stays small, and is enough to answer a question ─────────────────────

test('core is small and contains no writes', () => {
  const core = ALL.filter((t) => groupOf(t.name) === 'core');
  assert.ok(core.length <= 25, `core is ${core.length} tools; it is meant to be minimal`);
  const writes = core.filter((t) => t.isWrite).map((t) => t.name);
  assert.deepEqual(writes, [], 'a question-only chat must not pay for the write surface');
});

test('core can resolve the ids every other tool needs', () => {
  const core = new Set(ALL.filter((t) => groupOf(t.name) === 'core').map((t) => t.name));
  for (const needed of ['accounts_list', 'containers_list', 'workspaces_list', 'tags_list']) {
    assert.ok(core.has(needed), `${needed} must be in core or nothing else can be addressed`);
  }
});

// ── The saving is real ───────────────────────────────────────────────────────

test('a plain question sends a fraction of the full surface', () => {
  const selected = selectToolGroups({ messages: ['what is in my container right now?'] });
  const sent = filterToolsByGroup(ALL, selected);
  assert.ok(sent.length < ALL.length / 3, `sent ${sent.length} of ${ALL.length}; expected far fewer`);
});

test('every group is reachable by at least one plausible phrasing', () => {
  // A group nothing can select is a group the model must always ask for by name, which is a worse
  // experience than it looks: the model has to guess the group exists at all.
  const phrases: Record<string, string> = {
    'gtm-write': 'create a purchase tag',
    'gtm-admin': 'publish the workspace',
    'server-side': 'set up a server-side client',
    'ga4-read': 'which key events are configured in GA4?',
    'ga4-write': 'add a custom dimension in GA4',
    audit: 'audit this container',
  };
  for (const group of REQUESTABLE_GROUPS) {
    const selected = selectToolGroups({ messages: [phrases[group]] });
    assert.ok(selected.has(group), `"${phrases[group]}" should select ${group}`);
  }
});

// ── Nothing is lost, only deferred ───────────────────────────────────────────

test('a keyword miss costs a round trip, never the capability', () => {
  // Deliberately oblique wording that matches no write keyword.
  const selected = selectToolGroups({ messages: ['zzz'] });
  const sent = filterToolsByGroup(ALL, selected);
  assert.ok(!sent.some((t) => t.name === 'tags_create'), 'the write is indeed hidden');

  // ...but the gate advertises it, and enabling reveals it.
  const gate = enableToolGroupDef(availableGroups(ALL), groupCounts(ALL));
  assert.ok(gate.description.includes('gtm-write'), 'the gate names the group that holds it');
  const after = filterToolsByGroup(ALL, selectToolGroups({ messages: ['zzz'], enabled: ['gtm-write'] }));
  assert.ok(after.some((t) => t.name === 'tags_create'), 'enabling reveals it');
});

test('the gate refuses to invent a group it cannot reveal', () => {
  const onlyCore = ALL.filter((t) => groupOf(t.name) === 'core');
  const gate = enableToolGroupDef(availableGroups(onlyCore), groupCounts(onlyCore));
  const schema = gate.inputSchema as { properties: { group: { enum?: string[] } } };
  assert.equal(schema.properties.group.enum, undefined, 'an empty enum is invalid schema');
});

test('the gate offers only groups this chat actually has', () => {
  const ga4Only = ALL.filter((t) => t.name.startsWith('ga4_'));
  const available = availableGroups(ga4Only);
  assert.ok(!available.includes('server-side'), 'a GA4 chat must not be offered sGTM');
  assert.ok(available.includes('ga4-read') || available.includes('ga4-write'));
});

// ── Integrations compose with disclosure ─────────────────────────────────────

test('a connected platform brings its reads in without waiting for a keyword', () => {
  // The chip IS the request; making the user also say "GA4" would be asking twice.
  const selected = selectToolGroups({ messages: ['zzz'], integrations: ['ga4'] });
  assert.ok(selected.has('ga4-read'));
});

// ── The prompt tells the truth about the list ────────────────────────────────

test('the prompt says the list is partial and forbids claiming a capability is absent', () => {
  const p = buildToolGroupPrompt(availableGroups(ALL));
  assert.ok(p.includes('SUBSET'));
  assert.ok(p.includes('NEVER tell the user a capability does not exist'));
  assert.ok(p.includes(ENABLE_TOOL_GROUP));
});

test('no prompt at all when there is nothing hidden', () => {
  assert.equal(buildToolGroupPrompt([]), '');
});

test('revealing an empty group says so instead of implying success', () => {
  const text = describeRevealedGroup('ga4-write', []);
  assert.ok(text.includes('Do not claim the capability exists'));
});

test('every group has a summary, so the menu is never blank', () => {
  for (const g of REQUESTABLE_GROUPS) {
    assert.ok(GROUP_SUMMARIES[g] && GROUP_SUMMARIES[g].length > 20, `${g} needs a real summary`);
  }
});

// ── A GA4 read must not unlock the GA4 Admin write surface ───────────────────
//
// The measured failure. `ga4-write` was selected by nouns (ga4, analytics, key event, audience,
// custom dimension, retention, data stream), which are the words every GA4 question is built from,
// so it was on from the first message. Since the whole history is scanned, it then stayed on. That
// is 68 tools and ~16,190 of the ~19,282 tokens of GA4 schemas, resent every round trip against an
// account capped at 30,000 tokens per minute: "audit this property" answered "OpenAI rate limit
// reached" and could never do anything else.

test('read-only GA4 questions leave the 68 Admin write tools hidden', () => {
  const reads = [
    'Which key events are configured on this property?',
    'audit this property',
    'what custom dimensions and metrics exist?',
    'is enhanced measurement on, and what is it collecting?',
    'show me sessions by channel for the last 28 days',
    'which data streams does this property have?',
    'what is the data retention setting?',
    'list the audiences on this property',
  ];
  for (const text of reads) {
    const selected = selectToolGroups({ messages: [text] });
    assert.equal(selected.has('ga4-write'), false, `"${text}" is a read and must not unlock GA4 writes`);
  }
});

test('an actual GA4 change request still selects the write group', () => {
  const writes = [
    'add a custom dimension in GA4',
    'create a key event called signup',
    'update the data retention to 14 months',
    'archive that audience',
    'turn off enhanced measurement',
    'rename the data stream',
    'delete the custom metric',
    'enable enhanced measurement',
  ];
  for (const text of writes) {
    const selected = selectToolGroups({ messages: [text] });
    assert.ok(selected.has('ga4-write'), `"${text}" asks for a change and must select ga4-write`);
  }
});

test('the read that used to unlock writes still reaches the GA4 read tools', () => {
  // Narrowing must not cost the capability the question actually needs.
  const selected = selectToolGroups({ messages: ['Which key events are configured on this property?'] });
  assert.ok(selected.has('ga4-read'), 'a GA4 read question still needs the GA4 read group');
});
