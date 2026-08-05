/**
 * System prompt assembly tests. Guards the properties that make the prompt safe and cacheable.
 */
import assert from 'node:assert/strict';
import { buildSituationalContext, buildStaticSystem } from '../prompts.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('static system prompt');

test('gtm prompt carries the shared measurement methodology', () => {
  const sys = buildStaticSystem({ product: 'gtm', canWrite: false, mcpInstructions: '' });
  assert.match(sys, /GA4 EVENT SELECTION/);
  assert.match(sys, /GTM DECISION RULES/);
});

test('read-only mode says so and does not promise writes', () => {
  const sys = buildStaticSystem({ product: 'gtm', canWrite: false, mcpInstructions: '' });
  assert.match(sys, /READ-ONLY/);
  assert.equal(/WRITES REQUIRE APPROVAL/.test(sys), false);
});

test('write mode requires approval and forbids publishing', () => {
  const sys = buildStaticSystem({ product: 'gtm', canWrite: true, mcpInstructions: '' });
  assert.match(sys, /WRITES REQUIRE APPROVAL/);
  assert.match(sys, /draft workspace/);
  assert.match(sys, /Never attempt to publish/);
});

test('anti-fabrication rules are always present', () => {
  for (const product of ['gtm', 'ga4'] as const) {
    const sys = buildStaticSystem({ product, canWrite: false, mcpInstructions: '' });
    assert.match(sys, /NEVER invent an id/);
    assert.match(sys, /TRUNCATED/);
    assert.match(sys, /Do not describe a failed action as done/);
  }
});

test('the model is told it may only call tools it actually has', () => {
  const sys = buildStaticSystem({ product: 'gtm', canWrite: false, mcpInstructions: '' });
  assert.match(sys, /Only call tools that appear in your tool list/);
});

test('server instructions are marked authoritative when present', () => {
  const sys = buildStaticSystem({
    product: 'gtm',
    canWrite: false,
    mcpInstructions: 'Current mode: READ-ONLY',
  });
  assert.match(sys, /SERVER CAPABILITIES \(authoritative/);
  assert.match(sys, /Current mode: READ-ONLY/);
});

test('ga4 prompt warns about unfinished data days', () => {
  const sys = buildStaticSystem({ product: 'ga4', canWrite: false, mcpInstructions: '' });
  assert.match(sys, /24 to 48 hours/);
});

test('house style bans em dashes', () => {
  const sys = buildStaticSystem({ product: 'gtm', canWrite: false, mcpInstructions: '' });
  assert.match(sys, /Do not use em dashes/);
});

console.log('situational context');

test('selected ids are passed through for direct use', () => {
  const ctx = buildSituationalContext(
    { product: 'gtm', accountId: '123', containerId: '456', workspaceId: '7' },
    { email: 'a@b.com' },
  );
  assert.match(ctx, /accountId 123/);
  assert.match(ctx, /containerId 456/);
  assert.match(ctx, /workspaceId 7/);
  assert.match(ctx, /a@b\.com/);
});

test('with nothing selected the model is told to ask, not guess', () => {
  const ctx = buildSituationalContext({ product: 'gtm' }, {});
  assert.match(ctx, /has NOT selected/);
  assert.match(ctx, /rather than guessing/);
});

test('static prompt is stable across users so the cache prefix holds', () => {
  const a = buildStaticSystem({ product: 'gtm', canWrite: false, mcpInstructions: 'x' });
  const b = buildStaticSystem({ product: 'gtm', canWrite: false, mcpInstructions: 'x' });
  assert.equal(a, b);
  // The volatile half must differ per user, which is exactly why it is a separate message.
  assert.notEqual(
    buildSituationalContext({ product: 'gtm' }, { email: 'one@x.com' }),
    buildSituationalContext({ product: 'gtm' }, { email: 'two@x.com' }),
  );
});

console.log(`\n${passed} assertions passed`);
