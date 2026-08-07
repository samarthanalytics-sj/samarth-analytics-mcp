/**
 * Audit fix-planning tests.
 *
 * This module decides what a "Fix" button does to somebody's container, so the assertions weight
 * the refusals as heavily as the fixes. A wrong refusal costs a click. A wrong fix costs a change
 * nobody asked for, in a container that may belong to a client.
 */
import assert from 'node:assert/strict';
import { builtInVariableType, planFix, FIXABLE_CATEGORIES, type AuditFinding } from '../audit-fix.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const WS = { accountId: '6000', containerId: '111', workspaceId: '3' };
const finding = (over: Partial<AuditFinding>): AuditFinding => ({
  severity: 'warning',
  category: 'paused_tag',
  entityType: 'tag',
  entityId: '42',
  entityName: 'Purchase',
  message: '',
  ...over,
});

console.log('fixes that are offered');

test('a paused tag is unpaused, and nothing else is touched', () => {
  const plan = planFix(finding({ category: 'paused_tag' }), WS);
  assert.equal(plan.fixable, true);
  assert.ok(plan.fixable);
  assert.equal(plan.tool, 'tags_update');
  // tags_update merges by key, so sending ONLY paused preserves the rest of the tag. Sending a
  // fuller object would blank whatever was omitted.
  assert.deepEqual(plan.args, { ...WS, tagId: '42', paused: false });
  assert.equal(plan.destructive, false);
});

test('a missing built-in variable is enabled by type', () => {
  const plan = planFix(
    finding({
      category: 'missing_builtin_variable',
      entityId: '111',
      entityName: 'Container',
      message: 'Built-in variable "pagePath" is not enabled. It is commonly used with GA4.',
    }),
    WS,
  );
  assert.ok(plan.fixable);
  assert.equal(plan.tool, 'built_in_variables_enable');
  assert.deepEqual(plan.args, { ...WS, types: ['pagePath'] });
});

test('removals are marked destructive and demand the typed word', () => {
  for (const [category, tool, idKey] of [
    ['empty_folder', 'folders_delete', 'folderId'],
    ['unused_trigger', 'triggers_delete', 'triggerId'],
  ] as const) {
    const plan = planFix(finding({ category, entityId: '9' }), WS);
    assert.ok(plan.fixable, category);
    assert.equal(plan.tool, tool);
    assert.equal(plan.destructive, true, category);
    assert.equal(plan.confirmWord, 'DELETE', category);
    assert.equal((plan.args as Record<string, unknown>)[idKey], '9');
  }
});

console.log('refusals, which matter more than the fixes');

test('the four judgement categories are refused with a reason', () => {
  for (const category of ['duplicate_name', 'missing_trigger', 'broken_reference', 'broad_trigger']) {
    const plan = planFix(finding({ category }), WS);
    assert.equal(plan.fixable, false, category);
    assert.ok(!plan.fixable && plan.reason.length > 20, `${category} needs a real reason`);
  }
});

test('an unknown category is refused rather than guessed at', () => {
  const plan = planFix(finding({ category: 'something_new_upstream' }), WS);
  assert.equal(plan.fixable, false);
  assert.ok(!plan.fixable && /something_new_upstream/.test(plan.reason));
});

test('a fixable category with no entity id is refused, not sent with an empty id', () => {
  // An empty id would delete or update whatever the API resolves that to. Refuse instead.
  for (const category of ['paused_tag', 'empty_folder', 'unused_trigger']) {
    const plan = planFix(finding({ category, entityId: '' }), WS);
    assert.equal(plan.fixable, false, category);
  }
});

console.log('recovering the variable type from prose');

test('the exact sentence yields the type', () => {
  assert.equal(builtInVariableType('Built-in variable "event" is not enabled. Blah.'), 'event');
  assert.equal(builtInVariableType('Built-in variable "pageHostname" is not enabled.'), 'pageHostname');
});

test('anything else yields null, and the finding is then refused', () => {
  // The type is only in the message. A loose match could enable the wrong variable, so the pattern
  // is anchored and anything unexpected fails closed.
  for (const message of [
    'A tag references "event" which does not exist',
    'built-in variable "event" is not enabled',       // lowercase b, not the audit's wording
    'Built-in variable event is not enabled.',        // unquoted
    'Built-in variable "" is not enabled.',           // empty
    'Some other finding entirely',
    '',
  ]) {
    assert.equal(builtInVariableType(message), null, JSON.stringify(message));
  }

  const plan = planFix(
    finding({ category: 'missing_builtin_variable', message: 'Reworded upstream, no quotes' }),
    WS,
  );
  assert.equal(plan.fixable, false);
});

console.log('the advertised list matches the implementation');

test('every advertised category actually plans a fix, and no other does', () => {
  for (const category of FIXABLE_CATEGORIES) {
    const message =
      category === 'missing_builtin_variable' ? 'Built-in variable "event" is not enabled.' : '';
    assert.ok(planFix(finding({ category, message }), WS).fixable, `${category} should be fixable`);
  }
  for (const category of ['duplicate_name', 'missing_trigger', 'broken_reference', 'broad_trigger']) {
    assert.equal(
      FIXABLE_CATEGORIES.includes(category as never),
      false,
      `${category} must not be advertised as fixable`,
    );
  }
});

console.log(`\n${passed} audit-fix test(s) passed`);
