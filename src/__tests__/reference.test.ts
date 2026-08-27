/**
 * The type catalogue.
 *
 * These tests guard facts that are expensive to rediscover and easy to get wrong, not the shape of
 * the object. Each one encodes a mistake that has actually been made: inventing a "ga4" tag type,
 * swapping the Lookup Table and RegEx Table codes (a published blog post gets this backwards), and
 * copying an UPPER_SNAKE trigger type out of a container export into a live API call.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TAG_TYPES, TRIGGER_TYPES, VARIABLE_TYPES, GALLERY_CATEGORIES, searchGallery, identifyTagType, identifyGalleryTemplate, NATIVE_VENDORS, NATIVE_TEMPLATES, findNativeTemplate, customTemplateOrigin } from '../tools/reference.js';
import { GALLERY_TEMPLATES } from '../tools/galleryCatalog.js';

const allTags = [...TAG_TYPES.web, ...TAG_TYPES.server, ...TAG_TYPES.legacy];
const allTriggers = [
  ...TRIGGER_TYPES.web, ...TRIGGER_TYPES.server, ...TRIGGER_TYPES.amp, ...TRIGGER_TYPES.mobile,
];
const code = (list: { code: string }[], c: string) => list.find(e => e.code === c);

test('there is no "ga4" tag type, and GA4 events are gaawe', () => {
  // The API rejects "ga4" with "vendorTemplate.key: Unknown entity type", which tells a model
  // nothing about what to use instead.
  assert.equal(code(allTags, 'ga4'), undefined);
  assert.ok(code(allTags, 'gaawe'), 'gaawe must be listed');
  assert.match(code(allTags, 'gaawe')!.name, /GA4 Event/);
});

test('the Lookup Table and RegEx Table codes are not swapped', () => {
  // Decoded from parameter keys: a Lookup Table carries input+map, a RegEx Table adds fullMatch.
  assert.equal(code(VARIABLE_TYPES, 'smm')!.name, 'Lookup Table');
  assert.equal(code(VARIABLE_TYPES, 'remm')!.name, 'RegEx Table');
});

test('jsm and j are distinct, because they are the pair most often confused', () => {
  assert.match(code(VARIABLE_TYPES, 'jsm')!.name, /Custom JavaScript/);
  assert.match(code(VARIABLE_TYPES, 'j')!.name, /JavaScript Variable/);
});

test('trigger types are camelCase, never the UPPER_SNAKE an export writes', () => {
  for (const t of allTriggers) {
    assert.doesNotMatch(t.code, /[A-Z_]{2,}/, `${t.code} looks like export casing, not API casing`);
  }
  assert.ok(code(allTriggers, 'customEvent'), 'customEvent, not CUSTOM_EVENT');
});

test('the published trigger enum is covered, including the easily forgotten ones', () => {
  for (const t of ['pageview', 'click', 'linkClick', 'formSubmission', 'customEvent', 'timer',
                   'scrollDepth', 'elementVisibility', 'historyChange', 'jsError', 'youTubeVideo',
                   'triggerGroup', 'init', 'consentInit', 'always', 'serverPageview']) {
    assert.ok(code(allTriggers, t), `missing trigger type ${t}`);
  }
});

test('the timer trigger carries its top-level-fields warning', () => {
  // Putting interval/limit in parameter[] is accepted and then renders blank in GTM.
  assert.match(code(allTriggers, 'timer')!.note ?? '', /TOP-LEVEL/i);
});

test('custom template entries tell the caller to read the type, not build it', () => {
  assert.match(code(allTags, 'cvt_<id>')!.note ?? '', /templates_list/);
});

test('bzi is the built-in LinkedIn tag and is not confused with the gallery 2.0 template', () => {
  assert.match(code(allTags, 'bzi')!.note ?? '', /2\.0 is a separate GALLERY template/i);
  const linkedin = GALLERY_CATEGORIES.find(c => c.category === 'Professional networks');
  assert.equal(linkedin?.known?.['LinkedIn Insight Tag 2.0'], 'linkedin/linkedin-gtm-community-template');
});

test('every entry has a code and a name, and no entry uses an em dash', () => {
  // Em dashes are banned across every surface that can reach a user, and this text is written to
  // be relayed verbatim.
  for (const e of [...allTags, ...allTriggers, ...VARIABLE_TYPES]) {
    assert.ok(e.code && e.name, `incomplete entry: ${JSON.stringify(e)}`);
    assert.doesNotMatch(`${e.name} ${e.note ?? ''}`, /—/, `em dash in ${e.code}`);
  }
});

test('gallery categories carry real owner/repository pairs where they are claimed', () => {
  for (const c of GALLERY_CATEGORIES) {
    assert.ok(c.examples.length > 0, `${c.category} has no examples`);
    for (const [name, repo] of Object.entries(c.known ?? {})) {
      // Either a real owner/repo pair, or an explicit note saying no import is needed.
      assert.ok(/^[\w.-]+\/[\w.-]+$/.test(repo) || /built-in/i.test(repo), `${name}: ${repo}`);
    }
  }
});

// ── gallery index ───────────────────────────────────────────────────────────

test('the gallery index is populated and every row has a name and an owner', () => {
  assert.ok(GALLERY_TEMPLATES.length > 1000, `only ${GALLERY_TEMPLATES.length} templates indexed`);
  for (const [name, owner] of GALLERY_TEMPLATES) {
    assert.ok(name && name.trim(), 'empty template name');
    // A GitHub owner, not a URL or a leftover markdown fragment.
    assert.match(owner, /^[A-Za-z0-9][A-Za-z0-9-_.]*$/, `bad owner "${owner}" for "${name}"`);
  }
});

test('search finds templates by product name and ranks the exact one first', () => {
  const clarity = searchGallery('Microsoft Clarity');
  assert.equal(clarity[0].name, 'Microsoft Clarity', 'exact name must rank first');
  // Same product, two publishers: the reason guessing an owner does not work.
  assert.ok(clarity.length > 1, 'Clarity is published by more than one owner');

  assert.equal(searchGallery('Mixpanel')[0].owner, 'mixpanel');
  assert.equal(searchGallery('LinkedIn InsightTag 2.0')[0].owner, 'linkedin');
});

test('search matches on owner too, so a vendor name finds their templates', () => {
  const hits = searchGallery('stape-io');
  assert.ok(hits.length > 0, 'searching an owner should find its templates');
  assert.ok(hits.every(h => h.owner.toLowerCase().includes('stape')));
});

test('search is capped and never returns the whole gallery', () => {
  // "a" appears in almost every name; without a cap this would dump 1000+ rows into the context.
  assert.ok(searchGallery('a').length <= 25);
});

test('an unknown product returns nothing rather than a wrong guess', () => {
  assert.deepEqual(searchGallery('definitely-not-a-real-template-xyz'), []);
  assert.deepEqual(searchGallery('   '), []);
});

// ── identifying a type seen in a container ──────────────────────────────────

test('identify names a known built-in code and reports its scope', () => {
  assert.deepEqual(identifyTagType('baut'),
    { code: 'baut', name: 'Microsoft Advertising UET', known: true, scope: 'web' });
  assert.equal(identifyTagType('sgtmgaaw').scope, 'server');
  assert.equal(identifyTagType('ua').scope, 'legacy');
});

test('identify treats any cvt_ code as resolvable, not unknown', () => {
  const r = identifyTagType('cvt_MRQN8');
  assert.equal(r.known, true);
  assert.match(r.howToResolve ?? '', /templates_list/);
});

test('an unrecognised code is reported as unknown, never guessed', () => {
  const r = identifyTagType('zzqx');
  assert.equal(r.known, false);
  assert.equal(r.name, 'Unknown tag type');
  // The guidance must actively forbid inferring a vendor from the letters.
  assert.match(r.howToResolve ?? '', /Do NOT guess/i);
});

test('identify handles empty input without throwing', () => {
  assert.equal(identifyTagType('').known, false);
});

test('a gallery template name resolves to its publisher', () => {
  assert.deepEqual(identifyGalleryTemplate('Mixpanel'), { name: 'Mixpanel', owner: 'mixpanel' });
  assert.equal(identifyGalleryTemplate('no such template at all'), null);
});

test('native templates use the wording GTM itself uses, with codes only where confirmed', () => {
  assert.ok(NATIVE_TEMPLATES.length > 60, `only ${NATIVE_TEMPLATES.length} native templates`);
  for (const t of NATIVE_TEMPLATES) {
    assert.ok(/[A-Z]/.test(t.name), `"${t.name}" looks like a code, not a template name`);
  }
  // Every code present must be one this server can already name, so the two lists cannot drift.
  const named = new Set(allTags.map(e => e.code));
  for (const t of NATIVE_TEMPLATES.filter(x => x.code)) {
    assert.ok(named.has(t.code!), `${t.name} claims code ${t.code} which TAG_TYPES does not name`);
  }
  assert.equal(NATIVE_VENDORS.length, NATIVE_TEMPLATES.length);
});

test('the confirmed native codes are the ones decoded from real containers', () => {
  const withCode = Object.fromEntries(
    NATIVE_TEMPLATES.filter(t => t.code).map(t => [t.code, t.name]));
  assert.equal(withCode['baut'], 'Microsoft Advertising Universal Event Tracking');
  assert.equal(withCode['hjtc'], 'Hotjar Tracking Code');
  assert.equal(withCode['asp'], 'AdRoll Smart Pixel');
  assert.equal(withCode['cegg'], 'Crazy Egg');
  assert.equal(withCode['bzi'], 'LinkedIn Insight');
});

test('a native template with no confirmed code reports null, not a guess', () => {
  const criteo = findNativeTemplate('Criteo OneTag');
  assert.equal(criteo?.name, 'Criteo OneTag');
  // GTM HAS it; we simply do not know the wire string. Those are different facts.
  assert.equal(criteo?.code, null);

  assert.equal(findNativeTemplate('Twitter Universal Website Tag')?.code, null);
  assert.equal(findNativeTemplate('hotjar tracking code')?.code, 'hjtc');
  assert.equal(findNativeTemplate('not a real template'), null);
});

// ── gallery vs home-grown custom templates ─────────────────────────────────

test('a gallery code and a container-authored code are told apart by shape alone', () => {
  // cvt_<galleryTemplateId> vs cvt_<containerId>_<templateId>. No lookup needed.
  assert.equal(customTemplateOrigin('cvt_MRQN8'), 'gallery');
  assert.equal(customTemplateOrigin('cvt_1234567_12'), 'local');

  const gallery = identifyTagType('cvt_MRQN8');
  assert.equal(gallery.origin, 'gallery');
  assert.equal(gallery.name, 'Community Gallery template');

  const local = identifyTagType('cvt_1234567_12');
  assert.equal(local.origin, 'local');
  assert.match(local.name, /authored in this container/i);
  // An in-house template has no publisher, and saying so prevents a pointless hunt.
  assert.match(local.howToResolve ?? '', /no publisher/i);
});

test('an ambiguous cvt_ code falls back to gallery, never to home-grown', () => {
  // Misreading a vendor template as home-grown sends someone looking for source that does not
  // exist, so the non-numeric shapes must not be claimed as local.
  assert.equal(customTemplateOrigin('cvt_ABC_DEF'), 'gallery');
  assert.equal(customTemplateOrigin('cvt_5RM3Q'), 'gallery');
  assert.equal(customTemplateOrigin('cvt_1234567_12_3'), 'gallery');
});

test('both kinds still resolve through the container, not the snapshot', () => {
  for (const c of ['cvt_MRQN8', 'cvt_1234567_12']) {
    assert.match(identifyTagType(c).howToResolve ?? '', /templates_list/);
    assert.equal(identifyTagType(c).known, true);
  }
});
