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
  assert.equal(/YOU CAN CREATE, READ, UPDATE AND DELETE/.test(sys), false);
});

/**
 * The model has to be told which tier a call falls into, because it changes what it should say
 * before making it. Told a create needs approval, it narrates a pending change that already
 * happened; told nothing is gated, it promises a delete it cannot complete on its own.
 */
test('write mode states the CRUD model and forbids publishing', () => {
  const sys = buildStaticSystem({ product: 'gtm', canWrite: true, mcpInstructions: '' });
  assert.match(sys, /YOU CAN CREATE, READ, UPDATE AND DELETE/);
  // Creates and updates run, and the model must not pretend to be waiting on anyone.
  assert.match(sys, /APPLY IMMEDIATELY/);
  assert.match(sys, /Do not ask for permission first/);
  // Removals stop, and the model cannot finish one itself.
  assert.match(sys, /DELETE and ARCHIVE are stopped/);
  assert.match(sys, /You cannot\s+complete one yourself|cannot complete one yourself/);
  assert.match(sys, /never attempt to publish/i);
});

/**
 * The single most misleading thing the assistant could say is that a GA4 change is a draft. It is
 * not, and an archive is worse than merely live.
 */
test('write mode distinguishes GTM drafts from live GA4 changes', () => {
  const sys = buildStaticSystem({ product: 'ga4', canWrite: true, mcpInstructions: '' });
  assert.match(sys, /REVERSIBILITY IS NOT UNIFORM/);
  assert.match(sys, /GA4 has no draft/);
  assert.match(sys, /ARCHIVE cannot be undone at all/);
  assert.match(sys, /pause a tag rather than delete it/);
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
