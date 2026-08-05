/**
 * Tool scoping and truncation tests. No network, no credentials.
 */
import assert from 'node:assert/strict';
import { capToolResult, productOf, scopeTools, toOpenAiTools } from '../tools.js';
import type { ToolDef } from '../types.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function tool(name: string, isWrite = false): ToolDef {
  return {
    name,
    description: `description for ${name}`,
    inputSchema: { type: 'object', properties: isWrite ? { confirm: { type: 'boolean' } } : {} },
    isWrite,
  };
}

const CATALOG: ToolDef[] = [
  tool('accounts_list'),
  tool('containers_list'),
  tool('containers_lookup'),
  tool('tags_list'),
  tool('tags_get'),
  tool('tags_create', true),
  tool('tags_delete', true),
  tool('audit_container'),
  tool('ga4_properties_list'),
  tool('ga4_run_report'),
  tool('ga4_create_property', true),
];

console.log('tool scoping');

test('ga4_ prefix decides the product', () => {
  assert.equal(productOf('ga4_run_report'), 'ga4');
  assert.equal(productOf('tags_list'), 'gtm');
  assert.equal(productOf('audit_container'), 'gtm');
});

test('read-only scoping hides every confirm-gated tool', () => {
  const scoped = scopeTools(CATALOG, { product: 'gtm', includeWrites: false });
  assert.ok(scoped.length > 0);
  assert.equal(
    scoped.some((t) => t.isWrite),
    false,
    'a write tool leaked into a read-only scope',
  );
});

test('gtm scope excludes ga4 tools and vice versa', () => {
  const gtm = scopeTools(CATALOG, { product: 'gtm', includeWrites: true }).map((t) => t.name);
  assert.ok(gtm.includes('tags_list'));
  assert.equal(gtm.includes('ga4_run_report'), false);

  const ga4 = scopeTools(CATALOG, { product: 'ga4', includeWrites: true }).map((t) => t.name);
  assert.ok(ga4.includes('ga4_run_report'));
  assert.equal(ga4.includes('tags_list'), false);
});

test('account and container discovery stays available in the ga4 scope', () => {
  const ga4 = scopeTools(CATALOG, { product: 'ga4', includeWrites: false }).map((t) => t.name);
  assert.ok(ga4.includes('accounts_list'), 'GA4 chats still need to resolve the account');
  assert.ok(ga4.includes('containers_list'));
});

test('maxTools truncation drops writes before reads', () => {
  const scoped = scopeTools(CATALOG, { product: 'gtm', includeWrites: true, maxTools: 3 });
  assert.equal(scoped.length, 3);
  assert.equal(
    scoped.some((t) => t.isWrite),
    false,
    'truncation kept a write tool while dropping reads',
  );
});

console.log('openai mapping');

test('schemas are normalized to a valid function-calling shape', () => {
  const mapped = toOpenAiTools([
    { name: 'x', description: 'd', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#' }, isWrite: false },
  ]);
  assert.equal(mapped[0].function.parameters.type, 'object');
  assert.deepEqual(mapped[0].function.parameters.properties, {});
  assert.equal('$schema' in mapped[0].function.parameters, false);
});

test('descriptions are bounded', () => {
  const mapped = toOpenAiTools([
    { name: 'x', description: 'a'.repeat(5000), inputSchema: {}, isWrite: false },
  ]);
  assert.ok(mapped[0].function.description.length <= 1024);
});

console.log('truncation');

test('short results pass through untouched', () => {
  assert.equal(capToolResult('hello', 100), 'hello');
});

test('long results are marked INCOMPLETE, never silently cut', () => {
  const capped = capToolResult('x'.repeat(500), 100);
  assert.ok(capped.startsWith('x'.repeat(100)));
  assert.match(capped, /TRUNCATED/);
  assert.match(capped, /INCOMPLETE/);
});

console.log(`\n${passed} assertions passed`);
