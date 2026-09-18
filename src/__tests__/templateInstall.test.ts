/**
 * Installing a template the gallery never listed, by uploading the vendor's own source.
 *
 * This is the only code path that fetches template code over the network, so the tests care as much
 * about what it REFUSES as about what it installs: an unknown repository is never fetched, and a
 * download that is not the template it claims to be is never written into a container.
 *
 * No network: `fetch` is injected.
 *
 * Run: tsx src/__tests__/templateInstall.test.ts
 */

import assert from 'assert';
import {
  fetchVerifiedTemplateSource,
  installTemplateFromSource,
  type FetchLike,
} from '../shared/gtm-template-install';

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

/** Records every URL asked for, and answers from a map. */
function stubFetch(responses: Record<string, { status?: number; body?: string }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const hit = responses[url];
    if (!hit) return { ok: false, status: 404, text: async () => '' };
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => hit.body ?? '' };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const MAIN = 'https://raw.githubusercontent.com/stape-io/data-client/main/template.tpl';
const MASTER = 'https://raw.githubusercontent.com/stape-io/data-client/master/template.tpl';

async function main(): Promise<void> {
  console.log('\ngtm-template-install:');

  await test('an UNKNOWN repository is refused without any request being made', async () => {
    const f = stubFetch({});
    await assert.rejects(
      () => fetchVerifiedTemplateSource('acme', 'evil-template', f),
      /not a known template source/,
    );
    assert.deepEqual(f.calls, [], 'nothing may be fetched for a repo that is not in the registry');
  });

  await test('the source is fetched from the vendor repo over https and verified', async () => {
    const f = stubFetch({ [MAIN]: { body: DATA_CLIENT } });
    const got = await fetchVerifiedTemplateSource('stape-io', 'data-client', f);
    assert.equal(got.url, MAIN);
    assert.equal(got.name, 'Data Client', 'created under the name the template gives itself');
    assert.equal(got.templateData, DATA_CLIENT);
    assert.deepEqual(f.calls, [MAIN], 'main answered, so master is never tried');
    assert.ok(f.calls.every((u) => u.startsWith('https://raw.githubusercontent.com/stape-io/data-client/')));
  });

  await test('a repo still on master is found by the branch fallback', async () => {
    const f = stubFetch({ [MAIN]: { status: 404 }, [MASTER]: { body: DATA_CLIENT } });
    const got = await fetchVerifiedTemplateSource('stape-io', 'data-client', f);
    assert.equal(got.url, MASTER);
    assert.deepEqual(f.calls, [MAIN, MASTER]);
  });

  await test('a download of the WRONG KIND is refused, not installed', async () => {
    const f = stubFetch({ [MAIN]: { body: tpl({ type: 'TAG', displayName: 'Data Client', containerContexts: ['SERVER'] }) } });
    await assert.rejects(
      () => fetchVerifiedTemplateSource('stape-io', 'data-client', f),
      /expected a CLIENT template, but the download declares TAG/,
    );
  });

  await test('a download that calls itself something else is refused', async () => {
    const f = stubFetch({ [MAIN]: { body: tpl({ type: 'CLIENT', displayName: 'Something Else', containerContexts: ['SERVER'] }) } });
    await assert.rejects(
      () => fetchVerifiedTemplateSource('stape-io', 'data-client', f),
      /calls itself "Something Else"/,
    );
  });

  await test('a WEB-only template is refused for a server container', async () => {
    const f = stubFetch({ [MAIN]: { body: tpl({ type: 'CLIENT', displayName: 'Data Client', containerContexts: ['WEB'] }) } });
    await assert.rejects(() => fetchVerifiedTemplateSource('stape-io', 'data-client', f), /not a SERVER container/);
  });

  await test('a reachable file that is not a GTM template at all is refused', async () => {
    const f = stubFetch({ [MAIN]: { body: '<!doctype html><html>404</html>' } });
    await assert.rejects(() => fetchVerifiedTemplateSource('stape-io', 'data-client', f), /no readable ___INFO___ block/);
  });

  await test('a bad download does NOT fall through to the next branch', async () => {
    // Reaching a file that is not what we asked for means something upstream changed. Trying master
    // next would be guessing, so the fetch stops.
    const f = stubFetch({ [MAIN]: { body: '<!doctype html>' }, [MASTER]: { body: DATA_CLIENT } });
    await assert.rejects(() => fetchVerifiedTemplateSource('stape-io', 'data-client', f), /Refused to install/);
    assert.deepEqual(f.calls, [MAIN], 'stopped at the first reachable but wrong file');
  });

  await test('when every branch is unreachable the error says what was tried', async () => {
    const f = stubFetch({});
    await assert.rejects(
      () => fetchVerifiedTemplateSource('stape-io', 'data-client', f),
      (e: Error) => /Could not download/.test(e.message) && /main\/template\.tpl -> HTTP 404/.test(e.message) && /master/.test(e.message),
    );
  });

  await test('installTemplateFromSource creates the template with its name and source', async () => {
    const f = stubFetch({ [MAIN]: { body: DATA_CLIENT } });
    const seen: Array<{ parent: string; requestBody: Record<string, unknown> }> = [];
    const api = {
      create: async (params: { parent: string; requestBody: Record<string, unknown> }) => {
        seen.push(params);
        return { data: { templateId: '25', containerId: '233785128', name: 'Data Client' } };
      },
    };
    const parent = 'accounts/6/containers/233785128/workspaces/3';
    const out = await installTemplateFromSource(api, parent, 'stape-io', 'data-client', f);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].parent, parent);
    assert.equal(seen[0].requestBody.name, 'Data Client');
    assert.equal(seen[0].requestBody.templateData, DATA_CLIENT, 'the vendor source is uploaded verbatim');
    assert.equal(seen[0].requestBody.galleryReference, undefined, 'a source install has no gallery reference');
    assert.equal(out.url, MAIN);
    // The created template is container-scoped, which is exactly the shape real Data Clients have.
    assert.deepEqual(out.template, { templateId: '25', containerId: '233785128', name: 'Data Client' });
  });

  await test('nothing is created when the download is refused', async () => {
    const f = stubFetch({ [MAIN]: { body: tpl({ type: 'TAG', displayName: 'Data Client' }) } });
    let created = 0;
    const api = { create: async () => { created += 1; return { data: {} }; } };
    await assert.rejects(() => installTemplateFromSource(api, 'accounts/1/containers/2/workspaces/3', 'stape-io', 'data-client', f));
    assert.equal(created, 0, 'verification runs BEFORE anything is written');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
