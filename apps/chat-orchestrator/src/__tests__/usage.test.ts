/**
 * Usage metering tests.
 *
 * The two failure modes that matter are opposites, and both are worse than being slightly wrong
 * about a count:
 *
 *   Refusing a paying customer who is within their plan.
 *   Refusing everyone because the metering database hiccuped.
 *
 * So: an unset limit is uncapped, and an unreadable quota is allowed.
 */
import assert from 'node:assert/strict';
import { UsageMeter, quotaMessage } from '../usage.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    const { status = 200, body = null } = handler(String(url), init);
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const row = (over: Partial<Record<string, unknown>> = {}) => [{
  allowed: true, reason: null, used_chat: 3, limit_chat: 50,
  used_tokens: 1234, limit_tokens: 500000, plan_type: 'free', ...over,
}];

console.log('reading a quota');

await test('a normal account is allowed, with its figures', async () => {
  const stub = stubFetch(() => ({ body: row() }));
  try {
    const status = await new UsageMeter('https://x.supabase.co', 'k').check('u1');
    assert.deepEqual(status, {
      allowed: true, reason: null,
      usedChat: 3, limitChat: 50,
      usedTokens: 1234, limitTokens: 500000,
      planType: 'free',
    });
  } finally { stub.restore(); }
});

await test('an account over its message limit is refused, and says which limit', async () => {
  const stub = stubFetch(() => ({ body: row({ allowed: false, reason: 'chat_messages', used_chat: 50 }) }));
  try {
    const status = await new UsageMeter('https://x.supabase.co', 'k').check('u1');
    assert.equal(status?.allowed, false);
    assert.equal(status?.reason, 'chat_messages');
  } finally { stub.restore(); }
});

await test('a BIGINT token count arriving as a string becomes a number', async () => {
  // Postgres returns bigint as a string once it passes what JSON holds exactly. Left as a string it
  // would compare and format as nonsense.
  const stub = stubFetch(() => ({ body: row({ used_tokens: '9007199254740993' }) }));
  try {
    const status = await new UsageMeter('https://x.supabase.co', 'k').check('u1');
    assert.equal(typeof status?.usedTokens, 'number');
  } finally { stub.restore(); }
});

console.log('failing open');

await test('an unreachable database allows the turn rather than blocking it', async () => {
  const stub = stubFetch(() => ({ status: 500, body: { message: 'down' } }));
  try {
    const meter = new UsageMeter('https://x.supabase.co', 'k');
    // null means "no opinion", and the caller proceeds.
    assert.equal(await meter.check('u1'), null);
    assert.equal(meter.stats().failures, 1);
  } finally { stub.restore(); }
});

await test('metering switched off is inert and never throws', async () => {
  const off = new UsageMeter('', '');
  assert.equal(off.isEnabled(), false);
  assert.equal(await off.check('u1'), null);
  assert.doesNotThrow(() => off.record('u1', 500));
  assert.deepEqual(off.stats(), { enabled: false, failures: 0 });
});

console.log('recording a turn');

await test('a turn increments by one and adds its tokens', async () => {
  const stub = stubFetch(() => ({ body: null }));
  try {
    new UsageMeter('https://x.supabase.co', 'k').record('u1', 1234.6);
    await new Promise((r) => setTimeout(r, 10));
    assert.match(stub.calls[0].url, /\/rpc\/record_chat_usage$/);
    // Rounded, because the column is an integer and Postgres would reject a fraction.
    assert.deepEqual(stub.calls[0].body, { p_user_id: 'u1', p_tokens: 1235 });
  } finally { stub.restore(); }
});

await test('a negative token count cannot credit an account', async () => {
  const stub = stubFetch(() => ({ body: null }));
  try {
    new UsageMeter('https://x.supabase.co', 'k').record('u1', -5000);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((stub.calls[0].body as { p_tokens: number }).p_tokens, 0);
  } finally { stub.restore(); }
});

console.log('what the user is told');

await test('the message names the limit that was hit and when it resets', async () => {
  const base = { allowed: false, usedChat: 50, limitChat: 50, usedTokens: 10, limitTokens: 500000, planType: 'free' } as const;
  const messages = quotaMessage({ ...base, reason: 'chat_messages' });
  assert.match(messages, /50 chat messages/);
  assert.match(messages, /free plan/);
  assert.match(messages, /resets at the start of next month/);

  const tokens = quotaMessage({ ...base, reason: 'tokens' });
  assert.match(tokens, /500,000 tokens/);
  assert.equal(/chat messages/.test(tokens), false);
});

console.log(`\n${passed} usage test(s) passed`);
