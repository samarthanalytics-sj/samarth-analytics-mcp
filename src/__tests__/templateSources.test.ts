/**
 * Where a GTM custom template comes from, and how an installed one is recognised.
 *
 * These are the facts that made "failed: stape data client" unfixable from the outside: a template
 * that is not in the gallery cannot be imported, a stape-io fork's gallery entry belongs to someone
 * else, and a hand-installed template carries no galleryReference at all - so the old
 * owner/repository-only lookup never found the copy the user had just installed by hand.
 *
 * Run: tsx src/__tests__/templateSources.test.ts
 */

import assert from 'assert';
import {
  parseTemplateInfo,
  resolveTemplateSource,
  galleryCoordinatesFor,
  matchInstalledTemplate,
  manualInstallSteps,
  templateInstallError,
  TEMPLATE_SOURCES,
} from '../shared/gtm-template-sources';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

console.log('\ngtm-template-sources:');

const tpl = (info: Record<string, unknown>): string =>
  `___INFO___\n\n${JSON.stringify(info, null, 2)}\n\n\n___TEMPLATE_PARAMETERS___\n\n[]\n`;

test('parseTemplateInfo reads the INFO block, including a brand blob full of braces and quotes', () => {
  const src = tpl({
    type: 'CLIENT',
    displayName: 'Data Client',
    brand: { id: 'brand_dummy', displayName: 'Stape', thumbnail: 'data:image/png;base64,AAA{}"' },
    containerContexts: ['SERVER'],
  });
  const info = parseTemplateInfo(src);
  assert.equal(info?.kind, 'CLIENT');
  assert.equal(info?.displayName, 'Data Client');
  assert.deepEqual(info?.containerContexts, ['SERVER']);
});

test('parseTemplateInfo returns null for a native template with no templateData', () => {
  assert.equal(parseTemplateInfo(''), null);
  assert.equal(parseTemplateInfo(null), null);
  assert.equal(parseTemplateInfo('___SANDBOXED_JS___\nconst x = 1;'), null, 'no INFO block');
  assert.equal(parseTemplateInfo('___INFO___\n{ not json'), null, 'unterminated');
});

test('a template that is NOT in the gallery yields no import coordinates', () => {
  for (const [owner, repo] of [['stape-io', 'data-client'], ['stape-io', 'rtb-house-tag'], ['stape-io', 'tapfiliate-tag']] as const) {
    assert.equal(galleryCoordinatesFor(owner, repo), null, `${owner}/${repo} must never be imported`);
    assert.equal(resolveTemplateSource(owner, repo)?.gallery, null);
  }
});

test('a stape-io FORK imports under the upstream publisher, not stape-io', () => {
  assert.deepEqual(galleryCoordinatesFor('stape-io', 'pirsch-tag-server'), { owner: 'mbaersch', repository: 'pirsch-tag-server' });
  assert.deepEqual(galleryCoordinatesFor('stape-io', 'umami-tag-server'), { owner: 'mbaersch', repository: 'umami-tag-server' });
  assert.deepEqual(galleryCoordinatesFor('stape-io', 'plausible-analytics-tag-server'), { owner: 'mbaersch', repository: 'plausible-analytics-tag-server' });
  assert.deepEqual(galleryCoordinatesFor('stape-io', 'snowplow-gtm-server-side-tag'), { owner: 'snowplow', repository: 'snowplow-gtm-server-side-tag' });
});

test('an unexceptional template passes through unchanged', () => {
  assert.deepEqual(galleryCoordinatesFor('stape-io', 'facebook-tag'), { owner: 'stape-io', repository: 'facebook-tag' });
  assert.equal(resolveTemplateSource('stape-io', 'facebook-tag'), null, 'no entry needed when the coordinates just work');
});

test('coordinates resolve case-insensitively', () => {
  assert.equal(galleryCoordinatesFor('STAPE-IO', 'Data-Client'), null);
  assert.deepEqual(galleryCoordinatesFor('Stape-IO', 'Pirsch-Tag-Server'), { owner: 'mbaersch', repository: 'pirsch-tag-server' });
});

test('matchInstalledTemplate finds a gallery-installed template by its reference', () => {
  const list = [
    { name: 'Other', galleryReference: { owner: 'stape-io', repository: 'facebook-tag' } },
    { name: 'TikTok', galleryReference: { owner: 'stape-io', repository: 'tiktok-tag' } },
  ];
  assert.equal(matchInstalledTemplate(list, 'stape-io', 'tiktok-tag')?.name, 'TikTok');
  assert.equal(matchInstalledTemplate(list, 'stape-io', 'quora-tag'), undefined);
});

test('a HAND-INSTALLED Data Client is found by its own INFO block, with no galleryReference', () => {
  const list = [
    { name: 'GA4', galleryReference: null, templateData: '' },
    // Renamed by the user, so only the INFO block still identifies it.
    { name: 'my data client v2', galleryReference: null, templateData: tpl({ type: 'CLIENT', displayName: 'Data Client', containerContexts: ['SERVER'] }) },
  ];
  const hit = matchInstalledTemplate(list, 'stape-io', 'data-client');
  assert.equal(hit?.name, 'my data client v2', 'this is exactly the copy the old lookup missed');
});

test('a hand-installed template is also found by the default name it lands with', () => {
  const list = [{ name: 'Data Client', galleryReference: null, templateData: '' }];
  assert.equal(matchInstalledTemplate(list, 'stape-io', 'data-client')?.name, 'Data Client');
});

test('a fork is matched when it was installed under the upstream publisher', () => {
  const list = [{ name: 'Umami', galleryReference: { owner: 'mbaersch', repository: 'umami-tag-server' } }];
  assert.equal(matchInstalledTemplate(list, 'stape-io', 'umami-tag-server')?.name, 'Umami', 'asked for the fork, installed from the publisher');
});

test('an UNKNOWN repo is never matched by a name guess', () => {
  const list = [{ name: 'Some Tag', galleryReference: null, templateData: tpl({ type: 'TAG', displayName: 'Some Tag' }) }];
  assert.equal(matchInstalledTemplate(list, 'acme', 'some-tag'), undefined, 'no registry entry means no fuzzy match');
});

test('the not-in-gallery error names the cause and the manual steps', () => {
  const err = templateInstallError('stape-io', 'data-client');
  assert.ok(/NOT in the GTM Community Template Gallery/.test(err), err);
  assert.ok(/raw\.githubusercontent\.com\/stape-io\/data-client/.test(err), 'points at the .tpl to download');
  assert.ok(/Client Templates/.test(err), 'a CLIENT installs under Client Templates, not Tag Templates');
  assert.ok(/Re-run this step/.test(err), 'tells the user the tool will then continue');
});

test('an import failure on a LISTED template still explains itself and carries the API cause', () => {
  const err = templateInstallError('stape-io', 'facebook-tag', 'Request had insufficient authentication scopes.');
  assert.ok(/Could not install/.test(err), err);
  assert.ok(/insufficient authentication scopes/.test(err), 'the real API error is preserved');
  assert.ok(/Tag Templates/.test(err), 'a TAG installs under Tag Templates');
});

test('manual steps for a TAG and a CLIENT differ only where GTM differs', () => {
  assert.ok(manualInstallSteps('stape-io', 'tapfiliate-tag').some((s) => /Tag Templates/.test(s)));
  assert.ok(manualInstallSteps('stape-io', 'data-client').some((s) => /Client Templates/.test(s)));
});

test('every registry entry is internally consistent', () => {
  for (const [k, v] of Object.entries(TEMPLATE_SOURCES)) {
    assert.ok(/^[a-z0-9-]+\/[a-z0-9-]+$/.test(k), `key ${k} must be lowercase owner/repo`);
    assert.ok(v.displayName.trim().length > 0, `${k} needs a displayName to match a manual install`);
    assert.ok(/^[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/.test(v.sourceRepo), `${k} sourceRepo`);
    assert.ok(v.note.trim().length > 0, `${k} must say why it is an exception`);
    assert.ok(!v.note.includes('—'), `${k} note must not use an em dash`);
    if (v.gallery) assert.notEqual(v.gallery.owner.toLowerCase(), 'stape-io', `${k} is a fork entry, so the publisher is not stape-io`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
