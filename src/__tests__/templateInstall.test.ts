/**
 * Installing a template the gallery never listed, by uploading the vendor's own source.
 *
 * This is the only code path that fetches template code over the network, so the tests care as much
 * about what it REFUSES as about what it installs: an unknown or unpinned repository is never
 * fetched, only the reviewed commit is ever requested (no branch fallback), a download whose SHA-256
 * does not match the pin is never written into a container, and a file that is not the template it
 * claims to be is refused too.
 *
 * No network: `fetch` is injected. The real pinned template.tpl files are NOT vendored here, so a
 * byte-exact happy path through the network fetch cannot be built from a synthetic body (that would
 * need a SHA-256 preimage). The accept path is covered instead by `verifyTemplateBytes` with a
 * synthetic body and its own hash, and by `sha256Hex` against known vectors.
 *
 * Run: tsx src/__tests__/templateInstall.test.ts
 */

import assert from 'assert';
import { createHash } from 'node:crypto';
import {
  fetchVerifiedTemplateSource,
  installTemplateFromSource,
  sha256Hex,
  verifyTemplateBytes,
  type FetchLike,
} from '../shared/gtm-template-install';
import { templatePin } from '../shared/gtm-template-sources';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); });
}

const tpl = (info: Record<string, unknown>): string =>
  `___INFO___\n\n${JSON.stringify(info)}\n\n___TEMPLATE_PARAMETERS___\n\n[]\n`;

const DATA_CLIENT = tpl({ type: 'CLIENT', displayName: 'Data Client', containerContexts: ['SERVER'] });

const bytesOf = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const nodeSha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/** Records every URL asked for, and answers from a map. Serves RAW BYTES, as the installer reads them. */
function stubFetch(responses: Record<string, { status?: number; body?: string }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const hit = responses[url];
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytesOf(hit.body ?? '') };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const PIN_SHA = '70522367b20028dc8639776755f4ef0455b96f69';
const PIN_HASH = '78ed188c307974de345d51493b8ee822ff2001464a5c536f507b5b11e7a22d86';
const PINNED = `https://raw.githubusercontent.com/stape-io/data-client/${PIN_SHA}/template.tpl`;
const MAIN = 'https://raw.githubusercontent.com/stape-io/data-client/main/template.tpl';
const MASTER = 'https://raw.githubusercontent.com/stape-io/data-client/master/template.tpl';

async function main(): Promise<void> {
  console.log('\ngtm-template-install:');

  // ── sha256Hex: the hashing helper, against known vectors ──

  await test('sha256Hex matches the FIPS 180-2 vectors for "" and "abc"', async () => {
    assert.equal(
      await sha256Hex(new Uint8Array(0)),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(
      await sha256Hex(bytesOf('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(
      await sha256Hex(bytesOf('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  await test('sha256Hex hashes exactly a view\'s bytes, not its whole backing buffer, and agrees with node:crypto', async () => {
    const backing = new TextEncoder().encode('xxabcxx');
    const view = backing.subarray(2, 5); // "abc"
    assert.equal(await sha256Hex(view), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(await sha256Hex(bytesOf(DATA_CLIENT)), nodeSha256(DATA_CLIENT));
  });

  // ── verifyTemplateBytes: hash first, then identity ──

  await test('a body whose SHA-256 matches the expected hash passes and is decoded verbatim', async () => {
    const v = await verifyTemplateBytes(bytesOf(DATA_CLIENT), nodeSha256(DATA_CLIENT), 'stape-io', 'data-client');
    assert.ok(v.ok, v.ok ? '' : v.reason);
    if (v.ok) {
      assert.equal(v.templateData, DATA_CLIENT);
      assert.equal(v.sha256, nodeSha256(DATA_CLIENT));
    }
  });

  await test('the expected hash is compared case-insensitively', async () => {
    const v = await verifyTemplateBytes(bytesOf(DATA_CLIENT), nodeSha256(DATA_CLIENT).toUpperCase(), 'stape-io', 'data-client');
    assert.ok(v.ok);
  });

  await test('a single changed byte is refused on the hash, with both hashes named', async () => {
    const tampered = DATA_CLIENT.replace('Data Client', 'Data Clienu');
    const v = await verifyTemplateBytes(bytesOf(tampered), nodeSha256(DATA_CLIENT), 'stape-io', 'data-client');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.match(v.reason, /SHA-256/);
      assert.ok(v.reason.includes(nodeSha256(tampered)), 'names what was downloaded');
      assert.ok(v.reason.includes(nodeSha256(DATA_CLIENT)), 'names what was pinned');
    }
  });

  await test('a missing or malformed expected hash refuses rather than skipping the check', async () => {
    for (const bad of ['', 'not-a-hash', nodeSha256(DATA_CLIENT).slice(0, 63)]) {
      const v = await verifyTemplateBytes(bytesOf(DATA_CLIENT), bad, 'stape-io', 'data-client');
      assert.equal(v.ok, false, `expected "${bad}" to refuse`);
    }
  });

  await test('a hash match is not enough: the identity checks still run after it', async () => {
    const wrongKind = tpl({ type: 'TAG', displayName: 'Data Client', containerContexts: ['SERVER'] });
    const v1 = await verifyTemplateBytes(bytesOf(wrongKind), nodeSha256(wrongKind), 'stape-io', 'data-client');
    assert.ok(!v1.ok && /expected a CLIENT template, but the download declares TAG/.test(v1.reason));

    const wrongName = tpl({ type: 'CLIENT', displayName: 'Something Else', containerContexts: ['SERVER'] });
    const v2 = await verifyTemplateBytes(bytesOf(wrongName), nodeSha256(wrongName), 'stape-io', 'data-client');
    assert.ok(!v2.ok && /calls itself "Something Else"/.test(v2.reason));

    const webOnly = tpl({ type: 'CLIENT', displayName: 'Data Client', containerContexts: ['WEB'] });
    const v3 = await verifyTemplateBytes(bytesOf(webOnly), nodeSha256(webOnly), 'stape-io', 'data-client');
    assert.ok(!v3.ok && /not a SERVER container/.test(v3.reason));

    const html = '<!doctype html><html>404</html>';
    const v4 = await verifyTemplateBytes(bytesOf(html), nodeSha256(html), 'stape-io', 'data-client');
    assert.ok(!v4.ok && /no readable ___INFO___ block/.test(v4.reason));
  });

  await test('bytes that are not valid UTF-8 are refused even when the hash matches', async () => {
    const raw = new Uint8Array([0x5f, 0x5f, 0xff, 0xfe, 0x00]);
    const v = await verifyTemplateBytes(raw, nodeSha256(raw), 'stape-io', 'data-client');
    assert.ok(!v.ok && /not valid UTF-8/.test(v.reason));
  });

  // ── fetchVerifiedTemplateSource: what is fetched, and what is refused ──

  await test('an UNKNOWN repository is refused without any request being made', async () => {
    const f = stubFetch({});
    await assert.rejects(
      () => fetchVerifiedTemplateSource('acme', 'evil-template', f),
      /not a known template source/,
    );
    assert.deepEqual(f.calls, [], 'nothing may be fetched for a repo that is not in the registry');
  });

  await test('a registry entry WITHOUT a pin is refused without any request being made', async () => {
    // The fork entries are imported from the gallery and carry no pin, so they can never be source-installed.
    const f = stubFetch({});
    await assert.rejects(
      () => fetchVerifiedTemplateSource('stape-io', 'pirsch-tag-server', f),
      /no reviewed pin/,
    );
    assert.deepEqual(f.calls, [], 'an unpinned entry never falls back to a branch');
  });

  await test('only the pinned commit URL is requested, once, over https', async () => {
    assert.equal(templatePin('stape-io', 'data-client')?.url, PINNED);
    const f = stubFetch({ [PINNED]: { body: DATA_CLIENT }, [MAIN]: { body: DATA_CLIENT }, [MASTER]: { body: DATA_CLIENT } });
    await assert.rejects(() => fetchVerifiedTemplateSource('stape-io', 'data-client', f));
    assert.deepEqual(f.calls, [PINNED], 'never main, never master');
    assert.ok(f.calls.every((u) => u.startsWith(`https://raw.githubusercontent.com/stape-io/data-client/${PIN_SHA}/`)));
  });

  await test('a body whose hash does not match the pin is refused, even one that would pass every identity check', async () => {
    // DATA_CLIENT is a well-formed Data Client: kind, name and SERVER context all match. It is still
    // not the reviewed file, and that alone is a refusal.
    const f = stubFetch({ [PINNED]: { body: DATA_CLIENT } });
    await assert.rejects(
      () => fetchVerifiedTemplateSource('stape-io', 'data-client', f),
      (e: Error) =>
        /Refused to install stape-io\/data-client/.test(e.message)
        && /SHA-256/.test(e.message)
        && e.message.includes(PIN_HASH)
        && e.message.includes(nodeSha256(DATA_CLIENT))
        && e.message.includes(PINNED)
        && /Nothing was written/.test(e.message),
    );
  });

  await test('a non-OK pinned URL fails with what was tried, and does NOT fall back to a branch', async () => {
    const f = stubFetch({ [MAIN]: { body: DATA_CLIENT }, [MASTER]: { body: DATA_CLIENT } });
    await assert.rejects(
      () => fetchVerifiedTemplateSource('stape-io', 'data-client', f),
      (e: Error) =>
        /Could not download/.test(e.message)
        && e.message.includes(`${PINNED} -> HTTP 404`)
        && e.message.includes(PIN_SHA)
        && !/\/main\/|\/master\//.test(e.message),
    );
    assert.deepEqual(f.calls, [PINNED]);
  });

  await test('a network error is reported against the pinned URL', async () => {
    const f: FetchLike = async () => { throw new Error('ECONNRESET'); };
    await assert.rejects(
      () => fetchVerifiedTemplateSource('stape-io', 'data-client', f),
      (e: Error) => /Could not download/.test(e.message) && e.message.includes(`${PINNED} -> ECONNRESET`),
    );
  });

  // ── installTemplateFromSource: nothing is uploaded unless the bytes are the reviewed file ──

  await test('a hash mismatch is refused WITHOUT any upload call', async () => {
    const f = stubFetch({ [PINNED]: { body: DATA_CLIENT } });
    let created = 0;
    const api = { create: async () => { created += 1; return { data: {} }; } };
    await assert.rejects(
      () => installTemplateFromSource(api, 'accounts/1/containers/2/workspaces/3', 'stape-io', 'data-client', f),
      /SHA-256/,
    );
    assert.equal(created, 0, 'the hash check runs BEFORE anything is written');
    assert.deepEqual(f.calls, [PINNED]);
  });

  await test('nothing is created when the pinned URL cannot be fetched', async () => {
    const f = stubFetch({});
    let created = 0;
    const api = { create: async () => { created += 1; return { data: {} }; } };
    await assert.rejects(() => installTemplateFromSource(api, 'accounts/1/containers/2/workspaces/3', 'stape-io', 'data-client', f));
    assert.equal(created, 0);
  });

  await test('nothing is created, and nothing fetched, for an unpinned or unknown template', async () => {
    let created = 0;
    const api = { create: async () => { created += 1; return { data: {} }; } };
    for (const [o, r] of [['acme', 'evil-template'], ['mbaersch', 'umami-tag-server']] as const) {
      const f = stubFetch({});
      await assert.rejects(() => installTemplateFromSource(api, 'accounts/1/containers/2/workspaces/3', o, r, f));
      assert.deepEqual(f.calls, [], `${o}/${r} must not be fetched`);
    }
    assert.equal(created, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
