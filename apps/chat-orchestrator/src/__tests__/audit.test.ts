/**
 * Audit trail tests.
 *
 * Three properties decide whether this is worth having:
 *
 *   1. It does not store credentials. These rows are read by support and pasted into tickets.
 *   2. It cannot be steered into someone else's conversation. The writer holds the service role
 *      key, so RLS is not there to catch a mistake in this file.
 *   3. It never throws into a turn, and never fails quietly either.
 */
import assert from 'node:assert/strict';
import { AuditRecorder, redactValue } from '../audit.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('stored arguments carry no credentials');

await test('a token nested in tool arguments is redacted', async () => {
  const out = redactValue({
    name: 'GA4 Config',
    parameter: [{ key: 'token', value: 'ya29.a0AfB_byC3xyzABCDEF1234567890abcdefGHIJ' }],
  }) as { parameter: { value: string }[] };
  assert.equal(/ya29\./.test(JSON.stringify(out)), false);
  assert.match(out.parameter[0].value, /redacted/);
});

await test('the surrounding configuration survives intact', async () => {
  // A redactor that eats real values is as useless as one that leaks: the row exists to say what
  // changed, and "[redacted]" in place of a measurement id answers nothing.
  const out = redactValue({ name: 'Purchase', measurementId: 'G-ABC123XYZ', paused: false }) as Record<
    string,
    unknown
  >;
  assert.deepEqual(out, { name: 'Purchase', measurementId: 'G-ABC123XYZ', paused: false });
});

await test('redaction leaves valid JSON, not a mangled string', async () => {
  const out = redactValue({ key: 'sk-proj-abcdefGHIJKLmnopQRSTuvwx1234567890' });
  assert.equal(typeof out, 'object');
  assert.doesNotThrow(() => JSON.stringify(out));
});

await test('a value that cannot be serialized degrades instead of throwing', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.deepEqual(redactValue(circular), { unserializable: true });
});

console.log('disabled recorder is inert');

await test('with no service role key nothing is attempted and nothing throws', async () => {
  const off = new AuditRecorder('', '');
  assert.equal(off.isEnabled(), false);
  assert.equal(await off.beginConversation('u1', { product: 'gtm' }, 'hello'), null);
  // Fire-and-forget calls must be safe to make unconditionally.
  assert.doesNotThrow(() => off.recordUserMessage(null, 'u1', 'hello'));
  assert.doesNotThrow(() =>
    off.recordToolEvent(null, 'u1', {
      toolName: 'tags_create',
      product: 'gtm',
      isWrite: true,
      isDelete: false,
      approval: 'not_required',
      args: {},
      ok: true,
      resultSummary: 'done',
      durationMs: 5,
    }),
  );
  assert.deepEqual(off.stats(), { enabled: false, failures: 0 });
});

console.log('a client cannot append to a conversation it does not own');

/** Captures requests and replies with whatever the case under test needs. */
function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = [] } = handler(String(url), init);
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

await test('an id belonging to someone else starts a fresh conversation', async () => {
  // The PATCH is scoped by user_id, so a foreign id updates zero rows. That empty result is the
  // signal, and the recorder must open a new conversation rather than trusting the id.
  const stub = stubFetch((url, init) => {
    if (init.method === 'PATCH') return { body: [] };
    return { body: [{ id: 'fresh-id' }] };
  });
  try {
    const rec = new AuditRecorder('https://x.supabase.co', 'service-key');
    const id = await rec.beginConversation('victim', { product: 'gtm' }, 'hi', 'someone-elses-id');
    assert.equal(id, 'fresh-id');

    const patch = stub.calls.find((c) => c.init.method === 'PATCH');
    assert.ok(patch, 'expected a scoped PATCH before falling back to a new conversation');
    // Both filters have to be present, or the scoping is decorative.
    assert.match(patch.url, /id=eq\.someone-elses-id/);
    assert.match(patch.url, /user_id=eq\.victim/);
  } finally {
    stub.restore();
  }
});

await test('an id the user does own is reused', async () => {
  const stub = stubFetch(() => ({ body: [{ id: 'mine' }] }));
  try {
    const rec = new AuditRecorder('https://x.supabase.co', 'service-key');
    assert.equal(await rec.beginConversation('owner', { product: 'gtm' }, 'hi', 'mine'), 'mine');
    assert.equal(stub.calls.some((c) => c.init.method === 'POST'), false);
  } finally {
    stub.restore();
  }
});

console.log('failures are survivable, and counted');

await test('an unreachable database does not fail the turn but is recorded as a failure', async () => {
  const stub = stubFetch(() => ({ status: 500, body: { message: 'boom' } }));
  try {
    const rec = new AuditRecorder('https://x.supabase.co', 'service-key');
    assert.equal(await rec.beginConversation('u1', { product: 'gtm' }, 'hi'), null);
    assert.equal(rec.stats().failures, 1);
  } finally {
    stub.restore();
  }
});

await test('the service role key is sent as a header, never in the URL', async () => {
  const stub = stubFetch(() => ({ body: [{ id: 'c1' }] }));
  try {
    const rec = new AuditRecorder('https://x.supabase.co', 'super-secret-key');
    await rec.beginConversation('u1', { product: 'gtm' }, 'hi');
    for (const call of stub.calls) {
      // A key in a query string ends up in proxy logs and browser history.
      assert.equal(call.url.includes('super-secret-key'), false);
      const headers = call.init.headers as Record<string, string>;
      assert.equal(headers.apikey, 'super-secret-key');
      assert.equal(headers.Authorization, 'Bearer super-secret-key');
    }
  } finally {
    stub.restore();
  }
});

console.log(`\n${passed} audit test(s) passed`);
