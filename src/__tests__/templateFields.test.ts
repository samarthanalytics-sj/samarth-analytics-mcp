/**
 * Discovering how to build an undocumented tag type.
 *
 * Both halves must fail LOUDLY rather than plausibly. A parser that returns [] for a template it
 * could not read, or a profiler that reports an optional key as required, hands back something that
 * looks like a schema and is not, and the tag built from it is accepted by GTM and renders blank.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseTemplateParameters, summariseTagTypes } from '../tools/templateFields.js';

const TPL = `___INFO___

{
  "displayName": "Example Pixel"
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "pixelId",
    "displayName": "Pixel ID",
    "simpleValueType": true,
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "SELECT",
    "name": "eventName",
    "displayName": "Event",
    "selectItems": [
      {"value": "PageView", "displayValue": "Page View"},
      {"value": "Purchase", "displayValue": "Purchase"}
    ]
  },
  {
    "type": "SIMPLE_TABLE",
    "name": "customData",
    "subParams": [{"name": "key"}, {"name": "value"}]
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const log = require('logToConsole');
`;

test('fields are read from the template source, with names, types and labels', () => {
  const fields = parseTemplateParameters(TPL);
  assert.ok(fields);
  assert.deepEqual(fields!.map(f => f.name), ['pixelId', 'eventName', 'customData']);
  assert.equal(fields![0].type, 'TEXT');
  assert.equal(fields![0].displayName, 'Pixel ID');
});

test('a NON_EMPTY validator is reported as required, and nothing else is', () => {
  const fields = parseTemplateParameters(TPL)!;
  assert.equal(fields.find(f => f.name === 'pixelId')!.required, true);
  // eventName has no validator; claiming it is required would block a valid tag.
  assert.equal(fields.find(f => f.name === 'eventName')!.required, undefined);
});

test('select options and table sub-fields are carried through', () => {
  const fields = parseTemplateParameters(TPL)!;
  assert.deepEqual(fields.find(f => f.name === 'eventName')!.options, ['PageView', 'Purchase']);
  assert.deepEqual(fields.find(f => f.name === 'customData')!.subFields, ['key', 'value']);
});

test('the parameters block is found even as the last section in the file', () => {
  const tail = `___INFO___\n\n{}\n\n___TEMPLATE_PARAMETERS___\n\n[{"type":"TEXT","name":"only"}]\n`;
  assert.deepEqual(parseTemplateParameters(tail)!.map(f => f.name), ['only']);
});

test('trailing commas are tolerated, since real templates carry them', () => {
  const messy = `___TEMPLATE_PARAMETERS___\n\n[{"type":"TEXT","name":"a"},]\n\n___WEB_PERMISSIONS___\n`;
  assert.deepEqual(parseTemplateParameters(messy)!.map(f => f.name), ['a']);
});

test('an unreadable template returns null, never an empty field list', () => {
  // null means "could not read"; [] would mean "this template takes no fields", and a caller
  // acting on the second would build an empty tag and think it was correct.
  assert.equal(parseTemplateParameters('no sections here'), null);
  assert.equal(parseTemplateParameters('___TEMPLATE_PARAMETERS___\n\nnot json at all\n'), null);
  assert.equal(parseTemplateParameters(''), null);
  assert.equal(parseTemplateParameters('___TEMPLATE_PARAMETERS___\n\n{"not":"an array"}\n'), null);
});

test('nameless field descriptors are skipped rather than emitted blank', () => {
  const odd = `___TEMPLATE_PARAMETERS___\n\n[{"type":"LABEL"},{"type":"TEXT","name":"real"}]\n`;
  assert.deepEqual(parseTemplateParameters(odd)!.map(f => f.name), ['real']);
});

test('GROUP children are reported as the fields, because that is what GTM stores', () => {
  // A GROUP is only a visual container: real containers store its children as top-level keys in a
  // tag's `parameter` array and never the group's own name. Reporting the group as a field sent
  // callers to a key GTM ignores, and hid the child the template actually requires. Groups nest,
  // so the walk has to go all the way down.
  const grouped = `___TEMPLATE_PARAMETERS___

[
  {"type": "TEXT", "name": "pixelId"},
  {
    "type": "GROUP",
    "name": "advancedSettings",
    "displayName": "Advanced",
    "subParams": [
      {"type": "TEXT", "name": "currency", "valueValidators": [{"type": "NON_EMPTY"}]},
      {"type": "GROUP", "name": "consentGroup", "subParams": [{"type": "CHECKBOX", "name": "waitForUpdate"}]}
    ]
  }
]
`;
  const fields = parseTemplateParameters(grouped)!;
  assert.deepEqual(fields.map(f => f.name), ['pixelId', 'currency', 'waitForUpdate']);
  assert.ok(!fields.some(f => f.type === 'GROUP'), 'a group is not a parameter key');
  // The NON_EMPTY validator lives on a child, so required must survive the hoist.
  assert.equal(fields.find(f => f.name === 'currency')!.required, true);
  assert.equal(fields.find(f => f.name === 'currency')!.type, 'TEXT');
  // The children are real fields, not columns of the group.
  assert.equal(fields.find(f => f.name === 'waitForUpdate')!.subFields, undefined);
});

// ── profiling what a container already runs ────────────────────────────────

const TAGS = [
  { type: 'crto', name: 'Criteo Home', parameter: [{ key: 'accountId' }, { key: 'pageType' }] },
  { type: 'crto', name: 'Criteo Product', parameter: [{ key: 'accountId' }, { key: 'pageType' }, { key: 'productId' }] },
  { type: 'html', name: 'Legacy snippet', parameter: [{ key: 'html' }] },
  { type: 'crto', name: 'Criteo Basket', parameter: [{ key: 'accountId' }] },
];

test('tags are grouped by type, most used first', () => {
  const p = summariseTagTypes(TAGS);
  assert.equal(p[0].type, 'crto');
  assert.equal(p[0].count, 3);
  assert.equal(p[1].type, 'html');
});

test('alwaysPresent separates the required-looking keys from the optional ones', () => {
  const crto = summariseTagTypes(TAGS)[0];
  // On all three Criteo tags, so it cannot be optional.
  assert.deepEqual(crto.alwaysPresent, ['accountId']);
  // Seen, but not on every tag, so it must not be reported as required.
  assert.ok(crto.parameterKeys.includes('productId'));
  assert.ok(!crto.alwaysPresent.includes('productId'));
  assert.ok(!crto.alwaysPresent.includes('pageType'));
});

test('an example tag name is carried so a human can go look at it', () => {
  assert.equal(summariseTagTypes(TAGS)[0].exampleTagName, 'Criteo Home');
});

test('malformed tags do not break the profile', () => {
  const rough = [
    { type: 'x', name: 'no params' },
    { type: '', name: 'no type', parameter: [{ key: 'a' }] },
    // A single parameter can arrive as an object rather than an array.
    { type: 'x', name: 'object param', parameter: { key: 'solo' } },
    { type: 'x', name: 'junk keys', parameter: [{ notAKey: 1 }] },
  ];
  const p = summariseTagTypes(rough as never);
  assert.equal(p.length, 1, 'the empty type must be dropped, not counted');
  assert.equal(p[0].count, 3);
  assert.deepEqual(p[0].parameterKeys, ['solo']);
  // Present on 1 of 3, so not always present.
  assert.deepEqual(p[0].alwaysPresent, []);
});

test('a duplicated key on one tag is counted once, not twice', () => {
  // Otherwise a repeated key could exceed the tag count and never look "always present".
  const dup = [{ type: 'y', name: 't', parameter: [{ key: 'k' }, { key: 'k' }] }];
  const p = summariseTagTypes(dup);
  assert.deepEqual(p[0].alwaysPresent, ['k']);
});
