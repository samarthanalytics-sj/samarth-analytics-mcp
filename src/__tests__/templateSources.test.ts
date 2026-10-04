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
  templatePin,
  templateSourceUrls,
  TEMPLATE_SOURCES,
} from '../shared/gtm-template-sources';

/** The reviewed pins (2026-10-04, audit N31). A change here is a change to what code gets installed. */
const PINS = {
  'stape-io/data-client': {
    sourceSha: '70522367b20028dc8639776755f4ef0455b96f69',
    sha256: '78ed188c307974de345d51493b8ee822ff2001464a5c536f507b5b11e7a22d86',
  },
  'stape-io/rtb-house-tag': {
    sourceSha: '12e2a768b96bc379e9638edf2a90949e62ba0c5d',
    sha256: '5e5e0494f2b0e80b1c900b242097b7ea57d15ea8fdedfc14ac0226fff7075ec2',
  },
  'stape-io/tapfiliate-tag': {
    sourceSha: 'fa9cc0bb2ffb8bc2d80c8149d270330865389bcb',
    sha256: '15868a22014b8bc6e4d22216548fa76f1c838dfeaaf1b5505c600e03c2a1a8b8',
  },
} as const;

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

test('each not-in-gallery template is pinned to its reviewed commit and SHA-256', () => {
  for (const [k, pin] of Object.entries(PINS)) {
    const src = TEMPLATE_SOURCES[k];
    assert.equal(src?.gallery, null, `${k} is a source install`);
    assert.equal(src?.sourceSha, pin.sourceSha, `${k} commit`);
    assert.equal(src?.sha256, pin.sha256, `${k} hash`);
  }
});

test('templateSourceUrls returns exactly ONE url, at the pinned commit, never a branch', () => {
  for (const [k, pin] of Object.entries(PINS)) {
    const [owner, repo] = k.split('/');
    const urls = templateSourceUrls(owner, repo);
    assert.deepEqual(urls, [`https://raw.githubusercontent.com/${k}/${pin.sourceSha}/template.tpl`]);
    assert.ok(!urls.some((u) => /\/(main|master)\//.test(u)), 'no mutable branch');
  }
  assert.deepEqual(templateSourceUrls('STAPE-IO', 'Data-Client'), [
    `https://raw.githubusercontent.com/stape-io/data-client/${PINS['stape-io/data-client'].sourceSha}/template.tpl`,
  ], 'resolved case-insensitively, always from the registry spelling');
});

test('templateSourceUrls is empty for an entry without a pin, and for an unknown template', () => {
  // The forks are gallery imports and carry no pin: no URL, so the installer can never fetch them.
  assert.deepEqual(templateSourceUrls('stape-io', 'pirsch-tag-server'), []);
  assert.deepEqual(templateSourceUrls('mbaersch', 'umami-tag-server'), []);
  assert.deepEqual(templateSourceUrls('acme', 'evil-template'), []);
  assert.deepEqual(templateSourceUrls('stape-io', 'facebook-tag'), [], 'unexceptional = not in the registry');
  assert.equal(templatePin('stape-io', 'pirsch-tag-server'), null);
});

test('the manual steps point at the pinned commit and give the SHA-256 to check', () => {
  for (const [k, pin] of Object.entries(PINS)) {
    const [owner, repo] = k.split('/');
    const steps = manualInstallSteps(owner, repo).join('\n');
    assert.ok(steps.includes(`https://raw.githubusercontent.com/${k}/${pin.sourceSha}/template.tpl`), `${k}: pinned URL`);
    assert.ok(steps.includes(pin.sha256), `${k}: the hash to check`);
    assert.ok(/SHA-256/.test(steps), `${k}: says to check the SHA-256`);
    assert.ok(!/\/(main|master)\//.test(steps), `${k}: never a branch URL`);
  }
});

test('the manual steps for an unpinned template name no branch URL', () => {
  const steps = manualInstallSteps('stape-io', 'facebook-tag').join('\n');
  assert.ok(!/raw\.githubusercontent\.com/.test(steps), 'no raw URL without a pin');
  assert.ok(/review it/.test(steps), 'tells the user to review an unpinned file');
});

test('the not-in-gallery error names the cause and the manual steps', () => {
  const err = templateInstallError('stape-io', 'data-client');
  assert.ok(/NOT in the GTM Community Template Gallery/.test(err), err);
  assert.ok(/raw\.githubusercontent\.com\/stape-io\/data-client\/70522367b20028dc8639776755f4ef0455b96f69\/template\.tpl/.test(err), 'points at the pinned .tpl to download');
  assert.ok(err.includes(PINS['stape-io/data-client'].sha256), 'gives the hash to check');
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
    // A pin is both values or neither, and well-formed; a source install (gallery: null) must have one.
    assert.equal(v.sourceSha === undefined, v.sha256 === undefined, `${k}: sourceSha and sha256 are set together`);
    if (v.sourceSha !== undefined) assert.ok(/^[0-9a-f]{40}$/.test(v.sourceSha), `${k}: sourceSha is a full lowercase commit`);
    if (v.sha256 !== undefined) assert.ok(/^[0-9a-f]{64}$/.test(v.sha256), `${k}: sha256 is lowercase hex`);
    if (!v.gallery) assert.ok(templatePin(...(k.split('/') as [string, string])), `${k} is source-installed, so it must be pinned`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
